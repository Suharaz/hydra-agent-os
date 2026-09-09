// Engine-attributed positions built from `exec.fill` (attribution: orders.intent_id -> intents.engine),
// marked from `feed.mark` / `feed.trade`, reconciled against REST every 10 s (diffs are logged, never
// silently adopted). A FIFO lot queue per (venue, engine, symbol) closes round trips into `trades`
// and upserts `pnl_daily`. NAV = cash + spot holdings at mark + futures unrealized; the day anchor
// (NAV at 00:00 UTC, restored at boot from pnl_daily) drives the drawdown rule and the Guardian.

import { bus as defaultBus, type Bus } from "../core/bus.ts";
import { nowNs, utcDate } from "../core/clock.ts";
import type { Ledger } from "../core/ledger.ts";
import { logger } from "../core/log.ts";
import type { EngineId, Fill, Position, Residue, Venue } from "../core/types.ts";
import { ENGINE_IDS } from "../core/types.ts";
import type { FuturesRest } from "../venues/binance/rest-futures.ts";
import type { SpotRest } from "../venues/binance/rest-spot.ts";

const log = logger("positions");

interface Lot {
  qty: number; // always positive
  price: number;
  fee: number;
  tsNs: number;
}

interface Pos extends Position {
  lots: Lot[];
  /** +1 long lots, -1 short lots, 0 flat. */
  dir: -1 | 0 | 1;
}

interface Daily {
  realized: number;
  fees: number;
  trades: number;
  wins: number;
  maxDdBps: number;
}

export interface VenuePosition {
  symbol: string;
  qty: number;
  entry: number;
  mark: number;
  liqPrice: number;
}

export interface ReconcileDiff {
  venue: Venue;
  symbol: string;
  ledgerQty: number;
  venueQty: number;
}

export interface ReconcileReport {
  diffs: ReconcileDiff[];
  /** Non-flat exposure on each venue as the venue reports it. */
  residue: Record<Venue, Residue[]>;
  clean: boolean;
}

export interface PositionsDeps {
  ledger: Ledger;
  futures?: FuturesRest | null;
  spot?: SpotRest | null;
  bus?: Bus;
  quoteAsset?: string;
  /** Spot symbols the venue may hold on our behalf (risk.yaml allowed_symbols.spot). */
  spotSymbols?: readonly string[];
  reconcileMs?: number;
  snapMs?: number;
  /** Below this |qty| a venue balance is dust, not a position. */
  dust?: (venue: Venue, symbol: string) => number;
}

function posKey(venue: Venue, engine: EngineId, symbol: string): string {
  return `${venue}:${engine}:${symbol}`;
}

export class Positions {
  private readonly ledger: Ledger;
  private readonly futures: FuturesRest | null;
  private readonly spot: SpotRest | null;
  private readonly bus: Bus;
  private readonly quote: string;
  private readonly spotSymbols: readonly string[];
  private readonly reconcileMs: number;
  private readonly snapMs: number;
  private readonly dust: (venue: Venue, symbol: string) => number;

  private readonly byKey = new Map<string, Pos>();
  /** S01: Paper fills tracked separately; never mixed into NAV, openNotional, attributed, or kill targets. */
  private readonly paperByKey = new Map<string, Pos>();
  private readonly marks = new Map<string, number>();
  private readonly liq = new Map<string, number>();
  private readonly venueFutures = new Map<string, VenuePosition>();
  private readonly venueSpot = new Map<string, number>();
  private readonly daily = new Map<EngineId, Daily>();
  private readonly snap: Position[] = [];
  private readonly engineByOrder = new Map<number, EngineId>();
  /** S01: Cache paper-flag per order id to avoid repeated DB reads. */
  private readonly paperByOrder = new Map<number, boolean>();
  private readonly stEngine;
  private readonly stPaper;

  private cash = 0;
  private day = utcDate();
  private anchor: number | null = null;
  private disposers: Array<() => void> = [];
  private reconcileTimer: Timer | null = null;
  private snapTimer: Timer | null = null;
  private reconciling: Promise<ReconcileReport> | null = null;
  private restoring = false;
  /** Fail closed until venue discrepancies have been reconciled. */
  entriesBlocked = false;

  constructor(deps: PositionsDeps) {
    this.ledger = deps.ledger;
    this.futures = deps.futures ?? null;
    this.spot = deps.spot ?? null;
    this.entriesBlocked = this.futures !== null || this.spot !== null;
    this.bus = deps.bus ?? defaultBus;
    this.quote = deps.quoteAsset ?? "USDT";
    this.spotSymbols = deps.spotSymbols ?? [];
    this.reconcileMs = deps.reconcileMs ?? 10_000;
    this.snapMs = deps.snapMs ?? 1000;
    this.dust = deps.dust ?? ((_venue, _symbol) => 1e-5);
    this.stEngine = this.ledger.db.prepare<{ engine: EngineId }, [number]>(
      "SELECT i.engine AS engine FROM orders o JOIN intents i ON i.id = o.intent_id WHERE o.id = ? AND COALESCE(json_extract(i.json, '$.killUnattributed'), 0) = 0",
    );
    // S01: detect paper orders to route fills to the paper map.
    this.stPaper = this.ledger.db.prepare<{ paper: number }, [number]>(
      "SELECT i.paper AS paper FROM orders o JOIN intents i ON i.id = o.intent_id WHERE o.id = ?",
    );
    this.loadDaily();
    this.restoreFromLedger();
  }

  // ---- lifecycle ----------------------------------------------------------

  start(): void {
    // S02: idempotent — safe to call before recoverBoot and again in stack.start().
    if (this.disposers.length > 0) return;
    this.disposers.push(
      this.bus.on("exec.fill", (f) => this.onFill(f)),
      this.bus.on("feed.mark", (m) => this.setMark("futures", m.symbol, m.mark)),
      this.bus.on("feed.trade", (t) => this.setMark(t.venue, t.symbol, t.price)),
    );
    if (this.futures !== null || this.spot !== null) {
      this.reconcileTimer = setInterval(() => void this.reconcile().catch((err) => log.warn("reconcile failed", { error: String(err) })), this.reconcileMs);
      this.reconcileTimer.unref();
    }
    this.snapTimer = setInterval(() => this.writeSnapshot(), this.snapMs);
    this.snapTimer.unref();
  }

  stop(): void {
    for (const d of this.disposers.splice(0)) d();
    if (this.reconcileTimer !== null) clearInterval(this.reconcileTimer);
    if (this.snapTimer !== null) clearInterval(this.snapTimer);
    this.reconcileTimer = null;
    this.snapTimer = null;
    this.writeSnapshot();
  }

  // ---- fills --------------------------------------------------------------

  /** orders.intent_id -> intents.engine; cached per order id. */
  attribute(orderId: number): EngineId | null {
    const hit = this.engineByOrder.get(orderId);
    if (hit !== undefined) return hit;
    const row = this.stEngine.get(orderId);
    if (row === null) return null;
    this.engineByOrder.set(orderId, row.engine);
    return row.engine;
  }

  /** S01: Returns true when the fill's order was placed as paper (never touches real risk maps). */
  private isPaper(orderId: number): boolean {
    const cached = this.paperByOrder.get(orderId);
    if (cached !== undefined) return cached;
    const row = this.stPaper.get(orderId);
    const paper = row !== null && row.paper !== 0;
    this.paperByOrder.set(orderId, paper);
    return paper;
  }

  onFill(fill: Fill): void {
    const engine = this.attribute(fill.orderId);
    if (engine === null) {
      log.warn("fill without engine attribution ignored", { orderId: fill.orderId, venue: fill.venue, symbol: fill.symbol, tradeId: fill.tradeId });
      return;
    }
    // S01: paper fills are tracked separately and never touch real NAV/risk.
    if (this.isPaper(fill.orderId)) {
      this.applyPaper(fill, engine);
      return;
    }
    this.apply(fill, engine);
  }

  /** S01: Apply a paper fill to the isolated paper accounting map. No cash/ledger writes. */
  applyPaper(fill: Fill, engine: EngineId): void {
    const key = posKey(fill.venue, engine, fill.symbol);
    let pos = this.paperByKey.get(key);
    if (pos === undefined) {
      pos = { engine, venue: fill.venue, symbol: fill.symbol, qty: 0, entry: 0, mark: fill.price, unrealized: 0, notionalUsd: 0, lots: [], dir: 0 };
      this.paperByKey.set(key, pos);
    }
    const dir: -1 | 1 = fill.side === "BUY" ? 1 : -1;
    let remaining = fill.qty;
    // Close opposing lots FIFO (paper; no ledger trade row).
    while (remaining > 0 && pos.dir === -dir && pos.lots.length > 0) {
      const lot = pos.lots[0] as Lot;
      const closeQty = Math.min(remaining, lot.qty);
      lot.qty -= closeQty;
      if (lot.qty <= 1e-12) pos.lots.shift();
      remaining -= closeQty;
    }
    if (remaining > 0) {
      pos.lots.push({ qty: remaining, price: fill.price, fee: 0, tsNs: fill.tsNs });
      pos.dir = dir;
    }
    let q = 0; let cost = 0;
    for (const l of pos.lots) { q += l.qty; cost += l.qty * l.price; }
    if (q <= 1e-12) { pos.lots.length = 0; pos.dir = 0; pos.qty = 0; pos.entry = 0; }
    else { pos.qty = q * pos.dir; pos.entry = cost / q; }
    const mark = this.marks.get(`${fill.venue}:${fill.symbol}`) ?? fill.price;
    pos.mark = mark;
    pos.notionalUsd = Math.abs(pos.qty) * mark;
    pos.unrealized = pos.qty === 0 ? 0 : (mark - pos.entry) * pos.qty;
  }

  /** S01: Gross paper exposure for an engine; used by kernel to cap paper intents. */
  paperOpenNotional(engine: EngineId): number {
    let v = 0;
    for (const pos of this.paperByKey.values()) if (pos.engine === engine) v += pos.notionalUsd;
    return v;
  }

  /** S01: Paper qty for (venue, engine, symbol). */
  paperQty(venue: Venue, engine: EngineId, symbol: string): number {
    return this.paperByKey.get(posKey(venue, engine, symbol))?.qty ?? 0;
  }

  /** Apply a fill attributed to `engine` (tests and paper paths call this directly). */
  apply(fill: Fill, engine: EngineId): void {
    this.rollDay();
    const key = posKey(fill.venue, engine, fill.symbol);
    let pos = this.byKey.get(key);
    if (pos === undefined) {
      pos = { engine, venue: fill.venue, symbol: fill.symbol, qty: 0, entry: 0, mark: fill.price, unrealized: 0, notionalUsd: 0, lots: [], dir: 0 };
      this.byKey.set(key, pos);
    }
    if (!this.marks.has(`${fill.venue}:${fill.symbol}`)) this.marks.set(`${fill.venue}:${fill.symbol}`, fill.price);
    const feeQuote = fill.feeAsset === this.quote ? fill.fee : 0;
    const dir: -1 | 1 = fill.side === "BUY" ? 1 : -1;
    let remaining = fill.qty;

    // Close opposing lots FIFO.
    while (remaining > 0 && pos.dir === -dir && pos.lots.length > 0) {
      const lot = pos.lots[0] as Lot;
      const closeQty = Math.min(remaining, lot.qty);
      const lotFee = lot.fee * (closeQty / lot.qty);
      const fillFee = feeQuote * (closeQty / fill.qty);
      const realized = (fill.price - lot.price) * closeQty * pos.dir;
      const fees = lotFee + fillFee;
      if (!this.restoring) this.ledger.insertTrade({
        engine,
        venue: fill.venue,
        symbol: fill.symbol,
        openedNs: lot.tsNs,
        closedNs: fill.tsNs,
        qty: closeQty,
        entry: lot.price,
        exit: fill.price,
        realized,
        fees,
        retBps: lot.price > 0 ? ((realized - fees) / (lot.price * closeQty)) * 10_000 : 0,
      });
      if (!this.restoring) {
        const d = this.dailyFor(engine);
        d.realized += realized;
        d.fees += fees;
        d.trades++;
        if (realized - fees > 0) d.wins++;
        this.ledger.upsertPnlDaily({ engine, date: this.day, realized: d.realized, fees: d.fees, trades: d.trades, wins: d.wins, maxDdBps: d.maxDdBps });
      }
      if (fill.venue === "futures") this.cash += realized;
      lot.qty -= closeQty;
      lot.fee -= lotFee;
      if (lot.qty <= 1e-12) pos.lots.shift();
      remaining -= closeQty;
    }
    if (remaining > 0) {
      pos.lots.push({ qty: remaining, price: fill.price, fee: feeQuote * (remaining / fill.qty), tsNs: fill.tsNs });
      pos.dir = dir;
    }

    // Cash: spot moves quote for the whole fill; futures pays fee only (realized added above).
    if (fill.venue === "spot") this.cash += fill.side === "BUY" ? -fill.price * fill.qty - feeQuote : fill.price * fill.qty - feeQuote;
    else if (fill.venue === "futures") this.cash -= feeQuote;

    // Recompute qty/entry from lots.
    let q = 0;
    let cost = 0;
    for (const l of pos.lots) {
      q += l.qty;
      cost += l.qty * l.price;
    }
    if (q <= 1e-12) {
      pos.lots.length = 0;
      pos.dir = 0;
      pos.qty = 0;
      pos.entry = 0;
    } else {
      pos.qty = q * pos.dir;
      pos.entry = cost / q;
    }
    this.refresh(pos);
  }

  /** Rebuild FIFO lots without duplicating durable realized accounting. Safe to repeat before start. */
  restoreFromLedger(): number {
    this.byKey.clear();
    this.paperByKey.clear();
    this.cash = 0;
    const rows = this.ledger.db
      .query<
        { order_id: number; venue: Venue; symbol: string; side: "BUY" | "SELL"; trade_id: string; price: number; qty: number; fee: number; fee_asset: string; ts_ns: number },
        []
      >(
        `SELECT f.order_id, f.venue, f.symbol, f.side, f.trade_id, f.price, f.qty, f.fee, f.fee_asset, f.ts_ns
         FROM fills f JOIN orders o ON o.id = f.order_id JOIN intents i ON i.id = o.intent_id
         ORDER BY f.id ASC`,
      )
      .all();
    let count = 0;
    this.restoring = true;
    try {
      for (const r of rows) {
        const engine = this.attribute(r.order_id);
        if (engine === null) continue;
        const fill: Fill = { orderId: r.order_id, venue: r.venue, symbol: r.symbol, tradeId: r.trade_id, side: r.side, price: r.price, qty: r.qty, fee: r.fee, feeAsset: r.fee_asset, tsNs: r.ts_ns };
        if (this.isPaper(r.order_id)) this.applyPaper(fill, engine);
        else this.apply(fill, engine);
        count++;
      }
    } finally {
      this.restoring = false;
    }
    log.info("positions restored from fills", { count });
    return count;
  }


  // ---- marks / valuation --------------------------------------------------

  setMark(venue: Venue, symbol: string, price: number): void {
    if (!(price > 0)) return;
    this.marks.set(`${venue}:${symbol}`, price);
    for (const pos of this.byKey.values()) if (pos.venue === venue && pos.symbol === symbol) this.refresh(pos);
    for (const pos of this.paperByKey.values()) if (pos.venue === venue && pos.symbol === symbol) this.refresh(pos);
  }

  mark(venue: Venue, symbol: string): number {
    return this.marks.get(`${venue}:${symbol}`) ?? 0;
  }

  liqPrice(symbol: string): number {
    return this.liq.get(symbol) ?? 0;
  }

  private refresh(pos: Pos): void {
    const mark = this.marks.get(`${pos.venue}:${pos.symbol}`) ?? pos.entry;
    pos.mark = mark;
    pos.notionalUsd = Math.abs(pos.qty) * mark;
    pos.unrealized = pos.qty === 0 ? 0 : (mark - pos.entry) * pos.qty;
    const liq = this.liq.get(pos.symbol);
    if (pos.venue === "futures" && liq !== undefined && liq > 0) pos.liqPrice = liq;
  }

  setCash(usd: number): void {
    this.cash = usd;
  }

  get cashUsd(): number {
    return this.cash;
  }

  /** cash + spot holdings at mark + futures unrealized. */
  nav(): number {
    let v = this.cash;
    for (const pos of this.byKey.values()) {
      if (pos.qty === 0) continue;
      v += pos.venue === "futures" ? pos.unrealized : pos.qty * pos.mark;
    }
    return v;
  }

  /** Signed exposure in USD across every venue. */
  netDeltaUsd(paper = false): number {
    let v = 0;
    for (const pos of (paper ? this.paperByKey : this.byKey).values()) v += pos.qty * pos.mark;
    return v;
  }

  grossNotionalUsd(venue: Venue, paper = false): number {
    let v = 0;
    for (const pos of (paper ? this.paperByKey : this.byKey).values()) if (pos.venue === venue) v += pos.notionalUsd;
    return v;
  }

  /** Gross futures notional / NAV. */
  leverage(): number {
    const nav = this.nav();
    return nav <= 0 ? Number.POSITIVE_INFINITY : this.grossNotionalUsd("futures") / nav;
  }

  openNotional(engine: EngineId): number {
    let v = 0;
    for (const pos of this.byKey.values()) if (pos.engine === engine) v += pos.notionalUsd;
    return v;
  }

  /** Signed qty this engine holds on (venue, symbol). */
  qty(venue: Venue, engine: EngineId, symbol: string): number {
    return this.byKey.get(posKey(venue, engine, symbol))?.qty ?? 0;
  }

  /** Signed qty across engines on (venue, symbol). */
  symbolQty(venue: Venue, symbol: string, paper = false): number {
    let q = 0;
    for (const pos of (paper ? this.paperByKey : this.byKey).values()) if (pos.venue === venue && pos.symbol === symbol) q += pos.qty;
    return q;
  }

  unrealized(): number {
    let v = 0;
    for (const pos of this.byKey.values()) v += pos.unrealized;
    return v;
  }

  /** Same array every call; entries are the live position records (do not retain). */
  snapshot(): Position[] {
    this.snap.length = 0;
    for (const pos of this.byKey.values()) if (pos.qty !== 0) this.snap.push(pos);
    return this.snap;
  }

  /** Engine-attributed non-flat exposure per venue (kill/unkill residue view from the ledger side). */
  attributed(venue: Venue): Residue[] {
    const bySymbol = new Map<string, number>();
    for (const pos of this.byKey.values()) if (pos.venue === venue && pos.qty !== 0) bySymbol.set(pos.symbol, (bySymbol.get(pos.symbol) ?? 0) + pos.qty);
    const out: Residue[] = [];
    for (const [symbol, qty] of bySymbol) if (Math.abs(qty) > this.dust(venue, symbol)) out.push({ symbol, qty });
    return out;
  }

  // ---- daily pnl / drawdown -----------------------------------------------

  private loadDaily(): void {
    this.daily.clear();
    const rows = this.ledger.db
      .query<{ engine: EngineId; realized: number; fees: number; trades: number; wins: number; max_dd_bps: number }, [string]>(
        "SELECT engine, realized, fees, trades, wins, max_dd_bps FROM pnl_daily WHERE date = ?",
      )
      .all(this.day);
    for (const r of rows) this.daily.set(r.engine, { realized: r.realized, fees: r.fees, trades: r.trades, wins: r.wins, maxDdBps: r.max_dd_bps });
  }

  private dailyFor(engine: EngineId): Daily {
    let d = this.daily.get(engine);
    if (d === undefined) {
      d = { realized: 0, fees: 0, trades: 0, wins: 0, maxDdBps: 0 };
      this.daily.set(engine, d);
    }
    return d;
  }

  private rollDay(): void {
    const today = utcDate();
    if (today === this.day) return;
    this.day = today;
    this.daily.clear();
    this.anchor = this.nav();
    log.info("utc day rollover", { day: today, anchorNav: this.anchor });
  }

  /** Realized net of fees today across engines (pnl_daily). */
  realizedToday(): number {
    let v = 0;
    for (const d of this.daily.values()) v += d.realized - d.fees;
    return v;
  }

  /** NAV at 00:00 UTC; restored at boot as nav - realizedToday - unrealized. */
  dayStartNav(): number {
    this.rollDay();
    if (this.anchor === null) this.anchor = this.nav() - this.realizedToday() - this.unrealized();
    return this.anchor;
  }

  resetDayAnchor(): void {
    this.anchor = null;
  }

  /** Percent of day-start NAV lost so far; 0 when flat or up. */
  drawdownPct(): number {
    const start = this.dayStartNav();
    if (!(start > 0)) return 0;
    const dd = ((start - this.nav()) / start) * 100;
    return dd > 0 ? dd : 0;
  }

  /** Guardian hourly: raise max_dd_bps for every engine with a row today. */
  recordMaxDd(bps: number): void {
    this.rollDay();
    for (const engine of ENGINE_IDS) {
      const d = this.dailyFor(engine);
      if (bps <= d.maxDdBps) continue;
      d.maxDdBps = bps;
      this.ledger.upsertPnlDaily({ engine, date: this.day, realized: d.realized, fees: d.fees, trades: d.trades, wins: d.wins, maxDdBps: d.maxDdBps });
    }
  }

  // ---- reconcile ----------------------------------------------------------

  /** Venue-side futures positions from the last reconcile. */
  venueFuturesPositions(): VenuePosition[] {
    return [...this.venueFutures.values()];
  }

  /** Venue-side spot base balances (free + locked) from the last reconcile, keyed by symbol. */
  venueSpotBalances(): Map<string, number> {
    return this.venueSpot;
  }

  reconcile(): Promise<ReconcileReport> {
    if (this.reconciling === null) {
      this.reconciling = this.doReconcile().finally(() => {
        this.reconciling = null;
      });
    }
    return this.reconciling;
  }

  private async doReconcile(): Promise<ReconcileReport> {
    this.entriesBlocked = true;
    const diffs: ReconcileDiff[] = [];
    const residue: Record<Venue, Residue[]> = { futures: [], spot: [], dex: [] };
    let cash = 0;
    let cashKnown = false;

    if (this.futures !== null) {
      const [rows, acct] = await Promise.all([this.futures.positionRisk(), this.futures.account()]);
      this.venueFutures.clear();
      for (const r of rows) {
        const qty = Number(r.positionAmt);
        const mark = Number(r.markPrice);
        const liq = Number(r.liquidationPrice);
        if (mark > 0) this.setMark("futures", r.symbol, mark);
        if (liq > 0) this.liq.set(r.symbol, liq);
        if (qty === 0) continue;
        this.venueFutures.set(r.symbol, { symbol: r.symbol, qty, entry: Number(r.entryPrice), mark, liqPrice: liq });
        if (Math.abs(qty) > this.dust("futures", r.symbol)) residue.futures.push({ symbol: r.symbol, qty });
      }
      const symbols = new Set<string>(this.venueFutures.keys());
      for (const pos of this.byKey.values()) if (pos.venue === "futures" && pos.qty !== 0) symbols.add(pos.symbol);
      for (const symbol of symbols) {
        const ledgerQty = this.symbolQty("futures", symbol);
        const venueQty = this.venueFutures.get(symbol)?.qty ?? 0;
        if (Math.abs(ledgerQty - venueQty) > this.dust("futures", symbol)) diffs.push({ venue: "futures", symbol, ledgerQty, venueQty });
      }
      cash += Number(acct.totalWalletBalance);
      cashKnown = true;
    }

    if (this.spot !== null) {
      const acct = await this.spot.account();
      this.venueSpot.clear();
      const bases = new Map<string, number>();
      for (const b of acct.balances) {
        const total = Number(b.free) + Number(b.locked);
        if (b.asset === this.quote) cash += total;
        else if (total > 0) bases.set(b.asset, total);
      }
      cashKnown = true;
      for (const symbol of this.spotSymbols) {
        if (!symbol.endsWith(this.quote)) continue;
        const base = symbol.slice(0, -this.quote.length);
        const venueQty = bases.get(base) ?? 0;
        if (venueQty > 0) this.venueSpot.set(symbol, venueQty);
        const ledgerQty = this.symbolQty("spot", symbol);
        if (Math.abs(ledgerQty - venueQty) > this.dust("spot", symbol)) diffs.push({ venue: "spot", symbol, ledgerQty, venueQty });
        if (venueQty > this.dust("spot", symbol)) residue.spot.push({ symbol, qty: venueQty });
      }
    }

    residue.dex = this.attributed("dex");
    if (cashKnown) this.cash = cash;
    for (const d of diffs) log.warn("position diff vs venue", { venue: d.venue, symbol: d.symbol, ledgerQty: d.ledgerQty, venueQty: d.venueQty });
    // External spot inventory the ledger never bought (venueQty > ledgerQty, e.g. a testnet faucet or
    // an operator's pre-existing balance) is inert: engines only act on ledger-tracked positions, so it
    // cannot cause over-exposure. Fail closed only on genuine risk — any futures mismatch, or PHANTOM
    // spot where the ledger believes it holds more than the venue confirms (would oversell). Diffs are
    // still logged above; this never adopts venue state into the ledger.
    const blocking = diffs.filter((d) => d.venue === "futures" || d.ledgerQty > d.venueQty);
    this.entriesBlocked = blocking.length > 0;
    return { diffs, residue, clean: diffs.length === 0 && residue.futures.length === 0 && residue.spot.length === 0 };
  }

  // ---- telemetry ----------------------------------------------------------

  private writeSnapshot(): void {
    const snap = this.snapshot();
    if (snap.length === 0 && this.cash === 0) return;
    let json = `{"tsNs":${nowNs()},"nav":${this.nav()},"cash":${this.cash},"positions":[`;
    for (let i = 0; i < snap.length; i++) {
      const p = snap[i] as Position;
      if (i > 0) json += ",";
      json += `{"engine":"${p.engine}","venue":"${p.venue}","symbol":"${p.symbol}","qty":${p.qty},"entry":${p.entry},"mark":${p.mark},"unrealized":${p.unrealized},"notionalUsd":${p.notionalUsd}}`;
    }
    json += "]}";
    this.ledger.positionsSnap(json);
  }
}
