import { afterEach, describe, expect, test } from "bun:test";

import { runAgent } from "../../src/cold/agent.ts";
import { commander } from "../../src/cold/agents/commander.ts";
import { buildTools } from "../../src/cold/tools.ts";
import { loadConfig, writeEngines } from "../../src/core/config.ts";
import { answer, fakeChat, type Rig, rig } from "./rig.ts";

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose();
});

const promote = { patches: [{ engine: "liqfade", paper: false }] };
const demote = { patches: [{ engine: "liqfade", paper: true }] };

describe("promotion rule (paper -> live)", () => {
  test("live mode: paper:false rejected, paper:true allowed", async () => {
    const r = rig({ mode: "live" });
    rigs.push(r);
    await writeEngines(r.configDir, { liqfade: { paper: true } }, "operator");
    const tools = buildTools(r.toolDeps, "commander", "apply");
    const p = await tools.call("engines.patch", promote);
    expect(p.ok).toBe(false);
    expect(p.rejected).toContain("human-only");
    expect(loadConfig(r.configDir).engines.engines.liqfade.paper).toBe(true);
    const d = await tools.call("engines.patch", demote);
    expect(d.ok).toBe(true);
  });

  test("demo mode: both directions allowed", async () => {
    const r = rig({ mode: "demo" });
    rigs.push(r);
    const tools = buildTools(r.toolDeps, "commander", "apply");
    expect((await tools.call("engines.patch", promote)).ok).toBe(true);
    expect(loadConfig(r.configDir).engines.engines.liqfade.paper).toBe(false);
    expect((await tools.call("engines.patch", demote)).ok).toBe(true);
    expect(loadConfig(r.configDir).engines.engines.liqfade.paper).toBe(true);
  });

  test("commander run in live: promotion decision validates against the schema but the tool refuses it", async () => {
    const decision = {
      regime: "NORMAL",
      patches: [{ engine: "liqfade", enabled: null, paper: false, symbols: null, sizeUsd: null, params: null, rationale: "promote" }],
      notes: "",
    };
    const { chat } = fakeChat({ "test/primary": ({ req }) => answer(decision, req.model) });
    const r = rig({ mode: "live", chat });
    rigs.push(r);
    await writeEngines(r.configDir, { liqfade: { paper: true } }, "operator");
    const res = await runAgent(commander, { model: "test/primary", temperature: 0 }, r.deps);
    expect(res.primary.schemaValid).toBe(true);
    expect(res.primary.applied).toBe(false);
    expect(res.primary.toolRejections).toBe(1);
    expect(loadConfig(r.configDir).engines.engines.liqfade.paper).toBe(true);
  });
});
