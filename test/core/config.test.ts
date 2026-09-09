import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { bus } from "../../src/core/bus.ts";
import {
  AgentsSchema,
  ConfigError,
  OwnerError,
  RiskSchema,
  applyModelOverrides,
  loadConfig,
  watchAgents,
  writeAgents,
  writeBudgets,
  writeEngines,
} from "../../src/core/config.ts";
import { openLedger } from "../../src/core/ledger.ts";
import { cleanup, tempConfigDir, until } from "./helpers.ts";

const dirs: string[] = [];
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  for (const d of dirs.splice(0)) cleanup(d);
});
function scratch(): string {
  const d = tempConfigDir();
  dirs.push(d);
  return d;
}

describe("schemas", () => {
  const valid = loadConfig(tempConfigDir()).agents;

  test("repo config loads", () => {
    const cfg = loadConfig(tempConfigDir());
    expect(Object.keys(cfg.agents.agents).sort()).toEqual(["coach", "commander", "sales", "supervisor", "treasurer"]);
    expect(cfg.risk.allowed_symbols.futures).toContain("BTCUSDT");
    expect(cfg.pricing.routes["/v1/signals/basis"]?.price_usd).toBe(0.05);
  });

  test("unknown agent key rejected", () => {
    const r = AgentsSchema.safeParse({ agents: { ...valid.agents, intern: { model: "a/b", interval: "1m", temperature: 0 } } });
    expect(r.success).toBe(false);
  });

  test("missing agent key rejected", () => {
    const { sales: _sales, ...rest } = valid.agents;
    expect(AgentsSchema.safeParse({ agents: rest }).success).toBe(false);
  });

  test("bad model id rejected", () => {
    for (const model of ["OpenAI/gpt-5", "openai/", "openai/gpt 5", "a/b/c!"]) {
      const r = AgentsSchema.safeParse({ agents: { ...valid.agents, sales: { ...valid.agents.sales, model } } });
      expect(r.success).toBe(false);
    }
    const ok = AgentsSchema.safeParse({ agents: { ...valid.agents, sales: { ...valid.agents.sales, model: "openai/gpt-5.6-luna:free" } } });
    expect(ok.success).toBe(true);
  });

  test("interval xor cron", () => {
    const both = { ...valid.agents.sales, cron: "0 * * * *" };
    expect(AgentsSchema.safeParse({ agents: { ...valid.agents, sales: both } }).success).toBe(false);
    const { interval: _i, ...neither } = valid.agents.sales;
    expect(AgentsSchema.safeParse({ agents: { ...valid.agents, sales: neither } }).success).toBe(false);
    expect(AgentsSchema.safeParse({ agents: { ...valid.agents, sales: { ...neither, cron: "*/5 * * * *" } } }).success).toBe(true);
  });

  test("risk without allowed_symbols rejected", () => {
    const risk = parseYaml(readFileSync(join(tempConfigDir(), "risk.yaml"), "utf8")) as Record<string, unknown>;
    expect(RiskSchema.safeParse(risk).success).toBe(true);
    const { allowed_symbols: _a, ...rest } = risk;
    const r = RiskSchema.safeParse(rest);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path[0] === "allowed_symbols")).toBe(true);
  });

  test("loadConfig reports every file's issues at once", () => {
    const dir = scratch();
    writeFileSync(join(dir, "agents.yaml"), "agents:\n  commander: { model: nope, interval: 1m, temperature: 0 }\n");
    writeFileSync(join(dir, "risk.yaml"), "nav_usd_cap: -1\n");
    let err: unknown;
    try {
      loadConfig(dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const problems = (err as ConfigError).problems;
    expect(problems.some((p) => p.startsWith("agents.yaml:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("risk.yaml:") && p.includes("allowed_symbols"))).toBe(true);
  });

  test("applyModelOverrides replaces only the named agent's model", () => {
    const out = applyModelOverrides(valid, { coach: "x/y" });
    expect(out.agents.coach.model).toBe("x/y");
    expect(out.agents.coach.cron).toBe(valid.agents.coach.cron);
    expect(out.agents.commander.model).toBe(valid.agents.commander.model);
    expect(valid.agents.coach.model).not.toBe("x/y");
  });
});

describe("writes", () => {
  test("writeAgents by commander throws OwnerError", () => {
    const dir = scratch();
    const before = readFileSync(join(dir, "agents.yaml"), "utf8");
    expect(() => writeAgents(dir, { commander: { model: "x/y" } }, "commander" as never)).toThrow(OwnerError);
    expect(readFileSync(join(dir, "agents.yaml"), "utf8")).toBe(before);
  });

  test("writeEngines accepts commander/coach/operator, rejects supervisor", async () => {
    const dir = scratch();
    const paper0 = loadConfig(dir).engines.engines.liqfade.paper;
    await writeEngines(dir, { liqfade: { enabled: true, symbols: ["BTCUSDT"] } }, "commander");
    await writeEngines(dir, { basis: { sizeUsd: 50 } }, "coach");
    expect(() => writeEngines(dir, { basis: { sizeUsd: 1 } }, "supervisor" as never)).toThrow(OwnerError);
    const cfg = loadConfig(dir).engines.engines;
    expect(cfg.liqfade.enabled).toBe(true);
    expect(cfg.liqfade.symbols).toEqual(["BTCUSDT"]);
    expect(cfg.liqfade.paper).toBe(paper0);
    expect(cfg.basis.sizeUsd).toBe(50);
  });

  test("writeAgents by operator triggers watchAgents callback and config.reload", async () => {
    const dir = scratch();
    const seen: Array<{ model: string; hash: string }> = [];
    const reloads: string[] = [];
    disposers.push(watchAgents(dir, (cfg, hash) => seen.push({ model: cfg.agents.commander.model, hash })));
    disposers.push(bus.on("config.reload", (e) => reloads.push(e.file)));

    const r = await writeAgents(dir, { commander: { model: "x/y" } }, "operator");
    expect(r.changed).toBe(true);
    await until(() => seen.length > 0, 2000);
    expect(seen[0]?.model).toBe("x/y");
    expect(seen[0]?.hash).toBe(r.hash);
    expect(reloads).toContain("agents");

    // Hash gate: a no-op rewrite fires nothing; the next real change is exactly the second callback.
    const noop = await writeAgents(dir, { commander: { model: "x/y" } }, "operator");
    expect(noop.changed).toBe(false);
    await writeAgents(dir, { commander: { model: "x/z" } }, "operator");
    await until(() => seen.length >= 2, 2000);
    expect(seen.map((s) => s.model)).toEqual(["x/y", "x/z"]);
    // YAML comments/structure preserved: file still parses and other agents untouched.
    const cfg = loadConfig(dir).agents.agents;
    expect(cfg.treasurer.model).toBe("gpt-4.1");
    expect(cfg.supervisor.model).toBe("deepseek-v4-pro");
  });

  test("invalid patch is rejected and file untouched", async () => {
    const dir = scratch();
    const before = readFileSync(join(dir, "agents.yaml"), "utf8");
    await expect(writeAgents(dir, { commander: { model: "bad id" } }, "operator")).rejects.toBeInstanceOf(ConfigError);
    await expect(writeAgents(dir, { commander: { nonsense: 1 } }, "operator")).rejects.toBeInstanceOf(ConfigError);
    expect(readFileSync(join(dir, "agents.yaml"), "utf8")).toBe(before);
  });

  test("writeBudgets rejects non-budget keys and wrong actor", async () => {
    const dir = scratch();
    expect(() => writeBudgets(dir, { nav_usd_cap: 1 } as never, "operator")).toThrow(ConfigError);
    expect(() => writeBudgets(dir, { llm_daily_budget_usd: 1 }, "treasurer" as never)).toThrow(OwnerError);
    expect(() => writeBudgets(dir, { llm_daily_budget_usd: -1 }, "operator")).toThrow(ConfigError);
    await writeBudgets(dir, { llm_daily_budget_usd: 7.5 }, "operator");
    const raw = readFileSync(join(dir, "risk.yaml"), "utf8");
    expect(raw).toContain("# Code-owned."); // comments preserved
    const risk = loadConfig(dir).risk;
    expect(risk.llm_daily_budget_usd).toBe(7.5);
    expect(risk.data_daily_budget_usd).toBe(1);
  });

  test("config_changes row written when ledger passed; no row on no-op", async () => {
    const dir = scratch();
    const ledger = openLedger(join(dir, "l.sqlite"));
    try {
      await writeEngines(dir, { cexdex: { sizeUsd: 25 } }, "operator", ledger);
      const noop = await writeEngines(dir, { cexdex: { sizeUsd: 25 } }, "operator", ledger);
      expect(noop.changed).toBe(false);
      const rows = ledger.db.query<{ actor: string; path: string; before_hash: string; after_hash: string; diff: string }, []>("SELECT actor, path, before_hash, after_hash, diff FROM config_changes").all();
      expect(rows.length).toBe(1);
      const row = rows[0];
      expect(row?.actor).toBe("operator");
      expect(row?.path.endsWith("engines.yaml")).toBe(true);
      expect(row?.before_hash).not.toBe(row?.after_hash);
      const diff = JSON.parse(row?.diff ?? "{}") as Record<string, { from: unknown; to: unknown }>;
      expect(Object.keys(diff)).toEqual(["engines.cexdex.sizeUsd"]);
      expect(diff["engines.cexdex.sizeUsd"]?.to).toBe(25);
    } finally {
      ledger.close();
    }
  });

  test("concurrent writes serialize and both land", async () => {
    const dir = scratch();
    await Promise.all([
      writeEngines(dir, { liqfade: { sizeUsd: 1 } }, "operator"),
      writeEngines(dir, { basis: { sizeUsd: 2 } }, "operator"),
      writeEngines(dir, { convert: { sizeUsd: 3 } }, "operator"),
    ]);
    const e = loadConfig(dir).engines.engines;
    expect([e.liqfade.sizeUsd, e.basis.sizeUsd, e.convert.sizeUsd]).toEqual([1, 2, 3]);
  });
});
