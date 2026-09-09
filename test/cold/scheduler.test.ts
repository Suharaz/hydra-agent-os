import { afterEach, describe, expect, test } from "bun:test";

import { checkNoveltyGate, extractNoveltySnapshot } from "../../src/cold/agent.ts";
import { AGENT_MODULES, BUDGET_GATES, Scheduler, STARVATION_MS } from "../../src/cold/scheduler.ts";
import type { AgentsConfig } from "../../src/core/config.ts";
import { AGENT_NAMES, type EngineId } from "../../src/core/types.ts";
import { answer, fakeChat, NOW, type Rig, rig } from "./rig.ts";

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose();
});

const AGENTS: AgentsConfig = {
  agents: {
    commander: { model: "test/primary", interval: "5m", temperature: 0 },
    supervisor: { model: "test/primary", interval: "1m", temperature: 0 },
    treasurer: { model: "test/primary", interval: "15m", temperature: 0 },
    coach: { model: "test/primary", interval: "1h", temperature: 0 },
    sales: { model: "test/primary", interval: "30m", temperature: 0 },
  },
};

function recordSpend(r: Rig, usd: number): void {
  r.deps.ledger.insertLlmCall({
    runId: "seed",
    agent: "commander",
    role: "primary",
    model: "test/primary",
    promptTokens: 10,
    completionTokens: 10,
    costUsd: usd,
    latencyMs: 5,
    schemaValid: true,
  });
}

function insertTrade(r: Rig, engine: EngineId = "basis", realized = 10): void {
  r.deps.ledger.insertTrade({
    engine,
    venue: "futures",
    symbol: "BTCUSDT",
    openedNs: (NOW - 10_000) * 1e6,
    closedNs: NOW * 1e6,
    qty: 0.1,
    entry: 60_000,
    exit: 60_100,
    realized,
    fees: 0.1,
    retBps: 16,
  });
}

function insertVeto(r: Rig, rule = 5, detail = "max delta exceeded"): void {
  r.deps.ledger.insertVeto({
    intentId: "test-intent-1",
    engine: "basis",
    rule,
    detail,
    tsNs: NOW * 1e6,
  });
}

const dummyDecision = { action: "none", overlay: { nav_usd_cap: null, max_net_delta_pct: null, max_leverage: null, min_liq_distance_pct: null, max_orders_per_sec: null, daily_drawdown_kill_pct: null, per_engine_max_notional_usd: { liqfade: null, basis: null, convert: null, smmirror: null, cexdex: null, tokstock: null, swing: null }, onchain_max_notional_usd: null, engines_paused: null, expires_in_min: null }, kill_reason: null, rationale: "ok" };

describe("Scheduler hard daily budget gating", () => {
  test("all agents respect hard daily budget including supervisor at >= 100%", () => {
    // Budget fractions: shadow 0.7, coach 0.8, sales 0.8, treasurer 0.9, commander 1.0, supervisor 1.0
    expect(BUDGET_GATES.supervisor).toBe(1.0);
    expect(BUDGET_GATES.commander).toBe(1.0);

    // Below 100%, supervisor is allowed
    expect(Scheduler.allowed("supervisor", 0.0)).toBe(true);
    expect(Scheduler.allowed("supervisor", 0.5)).toBe(true);
    expect(Scheduler.allowed("supervisor", 0.95)).toBe(true);

    // At or over 100%, all agents including supervisor are gated
    expect(Scheduler.allowed("supervisor", 1.0)).toBe(false);
    expect(Scheduler.allowed("supervisor", 1.05)).toBe(false);
    expect(Scheduler.allowed("commander", 1.0)).toBe(false);
    expect(Scheduler.allowed("treasurer", 1.0)).toBe(false);
    expect(Scheduler.allowed("coach", 1.0)).toBe(false);
    expect(Scheduler.allowed("sales", 1.0)).toBe(false);
  });

  test("runNow rejects when daily budget is 100% exhausted", async () => {
    const { chat } = fakeChat({
      "test/primary": ({ req }) => answer(dummyDecision, req.model),
    });
    const r = rig({ chat });
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });

    // Spend $5.00 (100% of risk.yaml $5 daily budget)
    recordSpend(r, 5.0);
    expect(s.budgetFraction()).toBeGreaterThanOrEqual(1.0);

    await expect(s.runNow("supervisor")).rejects.toThrow("daily LLM budget cap exceeded");
    await expect(s.runNow("commander")).rejects.toThrow("daily LLM budget cap exceeded");
  });

  test("runNow rejects when paused for credits", async () => {
    const r = rig();
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });
    s.pausedUntil = NOW + 3_600_000;

    await expect(s.runNow("supervisor")).rejects.toThrow("yescale credits exhausted");
  });
});

describe("Meaningful work gating (novelty contract)", () => {
  test("supervisor skips when no exposure and no actionable events", () => {
    const r = rig();
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });

    // Idle state: no positions, no open orders, no vetoes, not kill-locked
    const gate = s.hasMeaningfulWork("supervisor", NOW);
    expect(gate.hasWork).toBe(false);
  });

  test("supervisor runs when new actionable veto occurs", () => {
    const r = rig();
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });

    insertVeto(r, 8, "drawdown near threshold");
    const gate = s.hasMeaningfulWork("supervisor", NOW);
    expect(gate.hasWork).toBe(true);
  });

  test("supervisor skips when flat even if daily drawdown is nonzero", () => {
    const r = rig();
    rigs.push(r);
    // Mock positions view that has netDelta=0, leverage=0, but non-zero drawdown
    r.deps.positions = {
      nav: () => 5000,
      drawdownPct: () => 0.02, // 2% daily drawdown
      netDeltaUsd: () => 0,
      leverage: () => 0,
    };
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });
    s.recordNoveltyBaseline("supervisor");

    // With flat book, drawdown alone is not exposure; supervisor should skip
    const gate = s.hasMeaningfulWork("supervisor", NOW);
    expect(gate.hasWork).toBe(false);
  });

  test("coach skips without completed trade evidence, runs when trade exists", () => {
    const r = rig();
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });

    // No trades initially
    const initial = s.hasMeaningfulWork("coach", NOW);
    expect(initial.hasWork).toBe(false);
    // Insert a completed trade
    insertTrade(r);
    const afterTrade = s.hasMeaningfulWork("coach", NOW);
    expect(afterTrade.hasWork).toBe(true);

    // After baseline is recorded, skips again until next trade
    s.recordNoveltyBaseline("coach");
    const afterBaseline = s.hasMeaningfulWork("coach", NOW);
    expect(afterBaseline.hasWork).toBe(false);
  });

  test("treasurer skips without budget/exposure/trade changes, runs on new trade", () => {
    const r = rig();
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });

    s.recordNoveltyBaseline("treasurer");
    const gate = s.hasMeaningfulWork("treasurer", NOW);
    expect(gate.hasWork).toBe(false);

    // Trade inserted
    insertTrade(r);
    const afterTrade = s.hasMeaningfulWork("treasurer", NOW);
    expect(afterTrade.hasWork).toBe(true);
  });

  test("sales skips without trade report evidence, runs when trade exists", () => {
    const r = rig();
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });

    expect(s.hasMeaningfulWork("sales", NOW).hasWork).toBe(false);
    insertTrade(r);
    expect(s.hasMeaningfulWork("sales", NOW).hasWork).toBe(true);
  });

  test("commander bootstraps once, skips unchanged state, runs on starvation fallback", () => {
    const r = rig();
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });

    // 1. First run bootstraps
    const bootstrap = s.hasMeaningfulWork("commander", NOW);
    expect(bootstrap.hasWork).toBe(true);

    // Record baseline
    s.recordNoveltyBaseline("commander");

    // 2. Unchanged state skips
    const unchanged = s.hasMeaningfulWork("commander", NOW + 300_000);
    expect(unchanged.hasWork).toBe(false);

    // 3. Starvation threshold prevents permanent cold lane starvation
    const starved = s.hasMeaningfulWork("commander", NOW + STARVATION_MS + 1000);
    expect(starved.hasWork).toBe(true);
  });
  test("commander anti-starvation fires across multiple skipped ticks", () => {
    const r = rig();
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });

    // Bootstrap
    s.recordNoveltyBaseline("commander");

    // Simulate multiple 5m ticks that skip
    for (let offset = 300_000; offset < STARVATION_MS; offset += 300_000) {
      s.tick(NOW + offset);
      expect(s.hasMeaningfulWork("commander", NOW + offset).hasWork).toBe(false);
    }

    // At STARVATION_MS, anti-starvation fires even after repeated ticks
    const starved = s.hasMeaningfulWork("commander", NOW + STARVATION_MS + 1000);
    expect(starved.hasWork).toBe(true);
  });


  test("scheduled tick skips agents without meaningful work without calling chat", async () => {
    const { chat, calls } = fakeChat({
      "test/primary": ({ req }) => answer(dummyDecision, req.model),
    });
    const r = rig({ chat });
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });

    // Coach, sales, supervisor have no trades or exposure
    // Tick at NOW
    s.tick(NOW);
    await s.runNow("commander"); // joins the scheduled run; no work survives test cleanup

    // Supervisor, coach, sales, treasurer should not have called chat because they had no meaningful work
    const nonCommanderCalls = calls.filter((c) => c.req.agent !== "commander");
    expect(nonCommanderCalls.length).toBe(0);
  });

  test("manual runNow bypasses novelty check", async () => {
    const { chat, calls } = fakeChat({
      "test/primary": ({ req }) => answer(dummyDecision, req.model),
    });
    const r = rig({ chat });
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });

    // Even though supervisor has no meaningful work:
    expect(s.hasMeaningfulWork("supervisor", NOW).hasWork).toBe(false);

    // Manual runNow executes anyway
    const res = await s.runNow("supervisor");
    expect(res.primary.applied).toBe(true);
    expect(calls.filter((c) => c.req.agent === "supervisor").length).toBe(1);
  });

  test("repeated vetoes for an unchanged blocked rule do not buy another review", () => {
    const r = rig();
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });
    insertVeto(r, 6, "nav <= 0");
    s.recordNoveltyBaseline("supervisor");
    s.recordNoveltyBaseline("commander");
    insertVeto(r, 6, "nav <= 0");
    expect(s.hasMeaningfulWork("supervisor", NOW).hasWork).toBe(false);
    expect(s.hasMeaningfulWork("commander", NOW).hasWork).toBe(false);
    insertVeto(r, 8, "drawdown");
    expect(s.hasMeaningfulWork("supervisor", NOW).hasWork).toBe(true);
  });

  test("schema correction cannot spend after the preceding response reaches the daily cap", async () => {
    const { chat, calls } = fakeChat({ "test/primary": ({ req }) => answer("invalid JSON", req.model, 5) });
    const r = rig({ chat });
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });
    const result = await s.runNow("supervisor");
    expect(calls).toHaveLength(1);
    expect(result.primary.applied).toBe(false);
    expect(r.deps.ledger.llmCostToday()).toBe(5);
  });
});

describe("Scheduler runtimeStatus", () => {
  test("reports active status for configured agents", () => {
    const r = rig();
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });
    expect(s.runtimeStatus().commander.active).toBe(false);
    s.start();

    const status = s.runtimeStatus();
    for (const name of AGENT_NAMES) {
      expect(status[name]).toBeDefined();
      expect(status[name].active).toBe(true);
    }
    s.stop();
    expect(s.runtimeStatus().commander.active).toBe(false);

    // When credits are exhausted:
    s.pausedUntil = NOW + 100_000;
    const pausedStatus = s.runtimeStatus();
    for (const name of AGENT_NAMES) {
      expect(pausedStatus[name].active).toBe(false);
    }
  });
});
