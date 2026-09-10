// Risk kernel: rules 0–10 in a fixed array, first fail wins. The hot path is allocation-light —
// the per-leg context is one preallocated object, allowed-symbol tables are built once from risk.yaml
// (code-owned, file-only), and kill.lock is re-read at most every 250 ms. Rules 4–7 reason about
// the *post-trade* state, so legs that shrink exposure are never blocked by a cap they are moving
// away from. Every veto is written to `vetoes` and emitted as `kernel.veto`.

import { bus as defaultBus, type Bus } from "../core/bus.ts";
import { nowNs, wallMs } from "../core/clock.ts";
import type { EnginesConfig, RiskConfig } from "../core/config.ts";
import type { Ledger } from "../core/ledger.ts";
import { type EffectiveLimits, isPaused } from "../core/limits.ts";
import { logger } from "../core/log.ts";
import { readKillLock } from "../core/state.ts";
import type { Budgets, EngineId, Intent, Order, Venue, Veto } from "../core/types.ts";
import type { AuditCache } from "./audit-cache.ts";

const log = logger("kernel");

/** Slice of the feed hub the kernel reads; `FeedHub` satisfies it structurally. */
export interface FeedView {
  book(symbol: string): { synced: boolean; ageMs: number; bestBid: number; bestAsk: number; mid: number } | null;
  mark(symbol: string): { mark: number; index: number } | null;
}

/** Slice of `Positions` the kernel reads (tests stub it). */
export interface KernelPositions {
  nav(): number;
  netDeltaUsd(paper?: boolean): number;
  grossNotionalUsd(venue: Venue, paper?: boolean): number;
  openNotional(engine: EngineId): number;
  qty(venue: Venue, engine: EngineId, symbol: string): number;
  symbolQty(venue: Venue, symbol: string, paper?: boolean): number;
  liqPrice(symbol: string): number;
  mark(venue: Venue, symbol: string): number;
  drawdownPct(): number;
  paperOpenNotional?(engine: EngineId): number;
  paperQty?(venue: Venue, engine: EngineId, symbol: string): number;
  readonly entriesBlocked?: boolean;
}

export interface KernelDeps {
  stateDir: string;
  risk: RiskConfig;
  engines: () => EnginesConfig;
  limits: () => EffectiveLimits;
  budgets: () => Budgets;
  positions: KernelPositions;
  feed: FeedView;
  audit: AuditCache;
  ledger: Ledger;
  /** Wall ms; drives the kill-lock cache and the orders/sec bucket. */
  clock?: () => number;
  bus?: Bus;
  /** Venue minNotional in USD (Binance rejects smaller orders); 0 or absent disables rule 11. */
  minNotional?: (venue: Venue, symbol: string) => number;
  /** True when the venue's REST request-weight is near the per-minute ceiling (rule 12). */
  weightNearLimit?: (venue: Venue) => boolean;
}

export const KILL_LOCK_TTL_MS = 250;
/** A LIMIT order needs a book younger than this. */
export const MAX_BOOK_AGE_MS = 2000;
/** Maintenance margin estimate (percent of notional) when the venue has not reported a liq price. */
const MAINT_MARGIN_PCT = 0.5;
/** Order-rate ceilings (orders/sec) from Binance limits: spot 50/10s, futures 300/10s; DEX has no CEX cap. */
const VENUE_ORDER_CEILING_PER_S: Record<Venue, number> = { futures: 30, spot: 5, dex: Number.POSITIVE_INFINITY };
const VENUES: readonly Venue[] = ["futures", "spot", "dex"];

interface Ctx {
  nowMs: number;
  limits: EffectiveLimits;
  engines: EnginesConfig;
  budgets: Budgets;
  /** Reference price for the leg (LIMIT price, else mark / mid / last position mark). */
  price: number;
  notional: number;
  /** +notional for BUY, -notional for SELL. */
  signed: number;
  /** Change in the engine's |qty|·price on (venue, symbol); <= 0 means the leg reduces exposure. */
  deltaAbs: number;
  /** Orders/sec tokens taken per venue while evaluating this intent (refunded on veto). */
  taken: Record<Venue, number>;
}

type Rule = (i: Intent, c: Ctx) => string | null;

export class Kernel {
  private readonly stateDir: string;
  private readonly risk: RiskConfig;
  private readonly engines: () => EnginesConfig;
  private readonly limits: () => EffectiveLimits;
  private readonly budgets: () => Budgets;
  private readonly positions: KernelPositions;
  private readonly feed: FeedView;
  private readonly audit: AuditCache;
  private readonly ledger: Ledger;
  private readonly clock: () => number;
  private readonly bus: Bus;
  private readonly allowed: Record<Venue, Record<string, true>>;

  private killed = false;
  private killCheckedAt = Number.NEGATIVE_INFINITY;
  private readonly buckets: Record<Venue, { tokens: number; at: number }>;
  private readonly minNotional: ((venue: Venue, symbol: string) => number) | null;
  private readonly weightNearLimit: ((venue: Venue) => boolean) | null;
  /** Outstanding orders are independent execution possibilities, not nettable hedges. */
  private readonly reservations = new Map<string, { intent: Intent; price: number; qty: number; orderId?: number }>();
  private readonly orderIds = new Map<number, string>();
  private readonly disposers: Array<() => void> = [];
  /** S08: latched kill state; set on system.kill event (in-process, not just lock TTL). */
  killedInProcess = false;

  private readonly ctx: Ctx = {
    nowMs: 0,
    limits: undefined as unknown as EffectiveLimits,
    engines: undefined as unknown as EnginesConfig,
    budgets: {},
    price: 0,
    notional: 0,
    signed: 0,
    deltaAbs: 0,
    taken: { futures: 0, spot: 0, dex: 0 },
  };

  constructor(deps: KernelDeps) {
    this.stateDir = deps.stateDir;
    this.risk = deps.risk;
    this.engines = deps.engines;
    this.limits = deps.limits;
    this.budgets = deps.budgets;
    this.positions = deps.positions;
    this.feed = deps.feed;
    this.audit = deps.audit;
    this.ledger = deps.ledger;
    this.clock = deps.clock ?? wallMs;
    this.bus = deps.bus ?? defaultBus;
    this.allowed = {
      futures: whitelist(deps.risk.allowed_symbols.futures),
      spot: whitelist(deps.risk.allowed_symbols.spot),
      dex: whitelist(deps.risk.allowed_symbols.dex),
    };
    const cap = deps.risk.max_orders_per_sec;
    const at = this.clock();
    this.buckets = { futures: { tokens: cap, at }, spot: { tokens: cap, at }, dex: { tokens: cap, at } };
    this.minNotional = deps.minNotional ?? null;
    this.weightNearLimit = deps.weightNearLimit ?? null;
    this.disposers.push(
      this.bus.on("system.kill", () => { this.killedInProcess = true; }),
      this.bus.on("exec.order", (order) => this.settle(order)),
      this.bus.on("system.kill.cleared", () => {
        if (readKillLock(this.stateDir) !== null) return;
        this.killedInProcess = false;
        this.killed = false;
        this.killCheckedAt = this.clock();
      }),
    );
    for (const order of this.ledger.openOrders()) {
      if (!(order.qty > 0)) continue;
      const row = this.ledger.db.query<{ json: string }, [number]>("SELECT json FROM intents WHERE id = ?").get(order.intentId);
      if (row === null) continue;
      const source = JSON.parse(row.json) as Intent;
      const intent: Intent = { ...source, id: `order:${order.id}`, venue: order.venue, symbol: order.symbol, side: order.side, qty: order.qty };
      const price = order.price ?? this.refPrice(intent);
      this.reservations.set(intent.id, { intent, price: price > 0 ? price : Number.POSITIVE_INFINITY, qty: order.qty, orderId: order.id });
      this.orderIds.set(order.id, intent.id);
    }
  }

  stop(): void {
    for (const off of this.disposers.splice(0)) off();
  }

  /** Atomic admission: successful evaluation owns every leg before the first await. */
  admit(intent: Intent): Veto | null {
    return this.check(intent, true);
  }

  /** Only an unsent leg may be explicitly released by the executor. */
  release(intentId: string): void {
    const r = this.reservations.get(intentId);
    if (r !== undefined && r.orderId === undefined) this.reservations.delete(intentId);
  }

  private settle(order: Order): void {
    let id = this.orderIds.get(order.id);
    if (id === undefined) {
      const row = this.ledger.db.query<{ id: string }, [number]>("SELECT json_extract(json, '$.id') AS id FROM intents WHERE id = ?").get(order.intentId);
      if (row === null) return;
      const r = this.reservations.get(row.id);
      if (r === undefined || (r.orderId !== undefined && r.orderId !== order.id)) return;
      id = row.id;
      r.orderId = order.id;
      this.orderIds.set(order.id, id);
    }
    // Refresh on the next admission, after all exec.fill consumers have applied this event.
  }

  private refreshReservations(): void {
    for (const [id, r] of this.reservations) {
      if (r.orderId === undefined) continue;
      const row = this.ledger.db.query<{ status: string; executed: number | null; ackExecuted: number | null; filled: number }, [number]>(
        `SELECT status, json_extract(json, '$.executedQty') AS executed, json_extract(json, '$.ack.executedQty') AS ackExecuted,
         (SELECT COALESCE(SUM(qty), 0) FROM fills WHERE order_id = orders.id) AS filled FROM orders WHERE id = ?`,
      ).get(r.orderId);
      if (row === null) continue;
      const terminal = ["FILLED", "PAPER", "CANCELED", "REJECTED", "FAILED", "EXPIRED"].includes(row.status);
      // A terminal ACK can precede the trade stream. Keep the executed-but-unaccounted part.
      const total = terminal ? Math.max(Number(row.executed ?? row.ackExecuted ?? r.intent.qty), Number(row.ackExecuted ?? 0)) : r.intent.qty;
      r.qty = Math.max(0, total - row.filled);
      if (r.qty <= 1e-12) {
        this.reservations.delete(id);
        this.orderIds.delete(r.orderId);
      }
    }
  }

  reservedNotional(engine: EngineId, paper = false): number {
    let total = 0;
    for (const r of this.reservations.values()) if (r.intent.engine === engine && r.intent.paper === paper) total += r.qty * r.price;
    return total;
  }

  private reserved(venue: Venue | null, paper: boolean, side?: "BUY" | "SELL", symbol?: string): number {
    let total = 0;
    for (const r of this.reservations.values()) {
      if (r.intent.paper !== paper || (venue !== null && r.intent.venue !== venue) || (side !== undefined && r.intent.side !== side) || (symbol !== undefined && r.intent.symbol !== symbol)) continue;
      total += r.qty * r.price;
    }
    return total;
  }

  /** First failing rule wins; multi-leg intents are evaluated leg by leg and vetoed as a whole. */
  evaluate(intent: Intent): Veto | null {
    return this.check(intent, false);
  }

  private check(intent: Intent, retain: boolean): Veto | null {
    this.refreshReservations();
    // S08: In-process kill latch — faster than the TTL-cached lock check.
    if (this.killedInProcess) {
      const veto: Veto = { intentId: intent.id, engine: intent.engine, rule: 0, detail: "kill barrier latched", tsNs: nowNs() };
      this.ledger.insertVeto(veto);
      this.bus.emit("kernel.veto", veto);
      return veto;
    }
    const c = this.ctx;
    c.nowMs = this.clock();
    c.limits = this.limits();
    c.engines = this.engines();
    c.budgets = this.budgets();
    c.taken.futures = 0;
    c.taken.spot = 0;
    c.taken.dex = 0;
    const legs = intent.legs?.length ? intent.legs : [intent];
    const added: string[] = [];
    let veto: Veto | null = null;
    for (let n = 0; n < legs.length; n++) {
      const leg = legs[n] as Intent;
      if (this.reservations.has(leg.id)) {
        veto = { intentId: intent.id, engine: intent.engine, rule: 4, detail: "intent already reserved", tsNs: nowNs() };
        break;
      }
      veto = this.evaluateLeg(leg, c, intent, legs.length === 1 ? -1 : n);
      if (veto !== null) break;
      this.reservations.set(leg.id, { intent: leg, price: c.price, qty: leg.qty });
      added.push(leg.id);
    }
    if (veto !== null || !retain) for (const id of added) this.reservations.delete(id);
    if (veto === null) return null;
    for (const v of VENUES) this.buckets[v].tokens += c.taken[v];
    this.ledger.insertVeto(veto);
    this.bus.emit("kernel.veto", veto);
    log.debug("veto", { intent: veto.intentId, engine: veto.engine, rule: veto.rule, detail: veto.detail });
    return veto;
  }

  private evaluateLeg(leg: Intent, c: Ctx, root: Intent, n: number): Veto | null {
    this.prime(leg, c);
    const rules = this.rules;
    for (let r = 0; r < rules.length; r++) {
      const detail = (rules[r] as Rule)(leg, c);
      if (detail === null) continue;
      return {
        intentId: root.id,
        engine: root.engine,
        rule: r,
        detail: n < 0 ? detail : `leg ${n} ${leg.venue}:${leg.symbol}: ${detail}`,
        tsNs: nowNs(),
      };
    }
    return null;
  }

  private prime(i: Intent, c: Ctx): void {
    const price = this.refPrice(i);
    c.price = price;
    c.notional = price > 0 ? i.qty * price : 0;
    c.signed = i.side === "BUY" ? c.notional : -c.notional;
    const old = i.paper && this.positions.paperQty !== undefined ? this.positions.paperQty(i.venue, i.engine, i.symbol) : this.positions.qty(i.venue, i.engine, i.symbol);
    let pending = 0;
    for (const r of this.reservations.values()) {
      if (r.intent.paper === i.paper && r.intent.engine === i.engine && r.intent.venue === i.venue && r.intent.symbol === i.symbol && r.intent.side === i.side) pending += r.qty;
    }
    const sign = i.side === "BUY" ? 1 : -1;
    const next = old + sign * i.qty;
    c.deltaAbs = Math.max(Math.abs(next) - Math.abs(old), Math.abs(old + sign * (pending + i.qty)) - Math.abs(old + sign * pending)) * price;
  }

  private refPrice(i: Intent): number {
    if (i.type === "LIMIT" && i.price !== undefined && i.price > 0) return i.price;
    if (i.venue === "futures") {
      const m = this.feed.mark(i.symbol);
      if (m !== null && m.mark > 0) return m.mark;
    }
    const b = this.feed.book(i.symbol);
    if (b !== null && b.synced && b.mid > 0) return b.mid;
    return this.positions.mark(i.venue, i.symbol);
  }

  /** NAV the caps are measured against: live NAV, never more than the operator's nav_usd_cap. */
  private navBase(c: Ctx): number {
    const nav = this.positions.nav();
    return nav < c.limits.nav_usd_cap ? nav : c.limits.nav_usd_cap;
  }

  // ---- rules ----------------------------------------------------------------

  /** 0: no kill.lock (re-read at most every 250 ms). */
  private readonly r0: Rule = (i, c) => {
    if (!i.paper && this.positions.entriesBlocked) return "venue accounting unresolved";
    if (c.nowMs - this.killCheckedAt >= KILL_LOCK_TTL_MS) {
      this.killed = readKillLock(this.stateDir) !== null;
      this.killCheckedAt = c.nowMs;
    }
    return this.killed ? "kill.lock present" : null;
  };

  /** 1: engine enabled, not paused, effective size cap > 0. */
  private readonly r1: Rule = (i, c) => {
    const eng = c.engines.engines[i.engine];
    if (eng === undefined || !eng.enabled) return "engine disabled";
    if (isPaused(c.limits, i.engine)) return "engine paused";
    if (!(c.limits.per_engine_max_notional_usd[i.engine] > 0)) return "engine size cap is 0";
    return null;
  };

  /** 2: symbol whitelisted for the venue (risk.yaml, code-owned). */
  private readonly r2: Rule = (i) => (this.allowed[i.venue][i.symbol] === true ? null : "symbol not in allowed_symbols");

  /** 3: per-venue orders/sec token bucket. Real orders honour the Binance venue ceiling; paper legs
   *  never hit the exchange, so they are throttled only by the configured max_orders_per_sec. */
  private readonly r3: Rule = (i, c) => {
    const cap = i.paper ? c.limits.max_orders_per_sec : Math.min(c.limits.max_orders_per_sec, VENUE_ORDER_CEILING_PER_S[i.venue]);
    const b = this.buckets[i.venue];
    const dt = c.nowMs - b.at;
    if (dt > 0) {
      b.at = c.nowMs;
      b.tokens += (dt * cap) / 1000;
    }
    if (b.tokens > cap) b.tokens = cap;
    if (b.tokens < 1) return `${i.venue} orders/sec cap reached`;
    b.tokens -= 1;
    c.taken[i.venue] += 1;
    return null;
  };

  /** 4: notional <= min(engine cap, budget) - open notional - in-flight reservations (S03; reducing legs exempt). */
  private readonly r4: Rule = (i, c) => {
    if (!(c.price > 0)) return "no reference price";
    if (c.deltaAbs <= 0) return null;
    const engineCap = c.limits.per_engine_max_notional_usd[i.engine] > 0 ? c.limits.per_engine_max_notional_usd[i.engine] : this.navBase(c);
    const budget = c.budgets[i.engine];
    const cap = typeof budget === "number" && budget > 0 ? Math.min(budget, engineCap) : engineCap;
    // S03: subtract in-flight reserved notional so concurrent/sequential intents cannot both see the same room.
    const open = i.paper && this.positions.paperOpenNotional !== undefined ? this.positions.paperOpenNotional(i.engine) : this.positions.openNotional(i.engine);
    const room = cap - open - this.reservedNotional(i.engine, i.paper);
    return c.notional > room ? `notional ${c.notional.toFixed(2)} > room ${room.toFixed(2)}` : null;
  };

  /** 5: |post-trade net delta| <= NAV * max_net_delta_pct (unless the leg shrinks it). */
  private readonly r5: Rule = (i, c) => {
    const base = this.positions.netDeltaUsd(i.paper);
    const low = base - this.reserved(null, i.paper, "SELL");
    const high = base + this.reserved(null, i.paper, "BUY");
    const pre = Math.max(Math.abs(low), Math.abs(high));
    const post = Math.max(Math.abs(low + c.signed), Math.abs(high + c.signed));
    if (post <= pre) return null;
    const cap = (this.navBase(c) * c.limits.max_net_delta_pct) / 100;
    return post > cap ? `net delta ${post.toFixed(2)} exceeds ${cap.toFixed(2)}` : null;
  };

  /** 6: post-trade futures leverage <= max_leverage. */
  private readonly r6: Rule = (i, c) => {
    if (i.venue !== "futures" || c.deltaAbs <= 0) return null;
    const nav = this.navBase(c);
    if (!(nav > 0)) return "nav <= 0";
    const lev = (this.positions.grossNotionalUsd("futures", i.paper) + this.reserved("futures", i.paper) + c.deltaAbs) / nav;
    return lev > c.limits.max_leverage ? `leverage ${lev.toFixed(2)} > ${c.limits.max_leverage}` : null;
  };

  /** 7: futures liq distance >= min_liq_distance_pct (venue liq price when known, else cross-margin estimate). */
  private readonly r7: Rule = (i, c) => {
    if (i.venue !== "futures" || c.deltaAbs <= 0) return null;
    const old = this.positions.symbolQty("futures", i.symbol, i.paper);
    const pending = this.reserved("futures", i.paper, i.side, i.symbol) / c.price;
    const next = old + (i.side === "BUY" ? i.qty + pending : -i.qty - pending);
    if (next === 0) return null;
    const nav = this.navBase(c);
    if (!(nav > 0)) return "nav <= 0";
    const gross = this.positions.grossNotionalUsd("futures", i.paper) + this.reserved("futures", i.paper) + c.deltaAbs;
    const symbolNotional = Math.abs(next) * c.price;
    let dist = (100 * (nav - (MAINT_MARGIN_PCT / 100) * gross)) / symbolNotional;
    const liq = this.positions.liqPrice(i.symbol);
    if (liq > 0 && old !== 0 && (old > 0) === (next > 0)) {
      const reported = (Math.abs(c.price - liq) / c.price) * 100;
      if (reported < dist) dist = reported;
    }
    return dist < c.limits.min_liq_distance_pct ? `liq distance ${dist.toFixed(2)}% < ${c.limits.min_liq_distance_pct}%` : null;
  };

  /** 8: daily drawdown below the kill threshold. */
  private readonly r8: Rule = (_i, c) => {
    const dd = this.positions.drawdownPct();
    return dd >= c.limits.daily_drawdown_kill_pct ? `daily drawdown ${dd.toFixed(2)}% >= ${c.limits.daily_drawdown_kill_pct}%` : null;
  };

  /** 9: DEX legs need a fresh PASS audit and stay under the on-chain notional cap. */
  private readonly r9: Rule = (i, c) => {
    if (i.venue !== "dex") return null;
    if (!this.audit.fresh(i.symbol, this.risk.audit_ttl_sec)) return "on-chain audit missing, failed or stale";
    if (c.deltaAbs <= 0) return null;
    const post = this.positions.grossNotionalUsd("dex", i.paper) + this.reserved("dex", i.paper) + c.deltaAbs;
    return post > c.limits.onchain_max_notional_usd ? `on-chain notional ${post.toFixed(2)} > ${c.limits.onchain_max_notional_usd}` : null;
  };

  /** 10: LIMIT legs need a synced book younger than 2 s. */
  private readonly r10: Rule = (i) => {
    if (i.type !== "LIMIT") return null;
    const b = this.feed.book(i.symbol);
    if (b === null || !b.synced) return "book not synced";
    return b.ageMs < MAX_BOOK_AGE_MS ? null : `book stale (${Math.round(b.ageMs)} ms)`;
  };

  /** 11: order notional >= venue minNotional; Binance rejects smaller orders outright. */
  private readonly r11: Rule = (i, c) => {
    if (this.minNotional === null || !(c.notional > 0)) return null;
    const min = this.minNotional(i.venue, i.symbol);
    return min > 0 && c.notional < min ? `notional ${c.notional.toFixed(2)} < venue min ${min.toFixed(2)}` : null;
  };

  /** 12: back off new (non-paper) orders when the venue REST request-weight nears the per-minute ceiling. */
  private readonly r12: Rule = (i) => {
    if (i.paper || this.weightNearLimit === null) return null;
    return this.weightNearLimit(i.venue) ? `${i.venue} request-weight near ceiling; backing off` : null;
  };

  private readonly rules: readonly Rule[] = [this.r0, this.r1, this.r2, this.r3, this.r4, this.r5, this.r6, this.r7, this.r8, this.r9, this.r10, this.r11, this.r12];
}

function whitelist(symbols: readonly string[]): Record<string, true> {
  const out: Record<string, true> = {};
  for (const s of symbols) out[s] = true;
  return out;
}
