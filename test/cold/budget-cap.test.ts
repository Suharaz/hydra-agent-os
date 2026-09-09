import { afterEach, describe, expect, test } from "bun:test";

import { AGENT_MODULES, cronMatches, parseCron, parseInterval, Scheduler } from "../../src/cold/scheduler.ts";
import type { AgentsConfig } from "../../src/core/config.ts";
import { LlmError } from "../../src/cold/llm.ts";
import { answer, fakeChat, NOW, type Rig, rig } from "./rig.ts";

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose();
});

const AGENTS: AgentsConfig = {
  agents: {
    commander: { model: "test/primary", shadow_model: "test/shadow", interval: "5m", temperature: 0 },
    supervisor: { model: "test/primary", interval: "1m", temperature: 0 },
    treasurer: { model: "test/primary", interval: "15m", temperature: 0 },
    coach: { model: "test/primary", interval: "1h", temperature: 0 },
    sales: { model: "test/primary", interval: "30m", temperature: 0 },
  },
};

/** Records `usd` of LLM spend today (risk.yaml budget is $5). */
function spend(r: Rig, usd: number): void {
  r.deps.ledger.insertLlmCall({ runId: "seed", agent: "commander", role: "primary", model: "x", promptTokens: 1, completionTokens: 1, costUsd: usd, latencyMs: 1, schemaValid: true });
}

const supervisorOut = {
  action: "none",
  overlay: {
    nav_usd_cap: null,
    max_net_delta_pct: null,
    max_leverage: null,
    min_liq_distance_pct: null,
    max_orders_per_sec: null,
    daily_drawdown_kill_pct: null,
    per_engine_max_notional_usd: { liqfade: null, basis: null, convert: null, smmirror: null, cexdex: null, tokstock: null },
    onchain_max_notional_usd: null,
    engines_paused: null,
    expires_in_min: null,
  },
  kill_reason: null,
  rationale: "ok",
};
const commanderOut = { regime: "NORMAL", patches: [], notes: "" };

describe("daily LLM budget gates", () => {
  test("due() at 0 / 70 / 80 / 90 / 100 % of llm_daily_budget_usd", () => {
    const r = rig();
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });
    expect(s.due(NOW)).toEqual(["commander", "supervisor", "treasurer", "coach", "sales"]);
    spend(r, 3.5); // 70%: everyone still runs (shadow is dropped, see below)
    expect(s.due(NOW)).toEqual(["commander", "supervisor", "treasurer", "coach", "sales"]);
    spend(r, 0.5); // 80%: coach + sales paused
    expect(s.due(NOW)).toEqual(["commander", "supervisor", "treasurer"]);
    spend(r, 0.5); // 90%: treasurer paused
    expect(s.due(NOW)).toEqual(["commander", "supervisor"]);
    spend(r, 0.5); // 100%: no further LLM requests, including supervisor
    expect(s.due(NOW)).toEqual([]);
    spend(r, 10);
    expect(s.due(NOW)).toEqual([]);
  });

  test("shadow disabled at >= 70%: the shadow model is never called", async () => {
    const { chat, calls } = fakeChat({
      "test/primary": ({ req }) => answer(commanderOut, req.model),
      "test/shadow": ({ req }) => answer(commanderOut, req.model),
    });
    const r = rig({ chat });
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });
    const both = await s.runNow("commander");
    expect(both.shadow?.model).toBe("test/shadow");
    spend(r, 3.5);
    const primaryOnly = await s.runNow("commander");
    expect(primaryOnly.shadow).toBeUndefined();
    expect(calls.filter((c) => c.req.model === "test/shadow").length).toBe(1);
  });

  test("interval schedule and per-agent mutex", async () => {
    const gate = Promise.withResolvers<void>();
    const { chat } = fakeChat({
      "test/primary": async ({ req }) => {
        await gate.promise;
        return answer(supervisorOut, req.model);
      },
    });
    const r = rig({ chat });
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });
    const p1 = s.runNow("supervisor");
    expect(s.due(NOW)).not.toContain("supervisor"); // in flight
    const p2 = s.runNow("supervisor");
    expect(p2).toBe(p1); // joined, not a second run
    gate.resolve();
    const res = await p1;
    expect(res.primary.applied).toBe(true);
    expect(s.due(NOW + 30_000)).not.toContain("supervisor"); // 1m interval not elapsed
    expect(s.due(NOW + 60_000)).toContain("supervisor");
  });

  test("402 credits pauses every agent (supervisor included) until the next UTC day", async () => {
    const { chat } = fakeChat({
      "test/primary": () => {
        throw new LlmError("credits", 402, "yescale: insufficient credits");
      },
    });
    const r = rig({ chat });
    rigs.push(r);
    const s = new Scheduler({ ...r.deps, agents: () => AGENTS, modules: AGENT_MODULES });
    const res = await s.runNow("supervisor");
    expect(res.primary.applied).toBe(false);
    expect(res.primary.errorCode).toBe("credits");
    expect(s.due(NOW + 60_000)).toEqual([]);
    const nextDay = NOW - (NOW % 86_400_000) + 86_400_000;
    expect(s.due(nextDay)).toContain("supervisor");
  });

  test("interval and cron parsing", () => {
    expect(parseInterval("30s")).toBe(30_000);
    expect(parseInterval("5m")).toBe(300_000);
    expect(parseInterval("1h")).toBe(3_600_000);
    expect(() => parseInterval("5 minutes")).toThrow();
    const midnight = parseCron("0 0 * * *");
    expect(cronMatches(midnight, Date.UTC(2025, 9, 9, 0, 0, 30))).toBe(true);
    expect(cronMatches(midnight, Date.UTC(2025, 9, 9, 0, 1, 0))).toBe(false);
    const every15 = parseCron("*/15 9-17 * * 1-5");
    expect(cronMatches(every15, Date.UTC(2025, 9, 9, 9, 45))).toBe(true); // Thursday
    expect(cronMatches(every15, Date.UTC(2025, 9, 9, 9, 50))).toBe(false);
    expect(cronMatches(every15, Date.UTC(2025, 9, 11, 9, 45))).toBe(false); // Saturday
    expect(() => parseCron("0 0 * *")).toThrow();
    expect(() => parseCron("60 0 * * *")).toThrow();
  });
});
