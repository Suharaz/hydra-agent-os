// Global failed-auth throttle. Everything reaches the dashboard from 127.0.0.1, so a per-IP bucket
// would be meaningless; one counter guards login, bearer and ticket checks alike. While locked,
// even a correct credential is refused so a brute force cannot slip its last guess through.

export interface LockoutOptions {
  max: number;
  windowMs: number;
  lockMs: number;
  now?: () => number;
}

export const DEFAULT_LOCKOUT: Readonly<Omit<LockoutOptions, "now">> = { max: 5, windowMs: 60_000, lockMs: 60_000 };

export class Lockout {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private readonly now: () => number;
  private failures: number[] = [];
  private lockedUntil = 0;

  constructor(opts: LockoutOptions) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.lockMs = opts.lockMs;
    this.now = opts.now ?? Date.now;
  }

  /** Milliseconds until the lock lifts, or 0 when open. */
  locked(): number {
    const rem = this.lockedUntil - this.now();
    return rem > 0 ? rem : 0;
  }

  /** Records one failure; true exactly when this failure engaged the lock. */
  fail(): boolean {
    const t = this.now();
    if (this.lockedUntil > t) return false;
    const cutoff = t - this.windowMs;
    this.failures = this.failures.filter((f) => f > cutoff);
    this.failures.push(t);
    if (this.failures.length < this.max) return false;
    this.failures = [];
    this.lockedUntil = t + this.lockMs;
    return true;
  }

  /** A successful authentication clears the failure window (not an active lock). */
  succeed(): void {
    this.failures = [];
  }
}
