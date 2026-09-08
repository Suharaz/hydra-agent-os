// Payloads sold behind the x402 routes. Buyers get a view delayed by `delayMs` relative to what
// the hot lane acts on (the internal edge stays internal); the ring keeps the last `capacity`
// events per stream so a paid request returns a batch, not a single tick.

import { bus as globalBus, type Bus } from "../core/bus.ts";
import { wallMs } from "../core/clock.ts";
import type { LiquidationEvent, MarkEvent, OpportunityContract } from "../core/types.ts";

export const SIGNAL_DELAY_MS = 2000;
const CAPACITY = 200;

interface Stamped<T> {
  atMs: number;
  event: T;
}

class Ring<T> {
  private readonly items: Stamped<T>[] = [];
  push(event: T, atMs: number): void {
    this.items.push({ atMs, event });
    if (this.items.length > CAPACITY) this.items.splice(0, this.items.length - CAPACITY);
  }
  /** Events older than `cutoffMs`, oldest first. */
  before(cutoffMs: number): T[] {
    const out: T[] = [];
    for (const it of this.items) if (it.atMs <= cutoffMs) out.push(it.event);
    return out;
  }
}

export interface SignalFeedsDeps {
  bus?: Bus;
  now?: () => number;
  delayMs?: number;
}

export class SignalFeeds {
  private readonly liq = new Ring<LiquidationEvent>();
  private readonly marks = new Ring<MarkEvent>();
  private readonly contractsRing = new Ring<OpportunityContract>();
  private readonly offs: Array<() => void> = [];
  private readonly now: () => number;
  private readonly delayMs: number;

  constructor(private readonly deps: SignalFeedsDeps) {
    this.now = deps.now ?? wallMs;
    this.delayMs = deps.delayMs ?? SIGNAL_DELAY_MS;
  }

  start(): void {
    const bus = this.deps.bus ?? globalBus;
    this.offs.push(bus.on("feed.liq", (e) => this.liq.push(e, this.now())));
    this.offs.push(bus.on("feed.mark", (e) => this.marks.push(e, this.now())));
    this.offs.push(bus.on("engine.contract", (c) => this.contractsRing.push(c, this.now())));
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  private cutoff(): number {
    return this.now() - this.delayMs;
  }

  liquidation = (): { asOf: number; delayMs: number; events: LiquidationEvent[] } => {
    return { asOf: this.cutoff(), delayMs: this.delayMs, events: this.liq.before(this.cutoff()) };
  };

  /** Latest delayed mark/index per symbol; basis = (mark - index) / index in bps. */
  basis = (): { asOf: number; delayMs: number; symbols: Array<{ symbol: string; mark: number; index: number; basisBps: number; fundingRate: number }> } => {
    const latest = new Map<string, MarkEvent>();
    for (const m of this.marks.before(this.cutoff())) latest.set(m.symbol, m);
    const symbols = [...latest.values()].map((m) => ({
      symbol: m.symbol,
      mark: m.mark,
      index: m.index,
      basisBps: m.index > 0 ? ((m.mark - m.index) / m.index) * 10_000 : 0,
      fundingRate: m.fundingRate,
    }));
    return { asOf: this.cutoff(), delayMs: this.delayMs, symbols };
  };

  contracts = (): { asOf: number; delayMs: number; contracts: OpportunityContract[] } => {
    return { asOf: this.cutoff(), delayMs: this.delayMs, contracts: this.contractsRing.before(this.cutoff()) };
  };
}
