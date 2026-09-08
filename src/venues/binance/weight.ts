// Tracks the latest X-MBX-USED-WEIGHT-1M a Binance REST base reported and flags when usage nears the
// per-minute ceiling, so the risk kernel can stop admitting new orders before a 418 IP ban. One guard
// per venue (spot and futures have independent weight windows). A reading older than one window is
// treated as reset (used = 0), so a stale spike cannot block admission forever.

export const DEFAULT_WEIGHT_LIMIT = 6000;
export const DEFAULT_WEIGHT_PAUSE_PCT = 0.85;
const WINDOW_MS = 65_000;

export class WeightGuard {
  private used = 0;
  private observedAtMs = 0;

  constructor(
    private readonly limit: number = DEFAULT_WEIGHT_LIMIT,
    private readonly pausePct: number = DEFAULT_WEIGHT_PAUSE_PCT,
    private readonly now: () => number = Date.now,
  ) {}

  /** Feed a used-weight value parsed from a response header. Ignores garbage. */
  observe(used: number): void {
    if (Number.isFinite(used) && used >= 0) {
      this.used = used;
      this.observedAtMs = this.now();
    }
  }

  /** Latest used weight, or 0 once the last reading is older than one rolling window. */
  usedWeight(): number {
    if (this.observedAtMs === 0 || this.now() - this.observedAtMs > WINDOW_MS) return 0;
    return this.used;
  }

  /** True when used weight is at or above the pause threshold. */
  nearLimit(): boolean {
    return this.usedWeight() >= this.limit * this.pausePct;
  }
}
