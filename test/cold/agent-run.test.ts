import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MAX_TOOL_CALLS, reportsDir, runAgent } from "../../src/cold/agent.ts";
import { coach } from "../../src/cold/agents/coach.ts";
import { commander } from "../../src/cold/agents/commander.ts";
import { treasurer } from "../../src/cold/agents/treasurer.ts";
import type { ChatResult } from "../../src/cold/llm.ts";
import { loadConfig, writeEngines } from "../../src/core/config.ts";
import { readBudgets } from "../../src/core/state.ts";
import type { EngineId } from "../../src/core/types.ts";
import { ENGINE_PARAM_BOUNDS } from "../../src/hot/engines/engine.ts";
import { answer, fakeChat, type Rig, rig } from "./rig.ts";

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose();
});

const CFG = { model: "test/primary", shadow_model: "test/shadow", temperature: 0 };

/** Strict-schema patch: every param key present (null = unchanged), like a compliant model reply. */
function patch(engine: EngineId, params: Record<string, number>) {
  const full: Record<string, number | boolean | null> = {};
  for (const k of Object.keys(ENGINE_PARAM_BOUNDS[engine])) full[k] = null;
  if (engine === "liqfade") full.allowMarket = null;
  return { engine, enabled: null, paper: null, symbols: null, sizeUsd: null, params: { ...full, ...params }, rationale: "test" };
}
const primaryOut = { regime: "NORMAL", patches: [patch("basis", { zEntry: 2.5 }), patch("liqfade", { tpBps: 40 })], notes: "" };
const shadowOut = { regime: "NORMAL", patches: [patch("basis", { zEntry: 2.5 })], notes: "" };

interface RunRow {
  run_id: string;
  role: string;
  model: string;
  applied: number;
  schema_valid: number;
  agreement_pct: number | null;
  tool_rejections: number;
  decision_json: string;
}

function rows(r: Rig): RunRow[] {
  return r.deps.ledger.db.query<RunRow, []>("SELECT run_id, role, model, applied, schema_valid, agreement_pct, tool_rejections, decision_json FROM agent_runs ORDER BY role").all();
}

describe("runAgent primary + shadow", () => {
  test("two agent_runs rows share run_id; shadow applied=0 and never writes; agreement populated", async () => {
    const { chat } = fakeChat({
      "test/primary": ({ req }) => answer(primaryOut, req.model, 0.02),
      "test/shadow": ({ req }) => answer(shadowOut, req.model, 0.005),
    });
    const r = rig({ chat });
    rigs.push(r);
    const decisions: string[] = [];
    r.deps.bus?.on("agent.decision", (d) => decisions.push(`${d.role}:${d.applied}`));

    const res = await runAgent(commander, CFG, r.deps);
    expect(res.primary.applied).toBe(true);
    expect(res.primary.model).toBe("test/primary");
    expect(res.shadow?.model).toBe("test/shadow");
    expect(res.shadow?.applied).toBe(false);
    // Jaccard: primary {basis.params.zEntry=2.5, liqfade.params.tpBps=40}, shadow {basis.params.zEntry=2.5} -> 50%
    expect(res.shadow?.agreementPct).toBe(50);

    const engines = loadConfig(r.configDir).engines.engines;
    expect(engines.basis.params.zEntry).toBe(2.5);
    expect(engines.liqfade.params.tpBps).toBe(40);

    const all = rows(r);
    expect(all.length).toBe(2);
    const [primary, shadow] = all;
    expect(primary?.role).toBe("primary");
    expect(shadow?.role).toBe("shadow");
    expect(primary?.run_id).toBe(res.runId);
    expect(shadow?.run_id).toBe(res.runId);
    expect(primary?.applied).toBe(1);
    expect(shadow?.applied).toBe(0);
    expect(shadow?.schema_valid).toBe(1);
    expect(primary?.agreement_pct).toBe(50);
    expect(shadow?.agreement_pct).toBe(50);
    expect(JSON.parse(shadow?.decision_json ?? "null")).toEqual(shadowOut);

    const llm = r.deps.ledger.db.query<{ role: string; run_id: string }, []>("SELECT role, run_id FROM llm_calls ORDER BY role").all();
    expect(llm.map((x) => x.role)).toEqual(["primary", "shadow"]);
    expect(llm.every((x) => x.run_id === res.runId)).toBe(true);
    expect(decisions.sort()).toEqual(["primary:true", "shadow:false"]);
  });

  test("corrective retry: invalid JSON first, valid second; primary applied; shadow failing twice is recorded schema_valid=0", async () => {
    const { chat, calls } = fakeChat({
      "test/primary": ({ req }, i) => (i === 0 ? answer("Sure! Here is my analysis without JSON.", req.model) : answer(primaryOut, req.model)),
      "test/shadow": ({ req }) => answer({ regime: "WRONG" }, req.model),
    });
    const r = rig({ chat });
    rigs.push(r);
    const res = await runAgent(commander, CFG, r.deps);
    expect(res.primary.schemaValid).toBe(true);
    expect(res.primary.applied).toBe(true);
    expect(res.shadow?.schemaValid).toBe(false);
    expect(res.shadow?.agreementPct).toBeNull();

    const primaryCalls = calls.filter((c) => c.req.model === "test/primary");
    expect(primaryCalls.length).toBe(2);
    const retryMsg = primaryCalls[1]?.req.messages.at(-1);
    expect(retryMsg?.role).toBe("user");
    expect(retryMsg?.content).toContain("failed schema validation");
    expect(calls.filter((c) => c.req.model === "test/shadow").length).toBe(2);

    const all = rows(r);
    expect(all.find((x) => x.role === "shadow")?.schema_valid).toBe(0);
    expect(all.find((x) => x.role === "shadow")?.agreement_pct).toBeNull();
    expect(all.find((x) => x.role === "primary")?.applied).toBe(1);
  });

  test("tool loop: read tool answered, budget capped at MAX_TOOL_CALLS, then the final decision", async () => {
    const { chat, calls } = fakeChat({
      "test/primary": ({ req }, i) => {
        if (i === 0) {
          const toolCalls = Array.from({ length: MAX_TOOL_CALLS + 2 }, (_, k) => ({ id: `c${k}`, name: k === 0 ? "engines.get" : "ledger.latencyStats", args: {} }));
          const r: ChatResult = { ...answer(null, req.model), content: null, parsed: undefined, toolCalls };
          return r;
        }
        return answer(primaryOut, req.model);
      },
    });
    const r = rig({ chat });
    rigs.push(r);
    const res = await runAgent(commander, { model: "test/primary", temperature: 0 }, r.deps);
    expect(res.primary.applied).toBe(true);
    expect(calls.length).toBe(2);
    const second = calls[1]?.req;
    expect(second?.tools).toBeUndefined(); // budget exhausted: no tools offered on the final call
    const toolMsgs = second?.messages.filter((m) => m.role === "tool") ?? [];
    expect(toolMsgs.length).toBe(MAX_TOOL_CALLS + 2);
    expect(toolMsgs.filter((m) => m.content?.includes("tool budget exhausted")).length).toBe(2);
    expect(JSON.parse(toolMsgs[0]?.content ?? "{}").result.engines.liqfade.sizeUsd).toBe(200);
  });

  test("primary LLM failure: applied=false, config unchanged, row recorded", async () => {
    const { chat } = fakeChat({
      "test/primary": () => {
        throw new Error("boom");
      },
    });
    const r = rig({ chat });
    rigs.push(r);
    const before = loadConfig(r.configDir).engines;
    const res = await runAgent(commander, { model: "test/primary", temperature: 0 }, r.deps);
    expect(res.primary.applied).toBe(false);
    expect(res.primary.schemaValid).toBe(false);
    expect(res.primary.error).toBe("boom");
    expect(loadConfig(r.configDir).engines).toEqual(before);
    expect(rows(r).length).toBe(1);
  });

  test("treasurer: budgets written by primary only, report file written by primary only", async () => {
    const out = {
      budgets: { liqfade: 1000, basis: 1500, convert: null, smmirror: null, cexdex: null, tokstock: null, swing: null },
      llm_daily_budget_usd: null,
      data_daily_budget_usd: null,
      purchases: [],
      transfer_requests: ["Move 500 USDT spot -> futures to fund basis"],
      notes: "n",
    };
    const { chat } = fakeChat({
      "test/primary": ({ req }) => answer(out, req.model),
      "test/shadow": ({ req }) => answer({ ...out, budgets: { ...out.budgets, basis: 2000 } }, req.model),
    });
    const r = rig({ chat });
    rigs.push(r);
    const res = await runAgent(treasurer, CFG, r.deps);
    expect(res.primary.applied).toBe(true);
    expect(readBudgets(r.stateDir)).toEqual({ liqfade: 1000, basis: 1500 });
    const report = join(reportsDir(r.deps), "transfer-requests.md");
    expect(readFileSync(report, "utf8")).toContain("Move 500 USDT");
    expect(res.shadow?.agreementPct).toBeGreaterThan(90);
    expect(res.shadow?.agreementPct).toBeLessThan(100);
  });

  test("coach: demotion merges into the patch call and the dated report is written", async () => {
    const out = { postmortem: "basis bled fees", patches: [patch("basis", { zEntry: 3 })], demote: ["liqfade"] };
    const { chat } = fakeChat({ "test/primary": ({ req }) => answer(out, req.model) });
    const r = rig({ chat });
    rigs.push(r);
    // Start liqfade live so the demotion is observable.
    await writeEngines(r.configDir, { engines: { liqfade: { paper: false } } }, "operator");
    const res = await runAgent(coach, { model: "test/primary", temperature: 0 }, r.deps);
    expect(res.primary.applied).toBe(true);
    const engines = loadConfig(r.configDir).engines.engines;
    expect(engines.liqfade.paper).toBe(true);
    expect(engines.basis.params.zEntry).toBe(3);
    expect(existsSync(join(reportsDir(r.deps), "2025-10-09.md"))).toBe(true);
  });
});
