import { afterEach, describe, expect, test } from "bun:test";
import { Bus } from "../../src/core/bus.ts";
import { loadConfig } from "../../src/core/config.ts";
import { type Ledger, openLedger } from "../../src/core/ledger.ts";
import type { GuardianBreach, KillEvent, Position } from "../../src/core/types.ts";
import { Guardian, type GuardianPositions } from "../../src/hot/guardian.ts";
import { REPO_CONFIG, cleanup, tempDir } from "../core/helpers.ts";
import { buildExecutor } from "../../src/hot/executor.ts";
import { effective, tighten } from "../../src/core/limits.ts";
import { fakeEnv } from "./fake-binance.ts";
import { until } from "../core/helpers.ts";

const RISK = loadConfig(REPO_CONFIG).risk; // daily_drawdown_kill_pct: 4

class FakePositions implements GuardianPositions {
  start = 10_000;
  navUsd = 10_000;
  maxDd: number[] = [];
  nav(): number {
    return this.navUsd;
  }
  dayStartNav(): number {
    return this.start;
  }
  drawdownPct(): number {
    const dd = ((this.start - this.navUsd) / this.start) * 100;
    return dd > 0 ? dd : 0;
  }
  recordMaxDd(bps: number): void {
    this.maxDd.push(bps);
  }
  snapshot(): readonly Position[] {
    return [];
  }
  setMark(): void {}
}

interface Rig {
  guardian: Guardian;
  positions: FakePositions;
  kills: string[];
  breaches: GuardianBreach[];
  killEvents: KillEvent[];
  now: { ms: number };
  dir: string;
  ledger: Ledger;
}

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) {
    r.ledger.close();
    cleanup(r.dir);
  }
});

function rig(): Rig {
  const dir = tempDir();
  const ledger = openLedger(":memory:");
  const bus = new Bus();
  const positions = new FakePositions();
  const now = { ms: 1_700_000_000_000 };
  const r: Rig = { positions, kills: [], breaches: [], killEvents: [], now, dir, ledger, guardian: undefined as unknown as Guardian };
  bus.on("guardian.breach", (b) => r.breaches.push(b));
  bus.on("system.kill", (k) => r.killEvents.push(k));
  r.guardian = new Guardian({
    risk: RISK,
    positions,
    ledger,
    stateDir: dir,
    killFn: async (reason) => {
      r.kills.push(reason);
    },
    alertFn: async () => {},
    clock: () => now.ms,
    bus,
  });
  rigs.push(r);
  return r;
}

describe("guardian drawdown breaker", () => {
  test("4.1% drawdown kills once, emits breach + system.kill", () => {
    const r = rig();
    r.positions.navUsd = 9590;
    r.guardian.tick();
    expect(r.kills).toHaveLength(1);
    expect(r.kills[0]).toContain("4.10%");
    expect(r.breaches).toEqual([expect.objectContaining({ kind: "drawdown", value: expect.closeTo(4.1, 6), threshold: 4 })]);
    expect(r.killEvents).toEqual([expect.objectContaining({ actor: "guardian", reason: r.kills[0] })]);
    // Still breached on the next tick: no second kill while the breaker stays tripped.
    r.now.ms += 1000;
    r.guardian.tick();
    expect(r.kills).toHaveLength(1);
  });

  test("3.8% drawdown does not kill", () => {
    const r = rig();
    r.positions.navUsd = 9620;
    r.guardian.tick();
    r.now.ms += 1000;
    r.guardian.tick();
    expect(r.kills).toHaveLength(0);
    expect(r.breaches).toHaveLength(0);
    expect(r.killEvents).toHaveLength(0);
  });

  test("S12: tightened threshold visible on the tick immediately after overlay write (no cache stale)", async () => {
    // Reproduces the exact production failure: guardian.start() warms readEffectiveLimits (250 ms
    // TTL); a supervisor writes the tighten within that window; without the fix, the next tick
    // returns the stale 4% and misses a 3% drawdown that should breach the tightened 2%.
    const dir = tempDir();
    const ledger = openLedger(":memory:");
    const bus = new Bus();
    const breaches: GuardianBreach[] = [];
    bus.on("guardian.breach", (e) => breaches.push(e));
    const config = loadConfig(REPO_CONFIG);
    const env = fakeEnv({ BINANCE_SPOT_API_KEY: "", BINANCE_SPOT_API_SECRET: "", BINANCE_FUTURES_API_KEY: "", BINANCE_FUTURES_API_SECRET: "" });
    const stack = buildExecutor({ env, config, ledger, stateDir: dir, configDir: REPO_CONFIG, bus, onchain: null });
    try {
      // Seed day-start anchor at 10 000 with zero drawdown.
      stack.positions.setCash(10_000);
      stack.positions.resetDayAnchor();
      stack.positions.dayStartNav(); // anchor = 10 000

      // First tick: warms the limits cache (mirrors guardian.start() calling tick at boot).
      // drawdown = 0 % < base threshold 4 % — no breach expected.
      stack.guardian.tick();
      expect(breaches).toHaveLength(0);

      // Write the tighten while the cache is hot (< STATE_TTL_MS = 250 ms has elapsed).
      tighten(dir, { daily_drawdown_kill_pct: 2 }, "supervisor", effective(config.risk, null, Date.now(), false));

      // Inject 3 % drawdown: above the tightened 2 % but below the base 4 %.
      // Without the S12 fix readEffectiveLimits returns stale 4 % → no breach.
      // With the fix guardian reads fresh → threshold = 2 % → breach.
      stack.positions.setCash(9_700);

      stack.guardian.tick();
      expect(breaches).toContainEqual(expect.objectContaining({ kind: "drawdown", threshold: 2, value: 3 }));
      await stack.kill("join-guardian");
    } finally { stack.kernel.stop(); ledger.close(); cleanup(dir); }
  });

  test("S12: failed kill retries while drawdown remains breached", async () => {
    const r = rig();
    let calls = 0;
    const guardian = new Guardian({ risk: RISK, positions: r.positions, ledger: r.ledger, stateDir: r.dir, alertFn: async () => {}, killFn: async () => { calls++; throw new Error("temporary kill failure"); } });
    r.positions.navUsd = 9590;
    guardian.tick();
    await until(() => calls === 1);
    await Promise.resolve();
    await Promise.resolve();
    guardian.tick();
    expect(calls).toBe(2);
  });
});
