// Guardian: a 1 s loop independent of engines and the cold lane. Each tick refreshes marks from the
// feed, computes NAV / daily drawdown from positions (day anchor from pnl_daily or the first tick),
// and trips two breakers: drawdown >= daily_drawdown_kill_pct -> `guardian.breach` + `system.kill`
// + killFn; |NAV change| > nav_jump_alert_pct within 60 s -> pause every engine via the limits
// overlay (actor `guardian`) + alert. Once an hour the running max drawdown is upserted into
// pnl_daily. `tick()` is public so tests drive it with a fake clock.

import { alert as defaultAlert, type AlertLevel } from "../core/alert.ts";
import { bus as defaultBus, type Bus } from "../core/bus.ts";
import { nowNs, utcDate, wallMs } from "../core/clock.ts";
import type { RiskConfig } from "../core/config.ts";
import type { Ledger } from "../core/ledger.ts";
import { type EffectiveLimits, effective, pauseAllEngines } from "../core/limits.ts";
import { logger } from "../core/log.ts";
import { readKillLock, readLimits } from "../core/state.ts";
import type { GuardianBreach, Position, Venue } from "../core/types.ts";
import type { FeedView } from "./kernel.ts";

const log = logger("guardian");

const JUMP_WINDOW_MS = 60_000;
const MAX_DD_WRITE_MS = 3_600_000;

/** Slice of `Positions` the Guardian reads (tests stub it). */
export interface GuardianPositions {
  nav(): number;
  dayStartNav(): number;
  drawdownPct(): number;
  recordMaxDd(bps: number): void;
  snapshot(): readonly Position[];
  setMark(venue: Venue, symbol: string, price: number): void;
}

export interface GuardianDeps {
  risk: RiskConfig;
  positions: GuardianPositions;
  /** Marks are pulled from here each tick so NAV never depends on bus wiring. */
  feed?: FeedView | null;
  ledger: Ledger;
  stateDir: string;
  killFn: (reason: string) => Promise<unknown>;
  alertFn?: (level: AlertLevel, msg: string) => Promise<void>;
  /** Effective limits (overlay may tighten the drawdown threshold); defaults to risk.yaml. */
  limits?: () => EffectiveLimits;
  intervalMs?: number;
  /** Wall ms. */
  clock?: () => number;
  bus?: Bus;
}

export class Guardian {
  private readonly risk: RiskConfig;
  private readonly positions: GuardianPositions;
  private readonly feed: FeedView | null;
  private readonly ledger: Ledger;
  private readonly stateDir: string;
  private readonly killFn: (reason: string) => Promise<unknown>;
  private readonly alertFn: (level: AlertLevel, msg: string) => Promise<void>;
  private readonly limits: (() => EffectiveLimits) | null;
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private readonly bus: Bus;

  /** NAV samples over the jump window; ring of (ts, nav). */
  private readonly sampleTs: Float64Array;
  private readonly sampleNav: Float64Array;
  private sampleHead = 0;
  private sampleCount = 0;

  private timer: Timer | null = null;
  private day = "";
  private maxDdBps = 0;
  private lastDdWrite = Number.NEGATIVE_INFINITY;
  private drawdownTripped = false;
  private killPending = false;
  private jumpTripped = false;
  /** Wall ms the loop started; the NAV-jump breaker is suppressed for one window while NAV establishes. */
  private startedAtMs = 0;

  constructor(deps: GuardianDeps) {
    this.risk = deps.risk;
    this.positions = deps.positions;
    this.feed = deps.feed ?? null;
    this.ledger = deps.ledger;
    this.stateDir = deps.stateDir;
    this.killFn = deps.killFn;
    this.alertFn = deps.alertFn ?? defaultAlert;
    this.limits = deps.limits ?? null;
    this.intervalMs = deps.intervalMs ?? 1000;
    this.clock = deps.clock ?? wallMs;
    this.bus = deps.bus ?? defaultBus;
    const capacity = Math.ceil(JUMP_WINDOW_MS / this.intervalMs) + 1;
    this.sampleTs = new Float64Array(capacity);
    this.sampleNav = new Float64Array(capacity);
  }

  start(): void {
    if (this.timer !== null) return;
    this.startedAtMs = this.clock();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    this.positions.recordMaxDd(this.maxDdBps);
  }

  tick(): void {
    const now = this.clock();
    this.refreshMarks();
    const day = utcDate(now);
    if (day !== this.day) {
      this.day = day;
      this.maxDdBps = 0;
    }
    const nav = this.positions.nav();
    const dd = this.positions.drawdownPct();
    const ddBps = Math.round(dd * 100);
    if (ddBps > this.maxDdBps) this.maxDdBps = ddBps;

    const threshold = (this.limits === null ? this.risk : this.limits()).daily_drawdown_kill_pct;
    if (dd >= threshold) {
      if (!this.killPending && (!this.drawdownTripped || readKillLock(this.stateDir) === null)) {
        this.drawdownTripped = true;
        this.onDrawdown(dd, threshold);
      }
    } else this.drawdownTripped = false;

    const ref = this.oldestNavWithin(now);
    this.pushSample(now, nav);
    // Suppress the jump breaker for the first window: cold start ramps NAV from 0 to the funded value
    // (keys load, first reconcile) which is not a real anomaly. Real jumps after warmup still trip.
    if (ref > 0 && now - this.startedAtMs >= JUMP_WINDOW_MS) {
      const jump = (Math.abs(nav - ref) / ref) * 100;
      if (jump > this.risk.nav_jump_alert_pct) {
        if (!this.jumpTripped) {
          this.jumpTripped = true;
          this.onNavJump(jump, ref, nav, now);
        }
      } else this.jumpTripped = false;
    }

    if (now - this.lastDdWrite >= MAX_DD_WRITE_MS) {
      this.lastDdWrite = now;
      this.positions.recordMaxDd(this.maxDdBps);
    }
  }

  private refreshMarks(): void {
    if (this.feed === null) return;
    for (const pos of this.positions.snapshot()) {
      if (pos.venue !== "futures") continue;
      const m = this.feed.mark(pos.symbol);
      if (m !== null && m.mark > 0 && m.mark !== pos.mark) this.positions.setMark("futures", pos.symbol, m.mark);
    }
  }

  private pushSample(ts: number, nav: number): void {
    const cap = this.sampleTs.length;
    this.sampleTs[this.sampleHead] = ts;
    this.sampleNav[this.sampleHead] = nav;
    this.sampleHead = (this.sampleHead + 1) % cap;
    if (this.sampleCount < cap) this.sampleCount += 1;
  }

  /** NAV of the oldest sample inside the jump window; 0 when none. */
  private oldestNavWithin(now: number): number {
    const cap = this.sampleTs.length;
    const floor = now - JUMP_WINDOW_MS;
    let idx = (this.sampleHead - this.sampleCount + cap) % cap;
    for (let n = 0; n < this.sampleCount; n++) {
      if ((this.sampleTs[idx] as number) >= floor) return this.sampleNav[idx] as number;
      idx = (idx + 1) % cap;
    }
    return 0;
  }

  private breach(kind: GuardianBreach["kind"], value: number, threshold: number): void {
    const ev: GuardianBreach = { kind, value, threshold, tsNs: nowNs() };
    this.bus.emit("guardian.breach", ev);
    this.ledger.event("guardian.breach", JSON.stringify(ev));
  }

  private onDrawdown(dd: number, threshold: number): void {
    const reason = `guardian: daily drawdown ${dd.toFixed(2)}% >= ${threshold}%`;
    log.error(reason);
    this.breach("drawdown", dd, threshold);
    this.bus.emit("system.kill", { reason, actor: "guardian", tsNs: nowNs() });
    void this.alertFn("critical", reason).catch(() => {});
    this.killPending = true;
    try {
      void this.killFn(reason).then((result) => {
        if (typeof result === "object" && result !== null && "flat" in result && result.flat === false) this.drawdownTripped = false;
      }).catch((e) => {
        this.drawdownTripped = false;
        log.error("kill failed", { error: String(e) });
      }).finally(() => { this.killPending = false; });
    } catch (e) {
      this.killPending = false;
      this.drawdownTripped = false;
      log.error("kill failed", { error: String(e) });
    }
  }

  private onNavJump(jump: number, from: number, to: number, now: number): void {
    const reason = `guardian: NAV moved ${jump.toFixed(1)}% in ${JUMP_WINDOW_MS / 1000} s (${from.toFixed(2)} -> ${to.toFixed(2)})`;
    log.warn(reason);
    this.breach("nav_jump", jump, this.risk.nav_jump_alert_pct);
    try {
      const current = effective(this.risk, readLimits(this.stateDir), now, readKillLock(this.stateDir) !== null);
      pauseAllEngines(this.stateDir, reason, current);
    } catch (e) {
      log.error("engine pause failed", { error: String(e) });
    }
    void this.alertFn("warn", reason).catch(() => {});
  }
}
