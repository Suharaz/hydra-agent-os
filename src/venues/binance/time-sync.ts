// Server-time offset per REST base URL. Binance signs requests against *its* clock; a drift
// > recvWindow yields -1021. Offset = serverTime - localMidpoint of the round trip.

export class TimeSync {
  private readonly offsets = new Map<string, number>();
  private readonly refreshedAt = new Map<string, number>();

  constructor(private readonly nowMs: () => number = Date.now) {}

  /** Milliseconds to add to local wall time for `baseUrl`; 0 until refreshed. */
  offsetFor(baseUrl: string): number {
    return this.offsets.get(baseUrl) ?? 0;
  }

  /** Wall ms of the last successful refresh for `baseUrl`; null when never refreshed. */
  lastRefresh(baseUrl: string): number | null {
    return this.refreshedAt.get(baseUrl) ?? null;
  }

  /** `fetchTime` resolves the venue's `serverTime` (ms). */
  async refresh(baseUrl: string, fetchTime: () => Promise<number>): Promise<void> {
    const t0 = this.nowMs();
    const server = await fetchTime();
    const t1 = this.nowMs();
    const mid = t0 + (t1 - t0) / 2;
    this.offsets.set(baseUrl, Math.round(server - mid));
    this.refreshedAt.set(baseUrl, t1);
  }

  /** Tests / manual override. */
  set(baseUrl: string, offsetMs: number): void {
    this.offsets.set(baseUrl, offsetMs);
    this.refreshedAt.set(baseUrl, this.nowMs());
  }
}
