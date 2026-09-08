import { afterEach, describe, expect, test } from "bun:test";

import { runAgent } from "../../src/cold/agent.ts";
import { commander } from "../../src/cold/agents/commander.ts";
import { buildTools } from "../../src/cold/tools.ts";
import { loadConfig } from "../../src/core/config.ts";
import { ENGINE_PARAM_BOUNDS } from "../../src/hot/engines/engine.ts";
import { answer, fakeChat, type Rig, rig } from "./rig.ts";

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose();
});

const CFG = { model: "test/primary", temperature: 0 };

describe("engines.patch bounds + whitelist", () => {
  test("param outside bounds is rejected and nothing is written", async () => {
    const r = rig();
    rigs.push(r);
    const tools = buildTools(r.toolDeps, "commander", "apply");
    const before = loadConfig(r.configDir).engines;
    const res = await tools.call("engines.patch", { patches: [{ engine: "liqfade", params: { windowMs: 9000 } }] });
    expect(res.ok).toBe(false);
    expect(res.rejected).toContain("windowMs=9000 outside");
    expect(tools.rejections).toBe(1);
    expect(loadConfig(r.configDir).engines).toEqual(before);
  });

  test("symbol outside allowed_symbols is rejected", async () => {
    const r = rig();
    rigs.push(r);
    const tools = buildTools(r.toolDeps, "commander", "apply");
    const res = await tools.call("engines.patch", { patches: [{ engine: "liqfade", symbols: ["DOGEUSDT"] }] });
    expect(res.ok).toBe(false);
    expect(res.rejected).toContain("DOGEUSDT");
  });

  test("all-or-nothing: one bad patch sinks the valid one", async () => {
    const r = rig();
    rigs.push(r);
    const tools = buildTools(r.toolDeps, "commander", "apply");
    const res = await tools.call("engines.patch", {
      patches: [
        { engine: "basis", params: { zEntry: 2.5 } },
        { engine: "liqfade", sizeUsd: 999_999 },
      ],
    });
    expect(res.ok).toBe(false);
    expect(loadConfig(r.configDir).engines.engines.basis.params.zEntry).toBe(2);
  });

  test("in-bounds patch is written; a write outside the agent's scope is rejected", async () => {
    const r = rig();
    rigs.push(r);
    const tools = buildTools(r.toolDeps, "commander", "apply");
    const ok = await tools.call("engines.patch", { patches: [{ engine: "basis", params: { zEntry: 2.5 }, sizeUsd: 300 }] });
    expect(ok.ok).toBe(true);
    const after = loadConfig(r.configDir).engines.engines.basis;
    expect(after.params.zEntry).toBe(2.5);
    expect(after.sizeUsd).toBe(300);
    const scope = await tools.call("limits.tighten", { patch: { max_leverage: 2 } });
    expect(scope.ok).toBe(false);
    expect(scope.rejected).toContain("outside commander write scope");
  });

  test("record mode validates identically but never writes", async () => {
    const r = rig();
    rigs.push(r);
    const tools = buildTools(r.toolDeps, "commander", "record");
    const bad = await tools.call("engines.patch", { patches: [{ engine: "liqfade", params: { windowMs: 9000 } }] });
    expect(bad.ok).toBe(false);
    const good = await tools.call("engines.patch", { patches: [{ engine: "basis", params: { zEntry: 2.5 } }] });
    expect(good.ok).toBe(true);
    expect(loadConfig(r.configDir).engines.engines.basis.params.zEntry).toBe(2);
    expect(tools.recorded.map((x) => x.name)).toEqual(["engines.patch", "engines.patch"]);
  });

  test("commander decision through runAgent: strict schema refuses an out-of-bounds param before any tool runs", async () => {
    const decision = {
      regime: "NORMAL",
      patches: [
        {
          engine: "liqfade",
          enabled: null,
          paper: null,
          symbols: null,
          sizeUsd: null,
          params: { ...Object.fromEntries(Object.keys(ENGINE_PARAM_BOUNDS.liqfade).map((k) => [k, null])), allowMarket: null, windowMs: 9000 },
          rationale: "x",
        },
      ],
      notes: "",
    };
    const { chat, calls } = fakeChat({ "test/primary": ({ req }) => answer(decision, req.model) });
    const r = rig({ chat });
    rigs.push(r);
    const res = await runAgent(commander, CFG, r.deps);
    expect(res.primary.schemaValid).toBe(false);
    expect(res.primary.applied).toBe(false);
    expect(calls.length).toBe(2); // corrective retry happened
    expect(loadConfig(r.configDir).engines.engines.liqfade.params.windowMs).toBe(3000);
  });
});
