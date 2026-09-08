// Local L2 order book with snapshot + diff synchronisation.
//
// Sync rule (futures `depth@100ms`, accepts the spot rule as a superset):
//   - diffs arriving before the snapshot are buffered;
//   - after `applySnapshot(lastUpdateId)`, drop diffs with `u < lastUpdateId`;
//   - the first applied diff must bracket the snapshot: futures `U <= lastUpdateId <= u`, spot `U <= lastUpdateId + 1 <= u`;
//   - every later diff must satisfy `pu === lastU` (futures) or `U === lastU + 1` (spot, no `pu`);
//   - any violation -> `synced = false`, book cleared, `onGap` invoked so the owner re-fetches.
//
// Storage: two parallel arrays per side (prices sorted best-first, quantities). Updates are a
// binary search plus an in-place write; only new levels splice.

export interface DepthDiff {
  /** First update id in event. */
  U: number;
  /** Final update id in event. */
  u: number;
  /** Final update id of the previous event (futures only). */
  pu?: number;
  b: [string, string][];
  a: [string, string][];
  /** Event time (ms). */
  E?: number;
}

export interface Snapshot {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

export interface Level {
  price: number;
  qty: number;
}

export interface BookOptions {
  nowMs?: () => number;
  onGap?: (symbol: string, detail: string) => void;
}

export class Book {
  synced = false;
  lastU = -1;
  /** Local receipt ms of the last applied diff/snapshot; -1 until synced. */
  lastEventMs = -1;
  private readonly bidPx: number[] = [];
  private readonly bidQty: number[] = [];
  private readonly askPx: number[] = [];
  private readonly askQty: number[] = [];
  private readonly pending: DepthDiff[] = [];
  private readonly nowMs: () => number;
  private readonly onGap: ((symbol: string, detail: string) => void) | undefined;

  constructor(
    readonly symbol: string,
    opts: BookOptions = {},
  ) {
    this.nowMs = opts.nowMs ?? Date.now;
    this.onGap = opts.onGap;
  }

  get bestBid(): number {
    return this.bidPx.length === 0 ? 0 : (this.bidPx[0] as number);
  }

  get bestAsk(): number {
    return this.askPx.length === 0 ? 0 : (this.askPx[0] as number);
  }

  get mid(): number {
    const b = this.bestBid;
    const a = this.bestAsk;
    return b > 0 && a > 0 ? (a + b) / 2 : 0;
  }

  get spreadBps(): number {
    const m = this.mid;
    return m > 0 ? ((this.bestAsk - this.bestBid) / m) * 10_000 : 0;
  }

  /** Milliseconds since the last applied update; Infinity before the first snapshot. */
  get ageMs(): number {
    return this.lastEventMs < 0 ? Number.POSITIVE_INFINITY : this.nowMs() - this.lastEventMs;
  }

  get depth(): { bids: number; asks: number } {
    return { bids: this.bidPx.length, asks: this.askPx.length };
  }

  get bufferedDiffs(): number {
    return this.pending.length;
  }

  /** (bidQty - askQty) / (bidQty + askQty) over the top `n` levels; 0 when empty. */
  imbalance(n: number): number {
    let b = 0;
    let a = 0;
    const nb = Math.min(n, this.bidQty.length);
    const na = Math.min(n, this.askQty.length);
    for (let i = 0; i < nb; i++) b += this.bidQty[i] as number;
    for (let i = 0; i < na; i++) a += this.askQty[i] as number;
    const t = a + b;
    return t === 0 ? 0 : (b - a) / t;
  }

  /** Quantity-weighted top of book; falls back to mid when one side is empty. */
  microprice(): number {
    if (this.bidPx.length === 0 || this.askPx.length === 0) return this.mid;
    const bq = this.bidQty[0] as number;
    const aq = this.askQty[0] as number;
    const t = bq + aq;
    return t === 0 ? this.mid : ((this.bidPx[0] as number) * aq + (this.askPx[0] as number) * bq) / t;
  }

  /** Top `n` levels (best first); allocates, so engines should call sparingly. */
  levels(side: "bid" | "ask", n: number): Level[] {
    const px = side === "bid" ? this.bidPx : this.askPx;
    const qty = side === "bid" ? this.bidQty : this.askQty;
    const k = Math.min(n, px.length);
    const out: Level[] = new Array(k);
    for (let i = 0; i < k; i++) out[i] = { price: px[i] as number, qty: qty[i] as number };
    return out;
  }

  /**
   * Replaces the book, then replays buffered diffs through `applyDiff` (the first must bracket
   * `lastUpdateId`). Returns the resulting `synced`; false means a gap fired during replay and
   * the unapplied diffs are re-buffered for the next snapshot.
   */
  applySnapshot(snap: Snapshot): boolean {
    this.clear();
    for (const [p, q] of snap.bids) this.set(this.bidPx, this.bidQty, Number(p), Number(q), true);
    for (const [p, q] of snap.asks) this.set(this.askPx, this.askQty, Number(p), Number(q), false);
    this.lastU = snap.lastUpdateId;
    this.synced = true;
    this.awaitingFirst = true;
    this.lastEventMs = this.nowMs();
    const buffered = this.pending.splice(0, this.pending.length);
    for (let i = 0; i < buffered.length; i++) {
      const d = buffered[i] as DepthDiff;
      if (d.u < snap.lastUpdateId) continue;
      if (this.applyDiff(d) || this.synced) continue;
      // Gap during replay: applyDiff re-buffered `d`; keep the rest in order.
      for (let j = i + 1; j < buffered.length; j++) this.pending.push(buffered[j] as DepthDiff);
      return false;
    }
    return true;
  }

  private awaitingFirst = false;

  /**
   * Applies one diff. Before a snapshot the diff is buffered (returns false). After a gap the
   * book is unsynced and the diff buffered for the next snapshot.
   */
  applyDiff(d: DepthDiff): boolean {
    if (!this.synced) {
      this.pending.push(d);
      if (this.pending.length > 5000) this.pending.splice(0, this.pending.length - 5000);
      return false;
    }
    if (d.u < this.lastU) return false;
    if (this.awaitingFirst) {
      // Futures (has `pu`): U <= lastUpdateId <= u. Spot: U <= lastUpdateId + 1 <= u.
      const anchor = d.pu !== undefined ? this.lastU : this.lastU + 1;
      if (!(d.U <= anchor && anchor <= d.u)) {
        this.gap(`first diff U=${d.U} u=${d.u} does not bracket snapshot ${this.lastU}`);
        this.pending.push(d);
        return false;
      }
      this.awaitingFirst = false;
    } else if (d.pu !== undefined ? d.pu !== this.lastU : d.U !== this.lastU + 1) {
      this.gap(`expected pu=${this.lastU}, got ${d.pu ?? `U=${d.U}`}`);
      this.pending.push(d);
      return false;
    }
    this.write(d);
    return true;
  }

  clear(): void {
    this.bidPx.length = 0;
    this.bidQty.length = 0;
    this.askPx.length = 0;
    this.askQty.length = 0;
    this.synced = false;
    this.awaitingFirst = false;
    this.lastU = -1;
  }

  private gap(detail: string): void {
    this.clear();
    this.onGap?.(this.symbol, detail);
  }

  private write(d: DepthDiff): void {
    for (let i = 0; i < d.b.length; i++) {
      const lvl = d.b[i] as [string, string];
      this.set(this.bidPx, this.bidQty, Number(lvl[0]), Number(lvl[1]), true);
    }
    for (let i = 0; i < d.a.length; i++) {
      const lvl = d.a[i] as [string, string];
      this.set(this.askPx, this.askQty, Number(lvl[0]), Number(lvl[1]), false);
    }
    this.lastU = d.u;
    this.lastEventMs = this.nowMs();
  }

  /** Binary search in a best-first array (desc for bids, asc for asks). */
  private set(px: number[], qty: number[], price: number, q: number, desc: boolean): void {
    let lo = 0;
    let hi = px.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      const v = px[m] as number;
      if (v === price) {
        if (q === 0) {
          px.splice(m, 1);
          qty.splice(m, 1);
        } else qty[m] = q;
        return;
      }
      if (desc ? v > price : v < price) lo = m + 1;
      else hi = m;
    }
    if (q === 0) return;
    px.splice(lo, 0, price);
    qty.splice(lo, 0, q);
  }
}
