// Private user-data streams -> ledger + bus.
//
// - Futures: listenKey over the routed `/private/ws?listenKey=` path (legacy `/ws/<key>` fallback),
//   keepalive every 30 min, key recreated on every (re)connect so `listenKeyExpired` and socket
//   drops converge on the same path. `onReconnect` fires after each reconnect so the caller can
//   run REST recovery for anything missed while the socket was down.
// - Spot: WS-API `userDataStream.subscribe.signature` (HMAC over sorted `apiKey`+`timestamp`);
//   no listenKey exists on Spot testnet.
//
// Both map order reports (`ORDER_TRADE_UPDATE.o` / `executionReport`) onto `exec.order` and, when
// the report carries a last-filled qty, `exec.fill` — emitted only when `ledger.insertFill`
// returns non-null (UNIQUE(venue, trade_id) dedupes against REST recovery).

import { bus as globalBus, type Bus } from "../../core/bus.ts";
import { nowNs } from "../../core/clock.ts";
import type { Ledger } from "../../core/ledger.ts";
import { logger } from "../../core/log.ts";
import type { Fill, Order, OrderStatus, Venue } from "../../core/types.ts";
import type { FuturesRest } from "./rest-futures.ts";
import type { SpotRest } from "./rest-spot.ts";
import { signWsApiParams } from "./sign.ts";
import { BinanceWs, privateStreamUrl, realClock, type Clock, type Frame, type WsFactory } from "./ws.ts";

const KEEPALIVE_MS = 30 * 60 * 1000;
const ORDER_STATUSES: Record<string, true> = { NEW: true, PARTIALLY_FILLED: true, FILLED: true, CANCELED: true, REJECTED: true, EXPIRED: true };

// ---- ledger order lookup ----------------------------------------------------

interface OrderRow {
  id: number;
  intent_id: number;
  venue: Venue;
  client_id: string;
  ext_id: string | null;
  status: OrderStatus;
  t_sent_ns: number;
  t_ack_ns: number | null;
  latency_ms: number | null;
  json: string | null;
}

const ORDER_COLS = "id, intent_id, venue, client_id, ext_id, status, t_sent_ns, t_ack_ns, latency_ms, json";

function rowToOrder(r: OrderRow): Order {
  const extra = (r.json === null ? {} : JSON.parse(r.json)) as { symbol?: string; side?: "BUY" | "SELL"; qty?: number; price?: number | null };
  const o: Order = {
    id: r.id,
    intentId: r.intent_id,
    venue: r.venue,
    symbol: extra.symbol ?? "",
    side: extra.side ?? "BUY",
    qty: extra.qty ?? 0,
    clientId: r.client_id,
    status: r.status,
    tSentNs: r.t_sent_ns,
  };
  if (extra.price !== undefined && extra.price !== null) o.price = extra.price;
  if (r.ext_id !== null) o.extId = r.ext_id;
  if (r.t_ack_ns !== null) o.tAckNs = r.t_ack_ns;
  if (r.latency_ms !== null) o.latencyMs = r.latency_ms;
  return o;
}

/** `orders` row by `client_id` (UNIQUE); null when the id was never issued by this process. */
export function orderByClientId(ledger: Ledger, clientId: string): Order | null {
  const r = ledger.db.query<OrderRow, [string]>(`SELECT ${ORDER_COLS} FROM orders WHERE client_id = ?`).get(clientId);
  return r === null ? null : rowToOrder(r);
}


/** Exchange identities are scoped by venue and symbol. */
export function orderBySymbolExtId(ledger: Ledger, venue: Venue, symbol: string, extId: string): Order | null {
  const r = ledger.db.query<OrderRow, [Venue, string, string]>(
    `SELECT ${ORDER_COLS} FROM orders WHERE venue = ? AND ext_id = ? AND json_extract(json, '$.symbol') = ? ORDER BY id DESC`,
  ).get(venue, extId, symbol);
  return r === null ? null : rowToOrder(r);
}

// ---- report mapping ---------------------------------------------------------

/** Field letters shared by futures `ORDER_TRADE_UPDATE.o` and spot `executionReport`. */
interface OrderReport {
  s: string;
  c: string;
  C?: string;
  S: "BUY" | "SELL";
  X: string;
  i: number;
  l?: string;
  L?: string;
  n?: string | null;
  N?: string | null;
  t?: number;
  z?: string;
  [k: string]: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

/**
 * Applies one order report: status -> ledger + `exec.order`; last fill (`l > 0`) -> `insertFill`
 * and `exec.fill` when newly recorded. Unknown client ids are logged and skipped.
 */
export function applyOrderReport(ledger: Ledger, bus: Bus, venue: Venue, rep: OrderReport, log = logger(`userdata.${venue}`)): boolean {
  const clientId = str(rep.c) ?? "";
  let order = clientId.length > 0 ? orderByClientId(ledger, clientId) : null;
  if (order === null && typeof rep.C === "string" && rep.C.length > 0) order = orderByClientId(ledger, rep.C);
  if (order === null) {
    log.warn("report for unknown client id; skipped", { venue, symbol: rep.s, clientId, status: rep.X });
    return false;
  }
  const extId = str(rep.i);
  const status = ORDER_STATUSES[rep.X] === true ? (rep.X as OrderStatus) : null;
  if (status !== null && (status !== order.status || (extId !== undefined && order.extId !== extId))) {
    ledger.updateOrderStatus(order.id, status, rep.z === undefined ? undefined : JSON.stringify({ executedQty: Number(rep.z) }));
    if (extId !== undefined && order.extId !== extId) ledger.db.query("UPDATE orders SET ext_id = ? WHERE id = ?").run(extId, order.id);
    order.status = status;
  }
  if (rep.z !== undefined) ledger.db.query("UPDATE orders SET json = json_set(json, '$.executedQty', ?) WHERE id = ?").run(Number(rep.z), order.id);
  if (extId !== undefined) order.extId = extId;
  bus.emit("exec.order", order);

  const lastQty = Number(rep.l ?? 0);
  if (!(lastQty > 0)) return true;
  const tradeId = str(rep.t);
  if (tradeId === undefined) {
    log.warn("fill report without trade id; skipped", { venue, orderId: order.id });
    return true;
  }
  const fill: Fill = {
    orderId: order.id,
    venue,
    symbol: rep.s,
    tradeId,
    side: rep.S,
    price: Number(rep.L ?? 0),
    qty: lastQty,
    fee: Number(rep.n ?? 0),
    feeAsset: rep.N ?? "",
    tsNs: nowNs(),
  };
  if (ledger.insertFill(fill) !== null) bus.emit("exec.fill", fill);
  return true;
}

// ---- futures ----------------------------------------------------------------

export interface FuturesUserDataOptions {
  rest: FuturesRest;
  ledger: Ledger;
  /** e.g. `wss://demo-fstream.binance.com`. */
  baseWs: string;
  /** Use the routed `/private` path (boot probe result); false -> legacy `/ws/<listenKey>`. */
  routed?: boolean;
  wsFactory?: WsFactory;
  clock?: Clock;
  bus?: Bus;
  /** Called after every reconnect (socket drop or listenKeyExpired); run REST recovery here. */
  onReconnect?: () => void | Promise<void>;
  keepaliveMs?: number;
}

export class FuturesUserData {
  readonly ws: BinanceWs;
  private listenKey: string | null = null;
  private keepalive: unknown = null;
  private readonly log = logger("userdata.futures");
  private readonly bus: Bus;
  private readonly clock: Clock;

  constructor(private readonly opts: FuturesUserDataOptions) {
    this.bus = opts.bus ?? globalBus;
    this.clock = opts.clock ?? realClock;
    this.ws = new BinanceWs({
      name: "futures.user",
      // Fresh key on every connect: expired/dropped keys converge on one path.
      url: async () => {
        this.listenKey = await opts.rest.listenKeyCreate();
        return privateStreamUrl(opts.baseWs, this.listenKey, opts.routed ?? true);
      },
      onFrame: (f) => this.onFrame(f),
      onOpen: (reconnect) => {
        if (reconnect) void this.fireReconnect();
      },
      wsFactory: opts.wsFactory,
      clock: this.clock,
    });
  }

  get connected(): boolean {
    return this.ws.connected;
  }

  start(): void {
    this.ws.start();
    if (this.keepalive === null) {
      this.keepalive = this.clock.setInterval(() => {
        const key = this.listenKey;
        if (key === null) return;
        this.opts.rest.listenKeyKeepalive(key).catch((err: unknown) => {
          this.log.warn("listenKey keepalive failed; reconnecting", { error: err instanceof Error ? err.message : String(err) });
          this.ws.reconnect("keepalive failed");
        });
      }, this.opts.keepaliveMs ?? KEEPALIVE_MS);
    }
  }

  stop(): void {
    if (this.keepalive !== null) {
      this.clock.clearInterval(this.keepalive);
      this.keepalive = null;
    }
    this.ws.stop();
    const key = this.listenKey;
    this.listenKey = null;
    if (key !== null) {
      this.opts.rest.listenKeyClose(key).catch(() => {
        // best effort; the key expires on its own
      });
    }
  }

  private async fireReconnect(): Promise<void> {
    try {
      await this.opts.onReconnect?.();
    } catch (err) {
      this.log.error("onReconnect hook failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private onFrame(f: Frame): void {
    switch (f.e) {
      case "ORDER_TRADE_UPDATE":
        applyOrderReport(this.opts.ledger, this.bus, "futures", f.data.o as OrderReport, this.log);
        return;
      case "listenKeyExpired":
        this.ws.reconnect("listenKeyExpired");
        return;
      default:
        return;
    }
  }
}

// ---- spot -------------------------------------------------------------------

export interface SpotUserDataOptions {
  rest: SpotRest;
  key: string;
  secret: string;
  ledger: Ledger;
  /** e.g. `wss://ws-api.testnet.binance.vision/ws-api/v3`. */
  wsApiUrl: string;
  wsFactory?: WsFactory;
  clock?: Clock;
  bus?: Bus;
  onReconnect?: () => void | Promise<void>;
}

export class SpotUserData {
  readonly ws: BinanceWs;
  private reqId = 0;
  private subscribeId: number | null = null;
  private readonly log = logger("userdata.spot");
  private readonly bus: Bus;
  private readonly clock: Clock;

  constructor(private readonly opts: SpotUserDataOptions) {
    this.bus = opts.bus ?? globalBus;
    this.clock = opts.clock ?? realClock;
    this.ws = new BinanceWs({
      name: "spot.user",
      url: opts.wsApiUrl,
      onFrame: (f) => this.onFrame(f),
      onOpen: (reconnect) => {
        this.subscribe();
        if (reconnect) void this.fireReconnect();
      },
      wsFactory: opts.wsFactory,
      clock: this.clock,
    });
  }

  get connected(): boolean {
    return this.ws.connected;
  }

  start(): void {
    this.ws.start();
  }

  stop(): void {
    this.ws.stop();
  }

  /** `userDataStream.subscribe.signature`: HMAC over sorted `apiKey`+`timestamp` (any key type). */
  private subscribe(): void {
    const timestamp = Math.round(this.clock.nowMs() + this.opts.rest.http.timeSync.offsetFor(this.opts.rest.baseUrl));
    const params = { apiKey: this.opts.key, timestamp };
    this.subscribeId = ++this.reqId;
    this.ws.send({
      id: this.subscribeId,
      method: "userDataStream.subscribe.signature",
      params: { ...params, signature: signWsApiParams(params, this.opts.secret) },
    });
  }

  private async fireReconnect(): Promise<void> {
    try {
      await this.opts.onReconnect?.();
    } catch (err) {
      this.log.error("onReconnect hook failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private onFrame(f: Frame): void {
    const d = f.data;
    // Subscribed events arrive wrapped: `{subscriptionId, event: {e: "executionReport", ...}}`.
    const ev = f.e !== null ? d : typeof d.event === "object" && d.event !== null ? (d.event as Record<string, unknown>) : null;
    if (ev !== null) {
      if (ev.e === "executionReport") applyOrderReport(this.opts.ledger, this.bus, "spot", ev as unknown as OrderReport, this.log);
      return;
    }
    if (d.id === this.subscribeId) {
      const status = typeof d.status === "number" ? d.status : 0;
      if (status === 200) this.log.info("user data subscribed", { subscriptionId: (d.result as { subscriptionId?: number } | undefined)?.subscriptionId });
      else {
        this.log.error("user data subscribe rejected; reconnecting", { status, error: d.error });
        this.ws.reconnect("subscribe rejected");
      }
    }
  }
}
