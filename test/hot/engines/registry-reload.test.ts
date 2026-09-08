import { afterEach, describe, expect, test } from "bun:test";
import { Bus } from "../../../src/core/bus.ts";
import { type EnginesConfig, loadConfig, writeEngines } from "../../../src/core/config.ts";
import { loadEnv } from "../../../src/core/env.ts";
import { openLedger } from "../../../src/core/ledger.ts";
import type { Intent } from "../../../src/core/types.ts";
import { AuditCache } from "../../../src/hot/audit-cache.ts";
import { BasisEngine } from "../../../src/hot/engines/basis.ts";
import type { EngineCtx, EngineFeed, ParamsOf } from "../../../src/hot/engines/engine.ts";
import { LiqfadeEngine } from "../../../src/hot/engines/liqfade.ts";
import { createEnginesModule, EngineRegistry } from "../../../src/hot/engines/registry.ts";
import type { SubmitResult } from "../../../src/hot/executor.ts";
import { REPO_CONFIG, cleanup, tempConfigDir, until } from "../../core/helpers.ts";

const CONFIG = loadConfig(REPO_CONFIG);

/** Exposes the validated params the base class keeps protected. */
class ProbeLiqfade extends LiqfadeEngine {
  get p(): ParamsOf<"liqfade"> {
    return this.params;
  }
  get syms(): string[] {
    return this.symbols;
  }
}

const feed: EngineFeed = {
  book: () => null,
  mark: () => null,
  burst: () => ({ buyUsd1s: 0, sellUsd1s: 0 }),
  gapBps: () => 0,
  vwap1m: () => 0,
  adv: () => 0,
  spotTopOfBook: () => null,
  referenceMid: () => null,
};

const submit = (_i: Intent): Promise<SubmitResult> => Promise.resolve({ ok: true, orders: [], fills: [] });

function withLiqfade(patch: Partial<EnginesConfig["engines"]["liqfade"]>): EnginesConfig {
  return { engines: { ...CONFIG.engines.engines, liqfade: { ...CONFIG.engines.engines.liqfade, ...patch } } };
}

describe("EngineRegistry.apply", () => {
  test("params change applies; whitelist and bounds violations reject that engine and keep the previous config", () => {
    const ledger = openLedger(":memory:");
    const ctx: EngineCtx = { feed, submit, skills: null, audit: new AuditCache(), ledger, bus: new Bus(), nowNs: () => 0, wallMs: () => 0, mode: "demo", risk: CONFIG.risk };
    const registry = new EngineRegistry(ctx, { liqfade: (c) => new ProbeLiqfade(c), basis: (c) => new BasisEngine(c) });
    try {
      const probe = registry.engines().get("liqfade") as ProbeLiqfade;
      const basis = registry.engines().get("basis") as BasisEngine;

      expect(registry.apply(CONFIG.engines)).toEqual({ applied: ["liqfade", "basis"], rejected: [] });
      expect(probe.enabled).toBe(true);
      expect(probe.syms).toEqual(["ETHUSDT", "BTCUSDT"]);
      expect(probe.p.minGapBps).toBe(8);
      expect(basis.enabled).toBe(true);

      // Param change within bounds applies.
      const r1 = registry.apply(withLiqfade({ params: { ...CONFIG.engines.engines.liqfade.params, minGapBps: 12 } }));
      expect(r1.applied).toContain("liqfade");
      expect(probe.p.minGapBps).toBe(12);

      // Symbols outside allowed_symbols.futures: rejected, previous config (12 bps, ETH/BTC, enabled) kept.
      const r2 = registry.apply(withLiqfade({ symbols: ["ETHUSDT", "DOGEUSDT"], params: { minGapBps: 20 }, enabled: false }));
      expect(r2.applied).toEqual(["basis"]);
      expect(r2.rejected).toEqual([{ engine: "liqfade", reason: expect.stringContaining("DOGEUSDT") }]);
      expect(probe.enabled).toBe(true);
      expect(probe.syms).toEqual(["ETHUSDT", "BTCUSDT"]);
      expect(probe.p.minGapBps).toBe(12);

      // Out-of-bounds param: rejected the same way.
      const r3 = registry.apply(withLiqfade({ params: { minGapBps: 31 } }));
      expect(r3.rejected.map((r) => r.engine)).toEqual(["liqfade"]);
      expect(r3.rejected[0]?.reason.startsWith("params:")).toBe(true);
      expect(probe.p.minGapBps).toBe(12);

      // Disabling applies, and disabled engines publish no contracts.
      expect(registry.apply(withLiqfade({ enabled: false })).applied).toContain("liqfade");
      expect(probe.enabled).toBe(false);
      expect(registry.contracts()).toEqual([]);
      expect(Object.keys(registry.stats()).sort()).toEqual(["basis", "liqfade"]);
    } finally {
      registry.stop();
      ledger.close();
    }
  });
});

describe("createEnginesModule", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) cleanup(dir);
    dir = null;
  });

  test("hot-reloads engines.yaml through watchEngines and rejects a bad write without losing the running config", async () => {
    dir = tempConfigDir();
    const config = loadConfig(dir);
    const env = loadEnv({ source: { HYDRA_MODE: "demo" }, warn: () => undefined, notice: () => undefined });
    const ledger = openLedger(":memory:");
    const bus = new Bus();
    const mod = createEnginesModule({ env, config, ledger, stateDir: dir, configDir: dir, feed, submit, skills: null, audit: new AuditCache(), bus });
    try {
      await mod.start();
      const probe = mod.registry.engines().get("liqfade") as LiqfadeEngine;
      expect(probe.enabled).toBe(true);
      expect(bus.listenerCount("feed.liq")).toBe(1);
      expect(bus.listenerCount("feed.mark")).toBe(1);
      expect(bus.listenerCount("feed.trade")).toBe(0); // no engine subscribes: no listener

      await writeEngines(dir, { liqfade: { enabled: false } }, "operator");
      await until(() => !probe.enabled);

      // A write that puts liqfade outside the futures whitelist is rejected for liqfade only; the
      // following basis write proves the watcher kept running and liqfade stayed as it was.
      await writeEngines(dir, { liqfade: { enabled: true, symbols: ["ETHUSDT", "NOPEUSDT"] } }, "operator");
      const basis = mod.registry.engines().get("basis") as BasisEngine;
      expect(basis.enabled).toBe(true);
      await writeEngines(dir, { basis: { enabled: false } }, "operator");
      await until(() => !basis.enabled);
      expect(probe.enabled).toBe(false);
    } finally {
      await mod.stop();
      ledger.close();
    }
    expect(bus.listenerCount("feed.liq")).toBe(0);
  });
});
