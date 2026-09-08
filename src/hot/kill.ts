// Kill switch. REST only (never the executor, so throttle pauses cannot block it). Order of
// operations: write kill.lock, emit system.kill, then loop — cancel every open order per symbol,
// flatten futures from positionRisk (reduce-only MARKET), flatten spot base balances (engine-attributed,
// or every non-quote asset with KILL_FLATTEN_ALL_SPOT), reverse DEX exposure, verify per venue,
// rewrite the lock residue. Backoff 0.5 s doubling to 10 s, no attempt cap: the loop runs until flat
// or stopKill(). After `kill_verify_attempts_before_alert` failed passes it alerts and emits
// system.kill.failed on every further pass. Concurrent callers share the in-flight run; a second
// call after completion re-verifies and re-flattens — never "already ran".

import { alert as defaultAlert, type AlertLevel } from "../core/alert.ts";
import { bus as defaultBus, type Bus } from "../core/bus.ts";
import { nowNs, wallMs } from "../core/clock.ts";
import type { RiskConfig } from "../core/config.ts";
import type { Env } from "../core/env.ts";
import type { Ledger } from "../core/ledger.ts";
import { logger } from "../core/log.ts";
import { readKillLock, writeKillLock } from "../core/state.ts";
import type { EngineId, Fill, Intent, KillLock, OrderStatus, Residue, Venue } from "../core/types.ts";
import type { FuturesRest } from "../venues/binance/rest-futures.ts";
import type { SpotRest } from "../venues/binance/rest-spot.ts";
import type { OnchainAdapter } from "../venues/onchain/adapter.ts";
import type { Positions } from "./positions.ts";
import { recoverFills } from "../venues/binance/recovery.ts";
import { BinanceError } from "../venues/binance/http.ts";

const log = logger("kill");

export interface KillDeps {
  futuresRest: FuturesRest | null;
  spotRest: SpotRest | null;
  onchain: OnchainAdapter | null;
  ledger: Ledger;
  /** Engine attribution for spot/dex residue; null flattens nothing on spot unless `env.killFlattenAllSpot`. */
  positions: Positions | null;
  stateDir: string;
  env: Pick<Env, "killFlattenAllSpot">;
  risk: Pick<RiskConfig, "kill_verify_attempts_before_alert">;
  alertFn?: (level: AlertLevel, msg: string) => Promise<void> | void;
  sleep?: (ms: number) => Promise<void>;
  bus?: Bus;
  quoteAsset?: string;
  /** Venue grid rounding for flatten quantities (qty truncates to step); identity when absent. */
  roundQty?: RoundQty;
  /** Below this |qty| a venue balance is dust, not residue. */
  dust?: Dust;
  /** Wait for entry requests already sent before the synchronous kill barrier. */
  awaitEntries?: () => Promise<void>;
}

export type RoundQty = (venue: Venue, symbol: string, qty: number) => number;
export type Dust = (venue: Venue, symbol: string) => number;

/** Residue placeholder when a venue could not be queried this pass (symbol `*`): exposure is unknown, not zero. */
export const UNVERIFIED: Residue = { symbol: "*", qty: 0 };

export interface KillResult {
  flat: boolean;
  residue: Record<Venue, Residue[]>;
  attempts: number;
  /** False when stopKill() interrupted the loop. */
  stopped: boolean;
}

export const KILL_BACKOFF_MIN_MS = 500;
export const KILL_BACKOFF_MAX_MS = 10_000;

let inflight: Promise<KillResult> | null = null;
let stopRequested = false;

/** Ends the verify loop after its current pass (operator escape hatch; the lock stays). */
export function stopKill(): void {
  stopRequested = true;
}

export function killInFlight(): boolean {
  return inflight !== null;
}

export function kill(reason: string, deps: KillDeps): Promise<KillResult> {
  if (inflight !== null) {
    log.warn("kill already running; joining", { reason });
    return inflight;
  }
  stopRequested = false;
  inflight = run(reason, deps).finally(() => {
    inflight = null;
  });
  return inflight;
}

function emptyResidue(): Record<Venue, Residue[]> {
  return { futures: [], spot: [], dex: [] };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function run(reason: string, deps: KillDeps): Promise<KillResult> {
  const bus = deps.bus ?? defaultBus;
  const alertFn = deps.alertFn ?? defaultAlert;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const quote = deps.quoteAsset ?? "USDT";
  const roundQty: RoundQty = deps.roundQty ?? ((_v, _s, q) => q);
  const dust: Dust = deps.dust ?? (() => 0);
  const threshold = deps.risk.kill_verify_attempts_before_alert;

  const prior = readKillLock(deps.stateDir);
  const lock: KillLock = { reason, at: wallMs(), residue: prior?.residue ?? emptyResidue() };
  writeKillLock(deps.stateDir, lock, "kill");
  deps.ledger.event("system.kill", JSON.stringify({ reason, prior: prior?.reason ?? null }));
  log.error("KILL", { reason, priorLock: prior?.reason ?? null });
  bus.emit("system.kill", { reason, actor: "kill", tsNs: nowNs() });
  await deps.awaitEntries?.();

  let attempts = 0;
  let alerted = false;
  let backoff = KILL_BACKOFF_MIN_MS;
  for (;;) {
    attempts++;
    const residue = emptyResidue();
    const errors: string[] = [];

    if (deps.futuresRest !== null) {
      try {
        await flattenFutures(deps, deps.futuresRest, roundQty);
        residue.futures = await verifyFutures(deps.futuresRest, dust);
      } catch (err) {
        errors.push(`futures: ${errText(err)}`);
        residue.futures = lock.residue.futures.length > 0 ? lock.residue.futures : [UNVERIFIED];
      }
    } else if (requiredVenue(deps, "futures", lock)) {
      residue.futures = lock.residue.futures.length > 0 ? lock.residue.futures : [UNVERIFIED];
    }
    if (deps.spotRest !== null) {
      try {
        await flattenSpot(deps, deps.spotRest, quote, roundQty, dust, deps.ledger);
        residue.spot = await verifySpot(deps, deps.spotRest, quote, dust);
      } catch (err) {
        errors.push(`spot: ${errText(err)}`);
        residue.spot = lock.residue.spot.length > 0 ? lock.residue.spot : [UNVERIFIED];
      }
    } else if (requiredVenue(deps, "spot", lock)) {
      residue.spot = lock.residue.spot.length > 0 ? lock.residue.spot : [UNVERIFIED];
    }
    if (deps.positions !== null) {
      try {
        const hadExposure = deps.positions.attributed("dex").length > 0;
        residue.dex = await flattenDex(deps, deps.positions, bus, roundQty);
        if (!hadExposure && lock.residue.dex.length > 0) residue.dex = lock.residue.dex;
      } catch (err) {
        errors.push(`dex: ${errText(err)}`);
        residue.dex = deps.positions.attributed("dex");
      }
    } else if (lock.residue.dex.length > 0) {
      // S10: no DEX adapter but prior lock recorded DEX residue — preserve as UNVERIFIED.
      residue.dex = lock.residue.dex;
    }

    lock.residue = residue;
    writeKillLock(deps.stateDir, lock, "kill");
    const flat = residue.futures.length === 0 && residue.spot.length === 0 && residue.dex.length === 0 && errors.length === 0;
    if (flat) {
      log.info("kill verified flat", { reason, attempts });
      deps.ledger.event("system.kill.flat", JSON.stringify({ reason, attempts }));
      return { flat: true, residue, attempts, stopped: false };
    }
    log.warn("kill pass left residue", { reason, attempt: attempts, residue, errors });
    if (attempts >= threshold) {
      bus.emit("system.kill.failed", { reason, attempt: attempts, residue, tsNs: nowNs() });
      if (!alerted) {
        alerted = true;
        try {
          await alertFn("critical", `kill "${reason}" not flat after ${attempts} attempts; residue ${JSON.stringify(residue)}; errors ${errors.join(" | ") || "none"}`);
        } catch (err) {
          log.error("alert threw", { error: errText(err) });
        }
      }
    }
    if (stopRequested) {
      log.error("kill loop stopped by operator; residue remains", { reason, residue });
      return { flat: false, residue, attempts, stopped: true };
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, KILL_BACKOFF_MAX_MS);
  }
}


async function syncVenueOrders(deps: KillDeps, venue: "futures" | "spot"): Promise<void> {
  const rest = venue === "futures" ? deps.futuresRest! : deps.spotRest!;
  for (const order of deps.ledger.openOrders()) {
    if (order.venue !== venue || order.qty === 0) continue;
    const found = await rest.queryOrder(order.symbol, { origClientOrderId: order.clientId });
    deps.ledger.updateOrderAck(order.id, { extId: String(found.orderId), status: found.status as OrderStatus, tAckNs: nowNs(), latencyMs: 0, json: JSON.stringify({ ack: found }) });
    (deps.bus ?? defaultBus).emit("exec.order", { ...order, extId: String(found.orderId), status: found.status as OrderStatus });
  }
  const symbols = deps.ledger.db.query<{ symbol: string }, [Venue]>("SELECT DISTINCT json_extract(json, '$.symbol') AS symbol FROM orders WHERE venue = ?").all(venue).map((r) => r.symbol);
  await recoverFills({ ledger: deps.ledger, bus: deps.bus, futuresRest: venue === "futures" ? deps.futuresRest! : undefined, spotRest: venue === "spot" ? deps.spotRest! : undefined, futuresSymbols: symbols, spotSymbols: symbols });
}
// ---- futures --------------------------------------------------------------

function requiredVenue(deps: KillDeps, venue: Venue, lock: KillLock): boolean {
  const durable = deps.ledger.db.query<{ net: number }, [Venue]>("SELECT SUM(CASE f.side WHEN 'BUY' THEN f.qty ELSE -f.qty END) AS net FROM fills f JOIN orders o ON o.id = f.order_id JOIN intents i ON i.id = o.intent_id WHERE f.venue = ? AND i.paper = 0 AND COALESCE(json_extract(i.json, '$.killUnattributed'), 0) = 0 GROUP BY i.engine, f.symbol HAVING ABS(net) > 0.000000000001 LIMIT 1").get(venue);
  return durable !== null || lock.residue[venue].length > 0 || (deps.positions?.attributed(venue).length ?? 0) > 0 || deps.ledger.db.query<{ found: number }, [Venue]>("SELECT 1 AS found FROM orders o JOIN intents i ON i.id = o.intent_id WHERE o.venue = ? AND i.paper = 0 AND o.status IN ('PENDING', 'NEW', 'PARTIALLY_FILLED') LIMIT 1").get(venue) !== null;
}

let emergencySeq = 0;

/** Each mutation has a write-through identity, even if its response is lost. */
function emergencyOrder(deps: KillDeps, venue: Venue, symbol: string, side: "BUY" | "SELL", qty: number, engine: EngineId, unattributed = false) {
  const cid = `hydra-kill-${wallMs()}-${++emergencySeq}`;
  const intent: Intent = { id: cid, engine, venue, symbol, side, qty, type: "MARKET", ttlMs: 0, paper: false, tSignalNs: nowNs() };
  const intentRow = deps.ledger.insertIntent({ ...intent, ...{ killUnattributed: unattributed } });
  const order = { id: 0, intentId: intentRow, venue, symbol, side, qty, clientId: cid, tSentNs: nowNs(), status: "PENDING" as OrderStatus };
  order.id = deps.ledger.insertOrderPending(order);
  return order;
}

async function closeEmergency(deps: KillDeps, venue: "futures" | "spot", symbol: string, side: "BUY" | "SELL", qty: number, engine: EngineId, unattributed = false): Promise<void> {
  const order = emergencyOrder(deps, venue, symbol, side, qty, engine, unattributed);
  const bus = deps.bus ?? defaultBus;
  try {
    const row = venue === "futures"
      ? await deps.futuresRest!.order({ symbol, side, type: "MARKET", quantity: qty, reduceOnly: true, newClientOrderId: order.clientId })
      : await deps.spotRest!.order({ symbol, side, type: "MARKET", quantity: qty, newClientOrderId: order.clientId });
    order.status = row.status as OrderStatus;
    deps.ledger.updateOrderAck(order.id, { extId: String(row.orderId), status: order.status, tAckNs: nowNs(), latencyMs: (nowNs() - order.tSentNs) / 1e6, json: JSON.stringify({ ack: row }) });
    bus.emit("exec.order", { ...order, extId: String(row.orderId) });
    await recoverFills({ ledger: deps.ledger, futuresRest: venue === "futures" ? deps.futuresRest! : undefined, spotRest: venue === "spot" ? deps.spotRest! : undefined, futuresSymbols: [symbol], spotSymbols: [symbol], bus });
    const filled = deps.ledger.db.query<{ qty: number }, [number]>("SELECT COALESCE(SUM(qty), 0) AS qty FROM fills WHERE order_id = ?").get(order.id)?.qty ?? 0;
    if (filled + 1e-12 < Number(row.executedQty)) throw new Error(`emergency fill not yet reconciled: ${order.clientId}`);
  } catch (err) {
    if (err instanceof BinanceError && err.status >= 400 && err.status < 500 && err.code !== -1007 && err.code !== -1006) order.status = "FAILED";
    deps.ledger.updateOrderStatus(order.id, order.status, JSON.stringify({ error: errText(err) }));
    throw err;
  }
}

async function flattenFutures(deps: KillDeps, rest: FuturesRest, roundQty: RoundQty): Promise<void> {
  await syncVenueOrders(deps, "futures");
  const open = await rest.openOrders();
  for (const symbol of new Set(open.map((o) => o.symbol))) {
    const cancel = emergencyOrder(deps, "futures", symbol, "SELL", 0, "basis", true);
    deps.ledger.updateOrderStatus(cancel.id, "PENDING", JSON.stringify({ action: "cancelAll" }));
    await rest.cancelAllOpenOrders(symbol);
    deps.ledger.updateOrderStatus(cancel.id, "CANCELED", JSON.stringify({ executedQty: 0 }));
  }
  await syncVenueOrders(deps, "futures");
  for (const p of await rest.positionRisk()) {
    let remaining = Math.abs(Number(p.positionAmt));
    if (remaining === 0) continue;
    const side = Number(p.positionAmt) > 0 ? "SELL" : "BUY";
    const owned = deps.positions?.snapshot().filter((pos) => pos.venue === "futures" && pos.symbol === p.symbol && (pos.qty > 0) === (side === "SELL")).map((pos) => ({ engine: pos.engine, qty: Math.abs(pos.qty) })) ?? [];
    for (const pos of owned) {
      const qty = roundQty("futures", p.symbol, Math.min(remaining, pos.qty));
      if (qty <= 0) continue;
      await closeEmergency(deps, "futures", p.symbol, side, qty, pos.engine);
      remaining -= qty;
    }
    const qty = roundQty("futures", p.symbol, remaining);
    if (qty > 0) await closeEmergency(deps, "futures", p.symbol, side, qty, "basis", true);
  }
}

async function verifyFutures(rest: FuturesRest, dust: (venue: Venue, symbol: string) => number): Promise<Residue[]> {
  const out: Residue[] = [];
  for (const p of await rest.positionRisk()) {
    const qty = Number(p.positionAmt);
    if (Math.abs(qty) > dust("futures", p.symbol)) out.push({ symbol: p.symbol, qty });
  }
  const open = await rest.openOrders();
  for (const o of open) if (!out.some((r) => r.symbol === o.symbol)) out.push({ symbol: o.symbol, qty: 0 });
  return out;
}

// ---- spot -----------------------------------------------------------------

/** Base assets kill is responsible for: engine-attributed symbols, or every non-quote balance when flatten-all is on. S07: use attributed qty, not whole account balance. */
function spotTargets(deps: KillDeps, balances: Array<{ asset: string; free: string; locked: string }>, quote: string): Array<{ symbol: string; base: string; free: number; locked: number; attributedQty: number }> {
  const out: Array<{ symbol: string; base: string; free: number; locked: number; attributedQty: number }> = [];
  if (deps.env.killFlattenAllSpot) {
    for (const b of balances) {
      if (b.asset === quote) continue;
      const free = Number(b.free);
      const locked = Number(b.locked);
      if (free + locked <= 0) continue;
      out.push({ symbol: `${b.asset}${quote}`, base: b.asset, free, locked, attributedQty: free + locked });
    }
    return out;
  }
  if (deps.positions === null) return out;
  for (const r of deps.positions.attributed("spot")) {
    if (!r.symbol.endsWith(quote)) continue;
    const base = r.symbol.slice(0, -quote.length);
    const b = balances.find((x) => x.asset === base);
    const free = b === undefined ? 0 : Number(b.free);
    const locked = b === undefined ? 0 : Number(b.locked);
    // S07: sell only the attributed qty, capped by the available balance.
    const attributedQty = Math.min(Math.max(0, r.qty), free + locked);
    out.push({ symbol: r.symbol, base, free, locked, attributedQty });
  }
  return out;
}

async function flattenSpot(deps: KillDeps, rest: SpotRest, quote: string, roundQty: RoundQty, dust: Dust, ledger: Ledger): Promise<void> {
  await syncVenueOrders(deps, "spot");
  const open = await rest.openOrders();
  const symbols = new Set<string>();
  for (const o of open) symbols.add(o.symbol);
  for (const s of symbols) {
    const cancel = emergencyOrder(deps, "spot", s, "SELL", 0, "basis", true);
    ledger.updateOrderStatus(cancel.id, "PENDING", JSON.stringify({ action: "cancelAll" }));
    await rest.cancelOpenOrders(s);
    ledger.updateOrderStatus(cancel.id, "CANCELED", JSON.stringify({ executedQty: 0 }));
  }
  await syncVenueOrders(deps, "spot");
  const acct = await rest.account();
  for (const t of spotTargets(deps, acct.balances, quote)) {
    // S07: sell only the attributed qty (or whole account when flatten-all is on).
    const sellQty = t.attributedQty;
    if (sellQty <= dust("spot", t.symbol)) continue;
    const size = roundQty("spot", t.symbol, sellQty);
    if (size <= 0) continue;
    let remaining = size;
    const owned = deps.positions?.snapshot().filter((p) => p.venue === "spot" && p.symbol === t.symbol && p.qty > 0).map((p) => ({ engine: p.engine, qty: p.qty })) ?? [];
    for (const pos of owned) {
      const qty = roundQty("spot", t.symbol, Math.min(remaining, pos.qty));
      if (qty <= 0) continue;
      await closeEmergency(deps, "spot", t.symbol, "SELL", qty, pos.engine);
      remaining -= qty;
    }
    if (deps.env.killFlattenAllSpot && remaining > 0) await closeEmergency(deps, "spot", t.symbol, "SELL", remaining, "basis", true);
  }
}

async function verifySpot(deps: KillDeps, rest: SpotRest, quote: string, dust: (venue: Venue, symbol: string) => number): Promise<Residue[]> {
  const acct = await rest.account();
  const out: Residue[] = [];
  for (const t of spotTargets(deps, acct.balances, quote)) {
    const total = t.attributedQty;
    if (total > dust("spot", t.symbol)) out.push({ symbol: t.symbol, qty: total });
  }
  const open = await rest.openOrders();
  for (const o of open) if (!out.some((r) => r.symbol === o.symbol)) out.push({ symbol: o.symbol, qty: 0 });
  return out;
}

// ---- dex ------------------------------------------------------------------

/**
 * Reverse-swaps engine-attributed DEX exposure per (engine, symbol). No user stream exists on-chain,
 * so the reversal is written as intent + order + fill rows and emitted as `exec.fill` for Positions.
 */
async function flattenDex(deps: KillDeps, positions: Positions, bus: Bus, roundQty: RoundQty): Promise<Residue[]> {
  const held = positions.attributed("dex");
  if (held.length === 0) return held;
  if (deps.onchain === null) {
    log.error("dex residue with no adapter; manual action required", { residue: held });
    return held;
  }
  const residue: Residue[] = [];
  for (const pos of positions.snapshot().slice()) {
    if (pos.venue !== "dex" || pos.qty === 0) continue;
    const qty = roundQty("dex", pos.symbol, Math.abs(pos.qty));
    const side = pos.qty > 0 ? "SELL" : "BUY";
    const intent: Intent = { id: `kill-${wallMs()}-${pos.engine}-${pos.symbol}`, engine: pos.engine, venue: "dex", symbol: pos.symbol, side, qty, type: "MARKET", ttlMs: 0, paper: false, tSignalNs: nowNs() };
    // S06: write durable intent + order identity BEFORE the on-chain mutation.
    const intentRow = deps.ledger.insertIntent(intent);
    const tSent = nowNs();
    const clientId = `hydra-${pos.engine}-${intent.id}`;
    const orderId = deps.ledger.insertOrderPending({ intentId: intentRow, venue: "dex", symbol: pos.symbol, side, qty, clientId, tSentNs: tSent });
    try {
      const swap = await deps.onchain.swap(intent);
      deps.ledger.updateOrderAck(orderId, { extId: swap.txOrRef, status: "FILLED", tAckNs: nowNs(), latencyMs: (nowNs() - tSent) / 1e6 });
      const fill: Fill = { orderId, venue: "dex", symbol: pos.symbol, tradeId: swap.txOrRef, side, price: swap.price, qty: swap.qty, fee: swap.fee, feeAsset: "USD", tsNs: nowNs() };
      if (deps.ledger.insertFill(fill) !== null) bus.emit("exec.fill", fill);
      log.warn("dex reversed", { engine: pos.engine, symbol: pos.symbol, qty: pos.qty, tx: swap.txOrRef });
    } catch (err) {
      deps.ledger.updateOrderStatus(orderId, "FAILED", JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      log.error("dex reverse swap failed; residue recorded", { engine: pos.engine, symbol: pos.symbol, qty: pos.qty, error: err instanceof Error ? err.message : String(err) });
      residue.push({ symbol: pos.symbol, qty: pos.qty });
    }
  }
  for (const r of positions.attributed("dex")) if (!residue.some((x) => x.symbol === r.symbol)) residue.push(r);
  return residue;
}
