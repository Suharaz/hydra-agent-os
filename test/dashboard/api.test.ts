import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/core/config.ts";
import { authed, type Rig, startRig } from "./helpers.ts";

let rig: Rig;

beforeAll(() => {
  rig = startRig();
});

afterAll(() => {
  rig.stop();
});

const put = (path: string, body: unknown) => fetch(`${rig.base}${path}`, authed({ method: "PUT", body: JSON.stringify(body) }));
const post = (path: string, body: unknown) => fetch(`${rig.base}${path}`, authed({ method: "POST", body: JSON.stringify(body) }));
const configChanges = () => rig.ledger.db.query<{ actor: string; path: string; diff: string }, []>("SELECT actor, path, diff FROM config_changes ORDER BY id").all();

describe("PUT /api/config/agents", () => {
  test("unknown key, unknown agent and bad model id are 400 with problems; nothing written", async () => {
    const before = loadConfig(rig.dir).agents;
    const r1 = await put("/api/config/agents", { commander: { allowed_symbols: ["BTCUSDT"] } });
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { problems: string[] }).problems[0]).toContain("commander.allowed_symbols");
    expect((await put("/api/config/agents", { janitor: { model: "openai/x" } })).status).toBe(400);
    expect((await put("/api/config/agents", { commander: { model: "GPT 5" } })).status).toBe(400);
    expect((await put("/api/config/agents", { commander: { interval: "bogus" } })).status).toBe(400);
    expect(loadConfig(rig.dir).agents).toEqual(before);
    expect(configChanges()).toHaveLength(0);
  });

  test("commander model change is 200, visible via loadConfig and GET, and logged as an operator config_changes row", async () => {
    const res = await put("/api/config/agents", { commander: { model: "anthropic/claude-sonnet-4.6", temperature: 0.3 } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean; agents: { commander: { model: string; temperature: number } } };
    expect(body.changed).toBe(true);
    expect(body.agents.commander.model).toBe("anthropic/claude-sonnet-4.6");
    const cfg = loadConfig(rig.dir).agents.agents.commander;
    expect(cfg.model).toBe("anthropic/claude-sonnet-4.6");
    expect(cfg.temperature).toBe(0.3);

    const rows = configChanges();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe("operator:bearer");
    expect(rows[0]?.path).toContain("agents.yaml");
    expect(JSON.parse(rows[0]?.diff ?? "{}")).toMatchObject({ "agents.commander.model": { from: "claude-fable-5-1", to: "anthropic/claude-sonnet-4.6" } });

    const get = (await (await fetch(`${rig.base}/api/config/agents`, authed())).json()) as { agents: { commander: { model: string } } };
    expect(get.agents.commander.model).toBe("anthropic/claude-sonnet-4.6");
  });

  test("interval/cron exclusivity is enforced by the file schema (cron agent given an interval is 400)", async () => {
    const res = await put("/api/config/agents", { coach: { interval: "5m" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { problems: string[] }).problems.join(" ")).toContain("exactly one of interval or cron");
  });
});

describe("PUT /api/config/budgets", () => {
  test("safety cap key is 400; negative value is 400; the two budget keys are written and logged", async () => {
    expect((await put("/api/config/budgets", { daily_drawdown_kill_pct: 50 })).status).toBe(400);
    expect((await put("/api/config/budgets", { nav_usd_cap: 1 })).status).toBe(400);
    expect((await put("/api/config/budgets", { llm_daily_budget_usd: -1 })).status).toBe(400);
    const before = configChanges().length;

    const res = await put("/api/config/budgets", { llm_daily_budget_usd: 3.5, data_daily_budget_usd: 1.25 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true, llm_daily_budget_usd: 3.5, data_daily_budget_usd: 1.25 });
    const risk = loadConfig(rig.dir).risk;
    expect(risk.llm_daily_budget_usd).toBe(3.5);
    expect(risk.data_daily_budget_usd).toBe(1.25);
    expect(configChanges()).toHaveLength(before + 1);
    expect(configChanges().at(-1)?.path).toContain("risk.yaml");

    const get = (await (await fetch(`${rig.base}/api/config/budgets`, authed())).json()) as Record<string, number>;
    expect(get).toEqual({ llm_daily_budget_usd: 3.5, data_daily_budget_usd: 1.25 });
  });
});

describe("POST /api/kill", () => {
  test("missing confirm is 400; confirmed without a running executor is 503", async () => {
    expect((await post("/api/kill", { reason: "oops" })).status).toBe(400);
    expect((await post("/api/kill", { confirm: "kill" })).status).toBe(400);
    expect((await post("/api/kill", { confirm: "KILL", reason: "test" })).status).toBe(503);
  });
});

describe("POST /api/config/agents/:agent/promote-shadow", () => {
  test("swaps shadow into primary (old primary becomes the shadow); agent without a shadow is 400", async () => {
    await put("/api/config/agents", { commander: { shadow_model: "openai/gpt-5.6-sol" } });
    const before = loadConfig(rig.dir).agents.agents.commander;
    expect(before.shadow_model).toBeDefined();
    const res = await post("/api/config/agents/commander/promote-shadow", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, agent: "commander", model: before.shadow_model, shadow_model: before.model });
    const after = loadConfig(rig.dir).agents.agents.commander;
    expect(after.model).toBe(before.shadow_model as string);
    expect(after.shadow_model).toBe(before.model);

    expect((await post("/api/config/agents/supervisor/promote-shadow", {})).status).toBe(400);
    expect((await post("/api/config/agents/nobody/promote-shadow", {})).status).toBe(400);
  });
});

describe("reads", () => {
  test("agents/ab reflects current primary + shadow and the days guard; runs and models endpoints answer", async () => {
    rig.ledger.insertAgentRun({ runId: "r1", agent: "commander", role: "primary", model: "google/gemini-3.6-flash", decision: { regime: "calm" }, applied: true, toolRejections: 0, costUsd: 0.01, latencyMs: 800, schemaValid: true, agreementPct: 100 });
    rig.ledger.insertAgentRun({ runId: "r1", agent: "commander", role: "shadow", model: "anthropic/claude-sonnet-4.6", decision: { regime: "calm" }, applied: false, toolRejections: 1, costUsd: 0.02, latencyMs: 1200, schemaValid: true, agreementPct: 100 });

    expect((await fetch(`${rig.base}/api/agents/ab?days=2`, authed())).status).toBe(400);
    const ab = (await (await fetch(`${rig.base}/api/agents/ab?days=1`, authed())).json()) as {
      agents: Array<{ agent: string; primary: string; shadow: string | null; metrics: Record<string, { runs: number; toolRejectRate: number }> }>;
    };
    const commander = ab.agents.find((a) => a.agent === "commander");
    expect(commander?.primary).toBe("openai/gpt-5.6-sol");
    expect(commander?.shadow).toBe("anthropic/claude-sonnet-4.6");
    expect(commander?.metrics["google/gemini-3.6-flash"]?.runs).toBe(1);
    expect(commander?.metrics["anthropic/claude-sonnet-4.6"]?.toolRejectRate).toBe(1);

    const runs = (await (await fetch(`${rig.base}/api/agents/runs?limit=1&agent=commander`, authed())).json()) as { runs: Array<{ role: string; decision: unknown; schemaValid: boolean }> };
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]).toMatchObject({ role: "shadow", decision: { regime: "calm" }, schemaValid: true });

    const models = (await (await fetch(`${rig.base}/api/models`, authed())).json()) as { models: string[] };
    expect(models.models).toEqual(["openai/gpt-5.6-luna"]);
    const pnl = (await (await fetch(`${rig.base}/api/ledger/pnl?days=7`, authed())).json()) as { days: number; total: { net: number } };
    expect(pnl).toMatchObject({ days: 7, total: { net: 0 } });
  });
});

describe("truthful dashboard data", () => {
  test("order sizing cannot become account equity when the executor is unavailable", async () => {
    const state = (await (await fetch(`${rig.base}/api/state`)).json()) as { capital: { navUsd: number | null; initialUsd: number | null }; executor: { started: boolean } };
    expect(state.capital.navUsd).toBeNull();
    expect(state.capital.initialUsd).toBeNull();
    expect(state.executor.started).toBe(false);
  });

  test("dream memory uses this dashboard's state directory and excludes unverified legacy lessons", async () => {
    const file = join(rig.stateDir, "dream-memory.json");
    writeFileSync(file, JSON.stringify({
      updatedAt: Date.now(), totalCycles: 3, history: [],
      lessons: [{ id: "lesson-01", title: "Synthetic loss", invariantRule: "Always trade", confidence: 0.96 }],
    }));
    const res = await fetch(`${rig.base}/api/dream/memory`);
    expect(res.status).toBe(200);
    const memory = (await res.json()) as { lessons: unknown[]; totalCycles: number };
    expect(memory.lessons).toEqual([]);
    expect(memory.totalCycles).toBe(0);
    expect(existsSync(`${file}.quarantine`)).toBe(true);
  });
});
