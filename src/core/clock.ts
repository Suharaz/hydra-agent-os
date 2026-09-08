/** Monotonic nanoseconds since process start. Latency math only; never persist as wall time. */
export function nowNs(): number {
  return Bun.nanoseconds();
}

/** Wall clock ms (Date.now). */
export function wallMs(): number {
  return Date.now();
}

/** UTC calendar date `YYYY-MM-DD` for a wall-ms timestamp; ledger daily keys. */
export function utcDate(ms: number = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Wall ms at 00:00:00 UTC of the day containing `ms`. */
export function utcDayStartMs(ms: number = Date.now()): number {
  return ms - (ms % 86_400_000);
}
