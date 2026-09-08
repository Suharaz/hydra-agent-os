// basis: perp-vs-spot basis z-score. basis = (perpMark - spotMid) / spotMid, sampled once per
// second from markPrice into a ring of `lookbackSec`; z >= zEntry shorts the perp and buys spot
// (equal notional; inverse when z <= -zEntry), z inside +-zExit or the time stop closes both legs.
// Demo: spotMid is the mainnet reference book and the spot leg is paper (testnet spot is not real
// liquidity); live: spot top of book and both legs real.

import type { EventName, HydraEvents } from "../../core/bus.ts";
import type { EngineId, Intent, MarkEvent, OpportunityContract, Side, Venue } from "../../core/types.ts";
import { Engine, type IntentDraft, type ParamsOf } from "./engine.ts";

type Params = ParamsOf<"basis">;

/** Minimum samples before a z-score is trusted (a fresh ring has no variance to speak of). */
const MIN_SAMPLES = 30;

interface Series {
  buf: Float64Array;
  head: number;
  count: number;
  sum: number;
  sumSq: number;
  lastSec: number;
  z: number;
}

let legSeq = 0;

/** Leg of a multi-venue intent; ids must be unique per leg (executor client ids derive from them). */
export function leg(engine: EngineId, venue: Venue, symbol: string, side: Side, qty: number, tSignalNs: number, paper?: boolean, price?: number): Intent {
  const l: Intent = {
    id: `${engine}-${venue}-${(++legSeq).toString(36)}-${tSignalNs.toString(36)}`,
    engine,
    venue,
    symbol,
    side,
    qty,
    type: price === undefined ? "MARKET" : "LIMIT",
    ttlMs: 5000,
    paper: paper ?? true,
    tSignalNs,
  };
  if (price !== undefined) l.price = price;
  return l;
}

export class BasisEngine extends Engine<Params> {
  readonly id: EngineId = "basis";
  readonly subscribes: readonly EventName[] = ["feed.mark"];
  private readonly series = new Map<string, Series>();
  private last: OpportunityContract | null = null;
  private entries = 0;

  protected override onConfigure(): void {
    this.series.clear();
    this.last = null;
  }

  onEvent<K extends EventName>(name: K, payload: HydraEvents[K]): void {
    if (name === "feed.mark") this.onMark(payload as MarkEvent);
  }

  override contract(): OpportunityContract | null {
    return this.last;
  }

  override stats(): Record<string, number> {
    return { ...super.stats(), entries: this.entries };
  }

  /** Current z-score for a symbol (NaN until warm); exposed for the dashboard/tests. */
  zscore(symbol: string): number {
    return this.series.get(symbol)?.z ?? Number.NaN;
  }

  private spotMid(symbol: string): number {
    if (this.ctx.mode === "demo") {
      const base = symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
      return this.ctx.feed.referenceMid(base, "USDT") ?? 0;
    }
    const t = this.ctx.feed.spotTopOfBook(symbol);
    return t === null ? 0 : (t.bid + t.ask) / 2;
  }

  private onMark(m: MarkEvent): void {
    if (!this.symbols.includes(m.symbol) || m.mark <= 0) return;
    const spot = this.spotMid(m.symbol);
    if (spot <= 0) return;
    const p = this.params;
    let s = this.series.get(m.symbol);
    if (s === undefined) {
      s = { buf: new Float64Array(p.lookbackSec), head: 0, count: 0, sum: 0, sumSq: 0, lastSec: -1, z: Number.NaN };
      this.series.set(m.symbol, s);
    }
    const sec = Math.floor(m.tsNs / 1e9);
    if (sec === s.lastSec) return; // one sample per second
    s.lastSec = sec;
    const basis = (m.mark - spot) / spot;
    if (s.count === s.buf.length) {
      const old = s.buf[s.head] as number;
      s.sum -= old;
      s.sumSq -= old * old;
    } else s.count++;
    s.buf[s.head] = basis;
    s.head = (s.head + 1) % s.buf.length;
    s.sum += basis;
    s.sumSq += basis * basis;
    if (s.count < Math.min(MIN_SAMPLES, s.buf.length)) return;
    const mean = s.sum / s.count;
    const variance = Math.max(0, s.sumSq / s.count - mean * mean);
    const std = Math.sqrt(variance);
    if (std <= 0) return;
    const z = (basis - mean) / std;
    s.z = z;

    for (const [id, o] of this.open) {
      if (o.intent.symbol !== m.symbol) continue;
      if (Math.abs(z) < p.zExit) void this.close(id, "z_exit", m.tsNs);
      return; // one position per symbol; never enter while one is open
    }
    if (Math.abs(z) < p.zEntry || this.inCooldown(m.symbol, m.tsNs)) return;

    // Rich basis: short perp, long spot. Cheap basis: the inverse.
    const perpSide: Side = z > 0 ? "SELL" : "BUY";
    const spotSide: Side = z > 0 ? "BUY" : "SELL";
    const qty = this.sizeUsd / m.mark;
    const draft: IntentDraft = {
      venue: "futures",
      symbol: m.symbol,
      side: perpSide,
      qty,
      type: "MARKET",
      tSignalNs: m.tsNs,
      legs: [leg(this.id, "futures", m.symbol, perpSide, qty, m.tsNs, this.paper), leg(this.id, "spot", m.symbol, spotSide, (qty * m.mark) / spot, m.tsNs, this.paper || this.ctx.mode === "demo")],
    };
    this.entries++;
    this.last = this.contractOf(m.symbol, perpSide, "futures", Math.abs(basis - mean) * 10_000, Math.min(1, Math.abs(z) / (p.zEntry * 2)), p.maxHoldMs, { z, basisBps: basis * 10_000 });
    void this.emitIntent(draft);
  }
}
