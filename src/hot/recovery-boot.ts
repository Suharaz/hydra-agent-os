// Boot recovery, run before engines start. Reads open orders / positions / balances from both
// venues, matches `hydra-<engine>-<intentId>` client ids to ledger orders (re-arming spot TP/SL
// watchers), cancels HYDRA-prefixed orders the ledger does not know, expires ledger orders the venue
// no longer has, and surfaces an existing kill.lock as a banner + alert. `reconcile()` is the
// venue-side residue check `cli unkill` gates on.

import { alert as defaultAlert, type AlertLevel } from "../core/alert.ts";
import type { Ledger } from "../core/ledger.ts";
import { logger } from "../core/log.ts";
import { readKillLock } from "../core/state.ts";
import type { KillLock, Order, OrderStatus, Residue, Venue } from "../core/types.ts";
import type { FuturesRest } from "../venues/binance/rest-futures.ts";
import type { SpotRest } from "../venues/binance/rest-spot.ts";
import type { Positions } from "./positions.ts";

const log = logger("recovery");

export const HYDRA_PREFIX = "hydra-";

export interface RecoveryDeps {
  futuresRest: FuturesRest | null;
  spotRest: SpotRest | null;
  ledger: Ledger;
  executor: { rebuildWatcher(order: Order): boolean };
  /** When present, one reconcile pass seeds venue-side marks/positions before engines start. */
  positions?: Positions | null;
  stateDir: string;
  alertFn?: (level: AlertLevel, msg: string) => Promise<void> | void;
}

export interface RecoverySummary {
  killLock: KillLock | null;
  venueOpen: Record<"futures" | "spot", number>;
  futuresPositions: Residue[];
  spotBalances: Array<{ asset: string; qty: number }>;
  /** Venue orders matched to ledger rows by client id. */
  matched: number;
  watchersRebuilt: number;
  cancelledUnknown: number;
  /** Ledger orders still open that the venue no longer reports; marked EXPIRED. */
  expiredStale: number;
}

interface VenueOpen {
  venue: "futures" | "spot";
  symbol: string;
  orderId: number;
  clientOrderId: string;
  status: string;
  cancel(): Promise<unknown>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function recoverBoot(deps: RecoveryDeps): Promise<RecoverySummary> {
  const summary: RecoverySummary = { killLock: null, venueOpen: { futures: 0, spot: 0 }, futuresPositions: [], spotBalances: [], matched: 0, watchersRebuilt: 0, cancelledUnknown: 0, expiredStale: 0 };
  const open: VenueOpen[] = [];

  if (deps.futuresRest !== null) {
    const [orders, positions] = await Promise.all([deps.futuresRest.openOrders(), deps.futuresRest.positionRisk()]);
    const rest = deps.futuresRest;
    for (const o of orders) open.push({ venue: "futures", symbol: o.symbol, orderId: o.orderId, clientOrderId: o.clientOrderId, status: o.status, cancel: () => rest.cancelOrder(o.symbol, { orderId: o.orderId }) });
    summary.venueOpen.futures = orders.length;
    for (const p of positions) {
      const qty = Number(p.positionAmt);
      if (qty !== 0) summary.futuresPositions.push({ symbol: p.symbol, qty });
    }
  }
  if (deps.spotRest !== null) {
    const [orders, acct] = await Promise.all([deps.spotRest.openOrders(), deps.spotRest.account()]);
    const rest = deps.spotRest;
    for (const o of orders) open.push({ venue: "spot", symbol: o.symbol, orderId: o.orderId, clientOrderId: o.clientOrderId, status: o.status, cancel: () => rest.cancelOrder(o.symbol, { orderId: o.orderId }) });
    summary.venueOpen.spot = orders.length;
    for (const b of acct.balances) {
      const qty = Number(b.free) + Number(b.locked);
      if (qty > 0) summary.spotBalances.push({ asset: b.asset, qty });
    }
  }

  const ledgerOpen = deps.ledger.openOrders();
  const byClientId = new Map<string, Order>();
  for (const o of ledgerOpen) byClientId.set(o.clientId, o);
  const seen = new Set<number>();

  for (const v of open) {
    if (!v.clientOrderId.startsWith(HYDRA_PREFIX)) continue;
    const row = byClientId.get(v.clientOrderId);
    if (row === undefined) {
      try {
        await v.cancel();
        summary.cancelledUnknown++;
        log.warn("cancelled unknown HYDRA order", { venue: v.venue, symbol: v.symbol, orderId: v.orderId, clientOrderId: v.clientOrderId });
      } catch (err) {
        log.error("cancel of unknown HYDRA order failed", { venue: v.venue, symbol: v.symbol, orderId: v.orderId, error: errText(err) });
      }
      continue;
    }
    seen.add(row.id);
    summary.matched++;
    const extId = String(v.orderId);
    if (row.status === "PENDING" || row.extId !== extId) {
      const status = v.status === "PARTIALLY_FILLED" ? "PARTIALLY_FILLED" : "NEW";
      deps.ledger.updateOrderAck(row.id, { extId, status, tAckNs: row.tAckNs ?? row.tSentNs, latencyMs: row.latencyMs ?? 0 });
      row.extId = extId;
      row.status = status;
    }
    if (deps.executor.rebuildWatcher(row)) summary.watchersRebuilt++;
  }

  for (const row of ledgerOpen) {
    if (seen.has(row.id)) continue;
    if (row.venue === "dex" || row.status === "PAPER") continue;
    if ((row.venue === "futures" && deps.futuresRest === null) || (row.venue === "spot" && deps.spotRest === null)) continue;
    try {
      const rest = row.venue === "futures" ? deps.futuresRest! : deps.spotRest!;
      const found = await rest.queryOrder(row.symbol, { origClientOrderId: row.clientId });
      deps.ledger.updateOrderAck(row.id, { extId: String(found.orderId), status: found.status as OrderStatus, tAckNs: row.tAckNs ?? row.tSentNs, latencyMs: row.latencyMs ?? 0, json: JSON.stringify({ ack: found }) });
      row.status = found.status as OrderStatus;
      row.extId = String(found.orderId);
      summary.matched++;
      if (deps.executor.rebuildWatcher(row)) summary.watchersRebuilt++;
    } catch (err) {
      // Absence from openOrders (or an unavailable query) never proves an ambiguous send failed.
      log.warn("order remains unresolved at boot", { id: row.id, clientId: row.clientId, error: errText(err) });
    }
  }

  if (deps.positions !== undefined && deps.positions !== null) {
    try {
      await deps.positions.reconcile();
      // Re-arm protection watchers for any open position whose intent carried tp/sl
      for (const pos of deps.positions.snapshot()) {
        if (Math.abs(pos.qty) <= 0) continue;
        const row = deps.ledger.db.query<{ id: number; intent_id: number; venue: Venue; symbol: string; side: Side; qty: number; client_id: string; status: OrderStatus; t_sent_ns: number; price?: number; ext_id: string | null }, [string, string, string]>(
          "SELECT orders.id, orders.intent_id, orders.venue, orders.symbol, orders.side, orders.qty, orders.client_id, orders.status, orders.t_sent_ns, orders.ext_id " +
          "FROM orders JOIN intents ON orders.intent_id = intents.id " +
          "WHERE orders.venue = ? AND intents.engine = ? AND orders.symbol = ? AND orders.status = 'FILLED' " +
          "ORDER BY orders.id DESC LIMIT 1"
        ).get(pos.venue, pos.engine, pos.symbol);
        if (row) {
          const ord: Order = {
            id: row.id,
            intentId: row.intent_id,
            venue: row.venue,
            symbol: row.symbol,
            side: row.side,
            qty: row.qty,
            clientId: row.client_id,
            status: row.status,
            tSentNs: row.t_sent_ns,
            extId: row.ext_id ?? undefined,
          };
          if (deps.executor.rebuildWatcher(ord)) {
            summary.watchersRebuilt++;
          }
        }
      }
    } catch (err) {
      log.warn("initial reconcile failed", { error: errText(err) });
    }
  }

  summary.killLock = readKillLock(deps.stateDir);
  if (summary.killLock !== null) {
    const l = summary.killLock;
    const banner = `KILL LOCK ACTIVE since ${new Date(l.at).toISOString()} — reason: ${l.reason}; residue ${JSON.stringify(l.residue)}. Engines stay locked until \`cli unkill\`.`;
    log.error(banner, { reason: l.reason, at: l.at, residue: l.residue });
    try {
      await (deps.alertFn ?? defaultAlert)("critical", banner);
    } catch (err) {
      log.error("alert threw", { error: errText(err) });
    }
  }

  log.info("boot recovery", {
    futuresOpen: summary.venueOpen.futures,
    spotOpen: summary.venueOpen.spot,
    futuresPositions: summary.futuresPositions.length,
    spotAssets: summary.spotBalances.length,
    matched: summary.matched,
    watchers: summary.watchersRebuilt,
    cancelledUnknown: summary.cancelledUnknown,
    expiredStale: summary.expiredStale,
    killLock: summary.killLock !== null,
  });
  return summary;
}

// ---- reconcile ------------------------------------------------------------

export interface ReconcileDeps {
  futuresRest: FuturesRest | null;
  spotRest: SpotRest | null;
  /** Spot symbols hydra may hold (risk.yaml allowed_symbols.spot). */
  spotSymbols: readonly string[];
  quoteAsset?: string;
  dust?: (venue: Venue, symbol: string) => number;
  ledger?: Ledger;
  positions?: Positions;
  priorLock?: KillLock | null;
}

export interface VenueReconcile {
  residue: Record<Venue, Residue[]>;
  openOrders: number;
  clean: boolean;
}

/** Venue-side truth only: non-zero futures positions, spot base balances for allowed symbols, open orders. */
export async function reconcile(deps: ReconcileDeps): Promise<VenueReconcile> {
  const quote = deps.quoteAsset ?? "USDT";
  const dust = deps.dust ?? (() => 0);
  const residue: Record<Venue, Residue[]> = { futures: [], spot: [], dex: [] };
  let openOrders = 0;
  for (const venue of ["futures", "spot", "dex"] as const) {
    const required = (deps.priorLock?.residue[venue].length ?? 0) > 0 || (deps.positions?.attributed(venue).length ?? 0) > 0 || (deps.ledger?.openOrders().some((o) => o.venue === venue) ?? false);
    if (required && (venue === "dex" || (venue === "futures" ? deps.futuresRest === null : deps.spotRest === null))) {
      residue[venue] = deps.priorLock?.residue[venue].length ? deps.priorLock.residue[venue] : [{ symbol: "*", qty: 0 }];
    }
  }
  if (deps.futuresRest !== null) {
    const [rows, open] = await Promise.all([deps.futuresRest.positionRisk(), deps.futuresRest.openOrders()]);
    for (const r of rows) {
      const qty = Number(r.positionAmt);
      if (Math.abs(qty) > dust("futures", r.symbol)) residue.futures.push({ symbol: r.symbol, qty });
    }
    openOrders += open.length;
  }
  if (deps.spotRest !== null) {
    const [acct, open] = await Promise.all([deps.spotRest.account(), deps.spotRest.openOrders()]);
    for (const symbol of deps.spotSymbols) {
      if (!symbol.endsWith(quote)) continue;
      const base = symbol.slice(0, -quote.length);
      const b = acct.balances.find((x) => x.asset === base);
      if (b === undefined) continue;
      const qty = Number(b.free) + Number(b.locked);
      if (qty > dust("spot", symbol)) residue.spot.push({ symbol, qty });
    }
    openOrders += open.length;
  }
  return { residue, openOrders, clean: residue.futures.length === 0 && residue.spot.length === 0 && residue.dex.length === 0 && openOrders === 0 };
}
