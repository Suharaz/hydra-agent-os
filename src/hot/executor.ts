// Venue executor. Every intent passes the kernel, then each leg is written to `orders` (PENDING)
// before its REST send and acked with latency_ms = (t_ack - t_signal)/1e6. Legs run sequentially
// and are all-or-nothing: a failing leg rolls back every filled leg on its own venue (futures
// reduce-only MARKET, spot MARKET opposite, DEX reverse swap or residue); a failed rollback kills.
// TP/SL: futures reduce-only TAKE_PROFIT_MARKET / STOP_MARKET; spot a `feed.trade` watcher that
// MARKET-closes on the first cross (recovery-boot rebuilds it). 429/418 pauses submits for
// Retry-After; kill.ts talks to REST directly and is never paused.

import { existsSync } from "node:fs";
import { bus as defaultBus, type Bus } from "../core/bus.ts";
import { nowNs, wallMs } from "../core/clock.ts";
import { type Config, watchEngines } from "../core/config.ts";
import type { Env } from "../core/env.ts";
import type { Ledger } from "../core/ledger.ts";
import { effective, type EffectiveLimits } from "../core/limits.ts";
import { logger } from "../core/log.ts";
import { readBudgets, readKillLock, readLimits } from "../core/state.ts";
import type { Budgets, EngineId, Fill, Intent, Order, OrderStatus, Side, Venue, Veto } from "../core/types.ts";
import { BinanceError } from "../venues/binance/http.ts";
import { FuturesRest, type FuturesOrderParams, type FuturesOrderRow } from "../venues/binance/rest-futures.ts";
import { SpotRest, type SpotOrderParams, type SpotOrderRow } from "../venues/binance/rest-spot.ts";
import { SymbolFilters, type SymbolFilter } from "../venues/binance/symbols.ts";
import { urlMatrix } from "../venues/binance/urls.ts";
import { WeightGuard } from "../venues/binance/weight.ts";
import type { OnchainAdapter } from "../venues/onchain/adapter.ts";
import { BawAdapter } from "../venues/onchain/baw-adapter.ts";
import { PaperAdapter } from "../venues/onchain/paper-adapter.ts";
import type { Module } from "../main.ts";
import { AuditCache } from "./audit-cache.ts";
import { Guardian } from "./guardian.ts";
import { type FeedView, Kernel } from "./kernel.ts";
import { kill, type KillDeps, type KillResult } from "./kill.ts";
import { Positions } from "./positions.ts";
import { recoverBoot } from "./recovery-boot.ts";
import { recoverFills } from "../venues/binance/recovery.ts";

const log = logger("executor");
/** limits.json / budgets.json re-read cadence for the kernel getters. */
const STATE_TTL_MS = 250;

export interface BookView {
  synced: boolean;
  ageMs: number;
  bestBid: number;
  bestAsk: number;
  mid: number;
}

export interface ExecutorDeps {
  kernel: {
    evaluate(intent: Intent): Veto | null;
    admit?(intent: Intent): Veto | null;
    /** Release a leg only if it never reached a durable order. */
    release?(intentId: string): void;
    /** S08: In-process kill latch; set to true on system.kill. */
    killedInProcess?: boolean;
  };
  futuresRest: FuturesRest | null;
  spotRest: SpotRest | null;
  onchain: OnchainAdapter | null;
  ledger: Ledger;
  positions: Positions | null;
  feed: { book(symbol: string): BookView | null } | null;
  symbols: (venue: Venue, symbol: string) => Pick<SymbolFilter, "tickSize" | "stepSize"> | null;
  stateDir: string;
  env: Env;
  clock?: { nowNs(): number; setTimeout(fn: () => void, ms: number): unknown };
  bus?: Bus;
  /** Invoked with `rollback_failed` when a rollback leg cannot be unwound. */
  killFn?: (reason: string) => Promise<unknown>;
  /**
   * Synthesize `exec.fill` from the REST ack (executedQty/avgPrice). Off when a user-data stream
   * owns fills (production); tests and the CLI without a stream turn it on. DEX and paper fills
   * are always synthesized here since no stream exists for them.
   */
  fillsFromAck?: boolean;
}

export type SubmitResult =
  | { ok: true; orders: Order[]; fills: Fill[] }
  | { ok: false; reason: "veto"; veto: Veto; orders: Order[] }
  | { ok: false; reason: "paused" | "error"; error: string; orders: Order[]; rolledBack: boolean; residue: Array<{ venue: Venue; symbol: string; qty: number }> };

interface Leg {
  intent: Intent;
  intentRow: number;
  order: Order;
  /** Signed executed qty (+ long / - short) known from the ack. */
  filledQty: number;
  avgPrice: number;
  extId: string | null;
  status: OrderStatus;
}

class UncertainLeg extends Error {
  constructor(readonly leg: Leg, cause: unknown) {
    super(`submission unresolved: ${errText(cause)}`);
  }
}

interface SpotWatcher {
  orderId: number;
  engine: EngineId;
  symbol: string;
  side: Side;
  qty: number;
  tp: number | undefined;
  sl: number | undefined;
  extId: string | undefined;
  firing: boolean;
  /** Failed close attempts so far; each retry needs a fresh client id (orders.client_id is UNIQUE). */
  attempts?: number;
}

const PAPER_FEE_BPS: Record<Venue, number> = { futures: 4, spot: 10, dex: 30 };
const MAX_CLIENT_ID = 36;

function mapStatus(s: string): OrderStatus {
  switch (s) {
    case "NEW":
    case "PARTIALLY_FILLED":
    case "FILLED":
    case "CANCELED":
    case "REJECTED":
    case "EXPIRED":
      return s;
    case "EXPIRED_IN_MATCH":
      return "EXPIRED";
    default:
      return "NEW";
  }
}

function opposite(side: Side): Side {
  return side === "BUY" ? "SELL" : "BUY";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function clientId(engine: EngineId, intentId: string, suffix = ""): string {
  const id = `hydra-${engine}-${intentId}${suffix}`;
  return id.length <= MAX_CLIENT_ID ? id : `hydra-${engine}-${intentId.slice(0, Math.max(1, MAX_CLIENT_ID - 7 - engine.length - suffix.length))}${suffix}`;
}

export class Executor {
  paused = false;
  private pauseUntilMs = 0;
  private readonly d: ExecutorDeps;
  private readonly bus: Bus;
  private readonly now: () => number;
  private readonly watchers = new Map<string, SpotWatcher[]>();
  private disposers: Array<() => void> = [];
  private seq = 0;
  private killed = false;
  private readonly entries = new Set<Promise<Leg>>();

  constructor(deps: ExecutorDeps) {
    this.d = deps;
    this.bus = deps.bus ?? defaultBus;
    const clock = deps.clock;
    this.now = clock === undefined ? nowNs : () => clock.nowNs();
  }

  start(): void {
    this.disposers.push(
      this.bus.on("feed.trade", (t) => {
        if (t.venue === "spot") this.onSpotTrade(t.symbol, t.price);
      }),
      this.bus.on("system.kill", () => { this.killed = true; }),
      this.bus.on("system.kill.cleared", () => { if (readKillLock(this.d.stateDir) === null) this.killed = false; }),
    );
  }

  stop(): void {
    for (const d of this.disposers.splice(0)) d();
  }

  async awaitEntries(): Promise<void> {
    await Promise.allSettled(this.entries);
  }

  /** Spot TP/SL watchers keyed by symbol (recovery-boot / tests). */
  watcherCount(symbol?: string): number {
    if (symbol !== undefined) return this.watchers.get(symbol)?.length ?? 0;
    let n = 0;
    for (const list of this.watchers.values()) n += list.length;
    return n;
  }

  // ---- submit -------------------------------------------------------------

  async submit(intent: Intent): Promise<SubmitResult> {
    const legs = intent.legs !== undefined && intent.legs.length > 0 ? intent.legs : [intent];
    if (this.paused && legs.some((l) => !l.paper && l.venue !== "dex")) {
      return { ok: false, reason: "paused", error: `executor paused until ${new Date(this.pauseUntilMs).toISOString()}`, orders: [], rolledBack: false, residue: [] };
    }

    const veto = this.d.kernel.admit !== undefined ? this.d.kernel.admit(intent) : this.d.kernel.evaluate(intent);
    if (veto !== null) return { ok: false, reason: "veto", veto, orders: [] };

    const done: Leg[] = [];
    const fills: Fill[] = [];
    for (const legIntent of legs) {
      // S08: a latched kill blocks every later leg of an already-admitted intent, paper included
      // (paper exposure still counts against the paper book and must not grow after a kill).
      if (this.killed || this.d.kernel.killedInProcess || readKillLock(this.d.stateDir) !== null) {
        for (const pending of legs) this.d.kernel.release?.(pending.id);
        return { ok: false, reason: "error", error: "kill barrier latched after admission", orders: done.map((l) => l.order), rolledBack: false, residue: done.map((l) => ({ venue: l.intent.venue, symbol: l.intent.symbol, qty: l.filledQty })) };
      }
      let leg: Leg;
      try {
        if (legIntent.paper) leg = this.paperLeg(legIntent, fills);
        else {
          const pending = this.liveLeg(legIntent, fills);
          this.entries.add(pending);
          try { leg = await pending; }
          finally { this.entries.delete(pending); }
        }
      } catch (err) {
        const detail = errText(err);
        log.error("leg failed", { intent: legIntent.id, venue: legIntent.venue, symbol: legIntent.symbol, error: detail });
        const rb = await this.rollback(intent, done);
        if (err instanceof UncertainLeg) {
          rb.ok = false;
          rb.residue.push({ venue: legIntent.venue, symbol: legIntent.symbol, qty: legIntent.qty * (legIntent.side === "BUY" ? 1 : -1) });
        }
        for (const pending of legs) this.d.kernel.release?.(pending.id);
        return { ok: false, reason: "error", error: detail, orders: [...done.map((l) => l.order), ...(err instanceof UncertainLeg ? [err.leg.order] : [])], rolledBack: rb.ok, residue: rb.residue };
      }
      done.push(leg);
    }

    for (const leg of done) await this.protect(leg);
    return { ok: true, orders: done.map((l) => l.order), fills };
  }

  // ---- legs ---------------------------------------------------------------

  private newOrder(intent: Intent, intentRow: number, cid: string, side: Side, qty: number, price: number | undefined): Order {
    const o: Order = { id: 0, intentId: intentRow, venue: intent.venue, symbol: intent.symbol, side, qty, clientId: cid, status: "PENDING", tSentNs: this.now() };
    if (price !== undefined) o.price = price;
    o.id = this.d.ledger.insertOrderPending(o);
    this.bus.emit("exec.order", o);
    return o;
  }

  private ack(o: Order, tSignalNs: number, extId: string | null, status: OrderStatus, json?: string): void {
    const tAck = this.now();
    o.tAckNs = tAck;
    o.latencyMs = (tAck - tSignalNs) / 1e6;
    o.status = status;
    if (extId !== null) o.extId = extId;
    this.d.ledger.updateOrderAck(o.id, { extId, status, tAckNs: tAck, latencyMs: o.latencyMs, json });
    this.bus.emit("exec.order", o);
  }

  private recordFill(o: Order, tradeId: string, price: number, qty: number, fee: number, feeAsset: string, fills: Fill[]): void {
    const f: Fill = { orderId: o.id, venue: o.venue, symbol: o.symbol, tradeId, side: o.side, price, qty, fee, feeAsset, tsNs: this.now() };
    if (this.d.ledger.insertFill(f) === null) return;
    fills.push(f);
    this.bus.emit("exec.fill", f);
  }

  private paperPrice(intent: Intent): number {
    if (intent.type === "LIMIT" && intent.price !== undefined) return intent.price;
    const book = this.d.feed?.book(intent.symbol) ?? null;
    if (book !== null && book.mid > 0) return book.mid;
    const mark = this.d.positions?.mark(intent.venue, intent.symbol) ?? 0;
    if (mark > 0) return mark;
    if (intent.price !== undefined && intent.price > 0) return intent.price;
    throw new Error(`paper fill: no price for ${intent.venue}:${intent.symbol}`);
  }

  private paperLeg(intent: Intent, fills: Fill[]): Leg {
    const intentRow = this.d.ledger.insertIntent(intent);
    const price = this.round(intent.venue, intent.symbol, "price", this.paperPrice(intent));
    const qty = this.round(intent.venue, intent.symbol, "qty", intent.qty);
    const o = this.newOrder(intent, intentRow, clientId(intent.engine, intent.id), intent.side, qty, price);
    const tAck = this.now();
    o.tAckNs = tAck;
    o.latencyMs = (tAck - intent.tSignalNs) / 1e6;
    o.status = "PAPER";
    this.d.ledger.updateOrderAck(o.id, { extId: null, status: "PAPER", tAckNs: tAck, latencyMs: o.latencyMs });
    this.bus.emit("exec.order", o);
    this.recordFill(o, `paper-${o.id}`, price, qty, (qty * price * PAPER_FEE_BPS[intent.venue]) / 10_000, "USDT", fills);
    return { intent, intentRow, order: o, filledQty: intent.side === "BUY" ? qty : -qty, avgPrice: price, extId: null, status: "PAPER" };
  }

  private async liveLeg(intent: Intent, fills: Fill[]): Promise<Leg> {
    const intentRow = this.d.ledger.insertIntent(intent);
    const qty = this.round(intent.venue, intent.symbol, "qty", intent.qty);
    const price = intent.price === undefined ? undefined : this.round(intent.venue, intent.symbol, "price", intent.price);
    const cid = clientId(intent.engine, intent.id);
    const o = this.newOrder(intent, intentRow, cid, intent.side, qty, price);
    const leg: Leg = { intent, intentRow, order: o, filledQty: 0, avgPrice: 0, extId: null, status: "PENDING" };
    try {
      if (intent.venue === "futures") {
        const p: FuturesOrderParams = { symbol: intent.symbol, side: intent.side, type: intent.type, quantity: qty, newClientOrderId: cid };
        if (intent.type === "LIMIT") {
          p.price = price;
          p.timeInForce = "GTC";
        }
        const row = await this.futures().order(p);
        this.applyFuturesAck(leg, row, fills);
      } else if (intent.venue === "spot") {
        const p: SpotOrderParams = { symbol: intent.symbol, side: intent.side, type: intent.type, quantity: qty, newClientOrderId: cid };
        if (intent.type === "LIMIT") {
          p.price = price;
          p.timeInForce = "GTC";
        }
        const row = await this.spot().order(p);
        this.applySpotAck(leg, row, fills);
      } else {
        const r = await this.onchain().swap({ ...intent, qty });
        leg.extId = r.txOrRef;
        leg.avgPrice = r.price;
        leg.filledQty = intent.side === "BUY" ? r.qty : -r.qty;
        leg.status = "FILLED";
        this.ack(o, intent.tSignalNs, r.txOrRef, "FILLED", JSON.stringify(r));
        this.recordFill(o, r.txOrRef, r.price, r.qty, r.fee, "USD", fills);
      }
    } catch (err) {
      const certain = err instanceof BinanceError && err.status >= 400 && err.status < 500 && err.code !== -1007 && err.code !== -1006;
      o.status = certain ? "FAILED" : "PENDING";
      this.d.ledger.updateOrderStatus(o.id, o.status, JSON.stringify({ symbol: o.symbol, side: o.side, qty: o.qty, price: o.price ?? null, error: errText(err), ...(certain ? { executedQty: 0 } : {}) }));
      this.bus.emit("exec.order", o);
      this.onError(intent.venue, err);
      if (!certain) {
        try {
          if (intent.venue === "futures") this.applyFuturesAck(leg, await this.futures().queryOrder(intent.symbol, { origClientOrderId: cid }), fills);
          else if (intent.venue === "spot") this.applySpotAck(leg, await this.spot().queryOrder(intent.symbol, { origClientOrderId: cid }), fills);
          else throw err;
          await this.syncFills(leg.order, fills);
          return leg;
        } catch (queryError) {
          throw new UncertainLeg(leg, queryError);
        }
      }
      throw err;
    }
    await this.syncFills(o, fills);
    return leg;
  }

  private applyFuturesAck(leg: Leg, row: FuturesOrderRow, _fills: Fill[]): void {
    const status = mapStatus(row.status);
    const executed = Number(row.executedQty);
    const avg = Number(row.avgPrice);
    leg.extId = String(row.orderId);
    leg.status = status;
    leg.avgPrice = avg;
    leg.filledQty = leg.intent.side === "BUY" ? executed : -executed;
    this.ack(leg.order, leg.intent.tSignalNs, leg.extId, status, JSON.stringify({ symbol: leg.order.symbol, side: leg.order.side, qty: leg.order.qty, price: leg.order.price ?? null, ack: row }));
  }

  private applySpotAck(leg: Leg, row: SpotOrderRow, _fills: Fill[]): void {
    const status = mapStatus(row.status);
    const executed = Number(row.executedQty);
    const quote = Number(row.cummulativeQuoteQty);
    const avg = executed > 0 ? quote / executed : Number(row.price);
    leg.extId = String(row.orderId);
    leg.status = status;
    leg.avgPrice = avg;
    leg.filledQty = leg.intent.side === "BUY" ? executed : -executed;
    this.ack(leg.order, leg.intent.tSignalNs, leg.extId, status, JSON.stringify({ symbol: leg.order.symbol, side: leg.order.side, qty: leg.order.qty, price: leg.order.price ?? null, ack: row }));
  }

  private async syncFills(order: Order, fills: Fill[], force = false): Promise<void> {
    if (order.venue === "dex" || (!force && this.d.fillsFromAck !== true)) return;
    const off = this.bus.on("exec.fill", (fill) => { if (fill.orderId === order.id) fills.push(fill); });
    try {
      await recoverFills({ ledger: this.d.ledger, bus: this.bus, futuresRest: order.venue === "futures" ? this.futures() : undefined, spotRest: order.venue === "spot" ? this.spot() : undefined, futuresSymbols: [order.symbol], spotSymbols: [order.symbol] });
    } finally {
      off();
    }
  }

  // ---- rollback -----------------------------------------------------------

  private async rollback(parent: Intent, done: Leg[]): Promise<{ ok: boolean; residue: Array<{ venue: Venue; symbol: string; qty: number }> }> {
    const residue: Array<{ venue: Venue; symbol: string; qty: number }> = [];
    let ok = true;
    for (let i = done.length - 1; i >= 0; i--) {
      const leg = done[i] as Leg;
      const tsNs = this.now();
      try {
        await this.unwind(leg);
        this.bus.emit("exec.rollback", { intentId: parent.id, venue: leg.intent.venue, ok: true, detail: `unwound ${leg.filledQty} ${leg.intent.symbol}`, tsNs });
      } catch (err) {
        ok = false;
        residue.push({ venue: leg.intent.venue, symbol: leg.intent.symbol, qty: leg.filledQty });
        log.error("rollback failed", { intent: parent.id, venue: leg.intent.venue, symbol: leg.intent.symbol, error: errText(err) });
        this.bus.emit("exec.rollback", { intentId: parent.id, venue: leg.intent.venue, ok: false, detail: errText(err), tsNs });
      }
    }
    if (!ok && this.d.killFn !== undefined) {
      try {
        await this.d.killFn("rollback_failed");
      } catch (err) {
        log.error("kill after rollback failure threw", { error: errText(err) });
      }
    }
    return { ok, residue };
  }

  private async unwind(leg: Leg): Promise<void> {
    const { intent } = leg;
    // S01: paper legs never touch venue REST; synthesize a paper reversal fill.
    if (intent.paper) {
      if (leg.filledQty === 0) return;
      const side = leg.filledQty > 0 ? "SELL" : "BUY";
      const qty = Math.abs(leg.filledQty);
      const cid = clientId(intent.engine, intent.id, `-rb${++this.seq}`);
      const o = this.newOrder({ ...intent, paper: true }, leg.intentRow, cid, side, qty, undefined);
      const price = this.paperPrice(intent);
      const fills: Fill[] = [];
      this.d.ledger.updateOrderAck(o.id, { extId: null, status: "PAPER", tAckNs: this.now(), latencyMs: 0 });
      o.status = "PAPER";
      this.recordFill(o, `paper-rb-${o.id}`, price, qty, 0, "USDT", fills);
      return;
    }
    if (this.killed || this.d.kernel.killedInProcess || readKillLock(this.d.stateDir) !== null) throw new Error("kill owns rollback; entry reversal not sent");
    const fills: Fill[] = [];
    // Resting remainder first, so a late fill cannot land after the reverse order.
    if (leg.extId !== null && (leg.status === "NEW" || leg.status === "PARTIALLY_FILLED")) {
      try {
        if (intent.venue === "futures") {
          const row = await this.futures().cancelOrder(intent.symbol, { orderId: Number(leg.extId) });
          this.applyFuturesAck(leg, row, []);
        } else if (intent.venue === "spot") {
          const row = await this.spot().cancelOrder(intent.symbol, { orderId: Number(leg.extId) });
          this.applySpotAck(leg, row, []);
        }
      } catch (err) {
        if (!(err instanceof BinanceError && err.code === -2011)) throw err;
        if (intent.venue === "futures") this.applyFuturesAck(leg, await this.futures().queryOrder(intent.symbol, { origClientOrderId: leg.order.clientId }), []);
        else if (intent.venue === "spot") this.applySpotAck(leg, await this.spot().queryOrder(intent.symbol, { origClientOrderId: leg.order.clientId }), []);
      }
      if (!["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(leg.status)) throw new Error("cancel not terminal");
      await this.syncFills(leg.order, [], true);
    }
    if (leg.filledQty === 0) return;
    const side = leg.filledQty > 0 ? "SELL" : "BUY";
    const qty = this.round(intent.venue, intent.symbol, "qty", Math.abs(leg.filledQty));
    if (qty <= 0) return;
    const cid = clientId(intent.engine, intent.id, `-rb${++this.seq}`);
    if (intent.venue === "dex") {
      const o = this.newOrder(intent, leg.intentRow, cid, side, qty, undefined);
      try {
        const r = await this.onchain().swap({ ...intent, id: `${intent.id}-rb`, side, qty, type: "MARKET" });
        this.ack(o, intent.tSignalNs, r.txOrRef, "FILLED", JSON.stringify(r));
        this.recordFill(o, r.txOrRef, r.price, r.qty, r.fee, "USD", fills);
      } catch (err) {
        this.d.ledger.updateOrderStatus(o.id, "FAILED", JSON.stringify({ error: errText(err) }));
        throw err;
      }
      return;
    }
    const o = this.newOrder(intent, leg.intentRow, cid, side, qty, undefined);
    try {
      if (intent.venue === "futures") {
        const row = await this.futures().order({ symbol: intent.symbol, side, type: "MARKET", quantity: qty, reduceOnly: true, newClientOrderId: cid });
        const rb: Leg = { intent: { ...intent, side }, intentRow: leg.intentRow, order: o, filledQty: 0, avgPrice: 0, extId: null, status: "PENDING" };
        this.applyFuturesAck(rb, row, fills);
      } else {
        const row = await this.spot().order({ symbol: intent.symbol, side, type: "MARKET", quantity: qty, newClientOrderId: cid });
        const rb: Leg = { intent: { ...intent, side }, intentRow: leg.intentRow, order: o, filledQty: 0, avgPrice: 0, extId: null, status: "PENDING" };
        this.applySpotAck(rb, row, fills);
      }
      await this.syncFills(o, fills, true);
      if (o.status !== "FILLED") throw new Error("rollback close not terminal FILLED");
    } catch (err) {
      this.d.ledger.updateOrderStatus(o.id, o.status, JSON.stringify({ error: errText(err) }));
      this.onError(intent.venue, err);
      throw err;
    }
  }

  // ---- TP / SL --------------------------------------------------------------

  private async protect(leg: Leg): Promise<void> {
    const { intent } = leg;
    if (intent.tp === undefined && intent.sl === undefined) return;
    if (intent.paper) return;
    if (intent.venue === "spot") {
      this.addWatcher({ orderId: leg.order.id, engine: intent.engine, symbol: intent.symbol, side: intent.side, qty: leg.order.qty, tp: intent.tp, sl: intent.sl, extId: leg.extId ?? undefined, firing: false });
      return;
    }
    if (intent.venue === "dex") {
      log.warn("tp/sl unsupported on dex; leg unprotected", { intent: intent.id, symbol: intent.symbol });
      return;
    }
    if (leg.filledQty === 0) {
      log.warn("futures leg not filled yet; tp/sl deferred to the user stream", { intent: intent.id, symbol: intent.symbol });
      return;
    }
    const side = opposite(intent.side);
    const qty = this.round("futures", intent.symbol, "qty", Math.abs(leg.filledQty));
    const legsToPlace: Array<["tp" | "sl", number]> = [];
    if (intent.tp !== undefined) legsToPlace.push(["tp", intent.tp]);
    if (intent.sl !== undefined) legsToPlace.push(["sl", intent.sl]);
    for (const [kind, stop] of legsToPlace) {
      const cid = clientId(intent.engine, intent.id, `-${kind}`);
      const stopPrice = this.round("futures", intent.symbol, "price", stop);
      const o = this.newOrder(intent, leg.intentRow, cid, side, qty, stopPrice);
      try {
        const row = await this.futures().order({ symbol: intent.symbol, side, type: kind === "tp" ? "TAKE_PROFIT_MARKET" : "STOP_MARKET", quantity: qty, stopPrice, reduceOnly: true, newClientOrderId: cid });
        this.ack(o, intent.tSignalNs, String(row.orderId), mapStatus(row.status), JSON.stringify({ symbol: o.symbol, side: o.side, qty: o.qty, price: o.price ?? null, kind, ack: row }));
      } catch (err) {
        this.d.ledger.updateOrderStatus(o.id, "FAILED", JSON.stringify({ error: errText(err) }));
        this.onError("futures", err);
        log.error(`futures ${kind} order failed; position unprotected`, { intent: intent.id, symbol: intent.symbol, error: errText(err) });
      }
    }
  }

  private addWatcher(w: SpotWatcher): void {
    let list = this.watchers.get(w.symbol);
    if (list === undefined) {
      list = [];
      this.watchers.set(w.symbol, list);
    }
    if (list.some((x) => x.orderId === w.orderId)) return;
    list.push(w);
    log.info("spot tp/sl watcher armed", { orderId: w.orderId, symbol: w.symbol, side: w.side, qty: w.qty, tp: w.tp, sl: w.sl });
  }

  /**
   * Re-arms the spot TP/SL watcher for a ledger order whose intent carried tp/sl (boot recovery).
   * Returns false when the order is not spot or its intent has no tp/sl.
   */
  rebuildWatcher(order: Order): boolean {
    if (order.venue !== "spot") return false;
    const row = this.d.ledger.db.query<{ engine: EngineId; json: string | null }, [number]>("SELECT engine, json FROM intents WHERE id = ?").get(order.intentId);
    if (row === null) return false;
    let tp: number | undefined;
    let sl: number | undefined;
    if (row.json !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.json);
      } catch {
        return false;
      }
      if (typeof parsed === "object" && parsed !== null) {
        if ("tp" in parsed && typeof parsed.tp === "number") tp = parsed.tp;
        if ("sl" in parsed && typeof parsed.sl === "number") sl = parsed.sl;
      }
    }
    if (tp === undefined && sl === undefined) return false;
    this.addWatcher({ orderId: order.id, engine: row.engine, symbol: order.symbol, side: order.side, qty: order.qty, tp, sl, extId: order.extId, firing: false });
    return true;
  }

  private onSpotTrade(symbol: string, price: number): void {
    const list = this.watchers.get(symbol);
    if (list === undefined || list.length === 0) return;
    for (const w of list) {
      if (w.firing) continue;
      const long = w.side === "BUY";
      const hitTp = w.tp !== undefined && (long ? price >= w.tp : price <= w.tp);
      const hitSl = w.sl !== undefined && (long ? price <= w.sl : price >= w.sl);
      if (!hitTp && !hitSl) continue;
      w.firing = true;
      void this.fireWatcher(w, hitTp ? "tp" : "sl", price).catch((err) => log.error("spot watcher close failed", { orderId: w.orderId, symbol, error: errText(err) }));
    }
  }

  private async fireWatcher(w: SpotWatcher, kind: "tp" | "sl", price: number): Promise<void> {
    const list = this.watchers.get(w.symbol);
    if (list !== undefined) {
      const i = list.indexOf(w);
      if (i >= 0) list.splice(i, 1);
    }
    const spot = this.spot();
    if (w.extId !== undefined) {
      try {
        await spot.cancelOrder(w.symbol, { orderId: Number(w.extId) });
      } catch (err) {
        if (!(err instanceof BinanceError && err.code === -2011)) log.warn("cancel before watcher close failed", { orderId: w.orderId, error: errText(err) });
      }
    }
    let qty = w.qty;
    if (this.d.positions !== null) {
      // Close only what this engine actually holds; zero holding means nothing to sell,
      // never "sell the requested quantity out of unrelated account balance".
      qty = Math.min(qty, Math.abs(this.d.positions.qty("spot", w.engine, w.symbol)));
    }
    qty = this.round("spot", w.symbol, "qty", qty);
    if (qty <= 0) return;
    const side = opposite(w.side);
    const attempt = w.attempts ?? 0;
    const cid = clientId(w.engine, String(w.orderId), attempt === 0 ? `-${kind}` : `-${kind}${attempt}`);
    const row = this.d.ledger.db.query<{ intent_id: number; t_sent_ns: number }, [number]>("SELECT intent_id, t_sent_ns FROM orders WHERE id = ?").get(w.orderId);
    const intentRow = row?.intent_id ?? 0;
    const o: Order = { id: 0, intentId: intentRow, venue: "spot", symbol: w.symbol, side, qty, clientId: cid, status: "PENDING", tSentNs: this.now() };
    o.id = this.d.ledger.insertOrderPending(o);
    const fills: Fill[] = [];
    try {
      const ack = await spot.order({ symbol: w.symbol, side, type: "MARKET", quantity: qty, newClientOrderId: cid });
      const leg: Leg = { intent: { id: String(w.orderId), engine: w.engine, venue: "spot", symbol: w.symbol, side, qty, type: "MARKET", ttlMs: 0, paper: false, tSignalNs: o.tSentNs }, intentRow, order: o, filledQty: 0, avgPrice: 0, extId: null, status: "PENDING" };
      this.applySpotAck(leg, ack, fills);
      log.info(`spot ${kind} hit; closed`, { orderId: w.orderId, symbol: w.symbol, trigger: price, qty });
    } catch (err) {
      this.d.ledger.updateOrderStatus(o.id, "FAILED", JSON.stringify({ error: errText(err) }));
      // Close did not land: keep protecting the position for the next trigger under a new client id.
      w.firing = false;
      w.attempts = attempt + 1;
      this.watchers.set(w.symbol, [...(this.watchers.get(w.symbol) ?? []), w]);
      this.onError("spot", err);
      throw err;
    }
  }

  // ---- throttle -----------------------------------------------------------

  private onError(venue: Venue, err: unknown): void {
    if (!(err instanceof BinanceError) || !err.throttled) return;
    const pauseMs = err.retryAfterMs ?? 60_000;
    this.paused = true;
    this.pauseUntilMs = Date.now() + pauseMs;
    log.warn("venue throttled; executor paused", { venue, status: err.status, pauseMs });
    this.bus.emit("system.throttle", { venue, status: err.status, pauseMs, tsNs: this.now() });
    const until = this.pauseUntilMs;
    const resume = () => {
      if (this.pauseUntilMs !== until) return;
      this.paused = false;
      log.info("executor resumed");
    };
    if (this.d.clock !== undefined) this.d.clock.setTimeout(resume, pauseMs);
    else setTimeout(resume, pauseMs).unref();
  }

  // ---- helpers ------------------------------------------------------------

  private round(venue: Venue, symbol: string, kind: "price" | "qty", value: number): number {
    const f = this.d.symbols(venue, symbol);
    if (f === null) return value;
    if (kind === "price") {
      const r = Math.round(value / f.tickSize) * f.tickSize;
      return Number(r.toFixed(decimals(f.tickSize)));
    }
    const r = Math.floor(value / f.stepSize + 1e-9) * f.stepSize;
    return Number(r.toFixed(decimals(f.stepSize)));
  }

  private futures(): FuturesRest {
    if (this.d.futuresRest === null) throw new Error("futures REST not configured (BINANCE_FUTURES_KEY/SECRET)");
    return this.d.futuresRest;
  }

  private spot(): SpotRest {
    if (this.d.spotRest === null) throw new Error("spot REST not configured (BINANCE_SPOT_KEY/SECRET)");
    return this.d.spotRest;
  }

  private onchain(): OnchainAdapter {
    if (this.d.onchain === null) throw new Error("on-chain adapter not configured");
    return this.d.onchain;
  }
}

function decimals(step: number): number {
  if (step >= 1) return 0;
  const s = step.toString();
  const e = s.indexOf("e-");
  if (e >= 0) return Number(s.slice(e + 2));
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

// ---- wiring ---------------------------------------------------------------

export interface ExecutorContext {
  env: Env;
  config: Config;
  ledger: Ledger;
  stateDir: string;
  configDir: string;
  feed?: { book(symbol: string): BookView | null; mark?(symbol: string): { mark: number; index: number } | null } | null;
  onchain?: OnchainAdapter | null;
  audit?: AuditCache;
  bus?: Bus;
  /** Synthesize fills from REST acks (no user-data stream in this process). */
  fillsFromAck?: boolean;
}

export interface ExecutorStack {
  executor: Executor;
  kernel: Kernel;
  guardian: Guardian;
  positions: Positions;
  futuresRest: FuturesRest | null;
  spotRest: SpotRest | null;
  onchain: OnchainAdapter | null;
  symbols: SymbolFilters;
  killDeps: KillDeps;
  /** Where the book's starting equity came from; set once by the module after boot reconcile. */
  funding: { initialUsd: number | null; source: string };
  kill(reason: string): Promise<KillResult>;
  /** Loads exchange filters; tolerant of offline venues. */
  loadSymbols(): Promise<void>;
  start(): void;
  stop(): void;
}

function defaultOnchain(env: Env): OnchainAdapter | null {
  if (env.onchain === "live") return env.bawBin === null ? null : new BawAdapter({ bin: env.bawBin });
  const fixture = "fixtures/smartmoney.ndjson";
  return new PaperAdapter({ fixturePath: fixture, replaySpeed: env.replaySpeed, loop: existsSync(fixture) });
}

/** Builds REST clients, positions, kernel, guardian and the executor. CLI verbs and the module share it. */
export function buildExecutor(ctx: ExecutorContext): ExecutorStack {
  const { env, config, ledger } = ctx;
  const urls = urlMatrix(env);
  const futuresWeight = new WeightGuard();
  const spotWeight = new WeightGuard();
  const futuresRest = env.keys.futures === null ? null : new FuturesRest({ baseUrl: urls.futuresRest, key: env.keys.futures.key, secret: env.keys.futures.secret, onWeight: (u) => futuresWeight.observe(u) });
  const spotRest = env.keys.spot === null ? null : new SpotRest({ baseUrl: urls.spotRest, key: env.keys.spot.key, secret: env.keys.spot.secret, onWeight: (u) => spotWeight.observe(u) });
  const onchain = ctx.onchain === undefined ? defaultOnchain(env) : ctx.onchain;
  const bus = ctx.bus ?? defaultBus;
  const symbols = new SymbolFilters();
  const positions = new Positions({ ledger, futures: futuresRest, spot: spotRest, bus, spotSymbols: config.risk.allowed_symbols.spot });
  const feed = ctx.feed ?? null;
  const feedView: FeedView = feed === null ? { book: () => null, mark: () => null } : { book: (s) => feed.book(s), mark: (s) => feed.mark?.(s) ?? null };
  let engines = config.engines;
  let stopWatch: (() => void) | null = null;
  // limits/budgets come from state files; re-read at most every STATE_TTL_MS so evaluate() stays cheap.
  let limitsAt = Number.NEGATIVE_INFINITY;
  let limitsCache: EffectiveLimits = effective(config.risk, null, wallMs(), false);
  let budgetsAt = Number.NEGATIVE_INFINITY;
  let budgetsCache: Budgets = {};
  const readEffectiveLimits = () => {
    const now = wallMs();
    if (now - limitsAt >= STATE_TTL_MS) {
      limitsAt = now;
      limitsCache = effective(config.risk, readLimits(ctx.stateDir), now, readKillLock(ctx.stateDir) !== null);
    }
    return limitsCache;
  };
  const kernel = new Kernel({
    stateDir: ctx.stateDir,
    risk: config.risk,
    engines: () => engines,
    limits: readEffectiveLimits,
    budgets: () => {
      const now = wallMs();
      if (now - budgetsAt >= STATE_TTL_MS) {
        budgetsAt = now;
        budgetsCache = readBudgets(ctx.stateDir);
      }
      return budgetsCache;
    },
    positions,
    feed: feedView,
    audit: ctx.audit ?? new AuditCache(),
    ledger,
    bus,
    minNotional: (venue, symbol) => symbols.get(venue, symbol)?.minNotional ?? 0,
    weightNearLimit: (venue) => (venue === "futures" ? futuresWeight.nearLimit() : venue === "spot" ? spotWeight.nearLimit() : false),
  });
  const killDeps: KillDeps = { futuresRest, spotRest, onchain, ledger, positions, stateDir: ctx.stateDir, env, risk: config.risk, bus };
  const killFn = (reason: string) => kill(reason, killDeps);
  const executor = new Executor({
    kernel,
    futuresRest,
    spotRest,
    onchain,
    ledger,
    positions,
    feed,
    symbols: (venue, symbol) => symbols.get(venue, symbol),
    stateDir: ctx.stateDir,
    env,
    bus,
    killFn,
    fillsFromAck: ctx.fillsFromAck ?? false,
  });
  killDeps.awaitEntries = () => executor.awaitEntries();
  // S12: bypass the 250 ms readEffectiveLimits cache — Guardian reads once per 1 s tick so a
  // direct disk read is fine, and the tightened threshold must be visible on the very next tick.
  const guardian = new Guardian({ positions, ledger, risk: config.risk, stateDir: ctx.stateDir, bus, killFn, feed: feedView, limits: () => effective(config.risk, readLimits(ctx.stateDir), wallMs(), readKillLock(ctx.stateDir) !== null) });
  return {
    executor,
    kernel,
    guardian,
    positions,
    futuresRest,
    spotRest,
    onchain,
    symbols,
    killDeps,
    funding: { initialUsd: null, source: "not reconciled yet" },
    kill: killFn,
    async loadSymbols() {
      if (futuresRest !== null) {
        try {
          symbols.load("futures", await futuresRest.exchangeInfo());
        } catch (err) {
          log.warn("futures exchangeInfo unavailable; no rounding", { error: errText(err) });
        }
      }
      if (spotRest !== null) {
        try {
          symbols.load("spot", await spotRest.exchangeInfo());
        } catch (err) {
          log.warn("spot exchangeInfo unavailable; no rounding", { error: errText(err) });
        }
      }
    },
    start() {
      positions.start();
      executor.start();
      guardian.start();
      stopWatch = watchEngines(ctx.configDir, (cfg) => {
        engines = cfg;
      });
    },
    stop() {
      stopWatch?.();
      stopWatch = null;
      guardian.stop();
      executor.stop();
      positions.stop();
      kernel.stop();
    },
  };
}

export function createExecutorModule(ctx: ExecutorContext): Module & { stack: ExecutorStack | null } {
  const bus = ctx.bus ?? defaultBus;
  let stack: ExecutorStack | null = null;
  let offKill: (() => void) | null = null;
  let killing: Promise<unknown> | null = null;
  return {
    name: "executor",
    order: "executor",
    stack,
    async start() {
      stack = buildExecutor(ctx);
      this.stack = stack;
      await stack.loadSymbols();
      // S02: Start positions (subscribe to exec.fill) BEFORE recoverBoot emits recovered fills,
      // so fills landed during the reconnect gap are applied to in-memory positions.
      stack.positions.start();
      await recoverBoot({ futuresRest: stack.futuresRest, spotRest: stack.spotRest, ledger: ctx.ledger, executor: stack.executor, positions: stack.positions, stateDir: ctx.stateDir });
      await recoverFills({ ledger: ctx.ledger, futuresRest: stack.futuresRest ?? undefined, spotRest: stack.spotRest ?? undefined, futuresSymbols: ctx.config.risk.allowed_symbols.futures, spotSymbols: ctx.config.risk.allowed_symbols.spot, bus });
      await stack.positions.reconcile();
      // Pure paper means no venue REST at all: seed the configured NAV cap so engines can trade
      // against the live feed. Any connected venue (testnet, demo, live) — keyed or not — keeps its
      // reconciled balance, even when zero; seeding on top would fight reconcile and trip the breakers.
      if (stack.futuresRest === null && stack.spotRest === null) {
        stack.positions.setCash(ctx.config.risk.nav_usd_cap);
        stack.positions.resetDayAnchor();
        stack.positions.dayStartNav();
        stack.funding = { initialUsd: ctx.config.risk.nav_usd_cap, source: "Paper seed from risk.nav_usd_cap (no exchange account configured)" };
        log.info("paper book funded for demo trading", { navUsd: ctx.config.risk.nav_usd_cap });
      } else {
        stack.funding = { initialUsd: stack.positions.nav(), source: `Binance spot=${ctx.env.spot} futures=${ctx.env.futures} account balance, reconciled at boot` };
      }
      const s = stack;
      offKill = bus.on("system.kill", (e) => {
        if (e.actor === "kill") return; // emitted by kill() itself
        if (killing !== null) return;
        killing = s.kill(e.reason).finally(() => {
          killing = null;
        });
      });
      stack.start();
    },
    async stop() {
      offKill?.();
      offKill = null;
      stack?.stop();
      if (killing !== null) await killing.catch(() => undefined);
    },
  };
}
