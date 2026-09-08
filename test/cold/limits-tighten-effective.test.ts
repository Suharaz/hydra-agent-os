import { afterEach, describe, expect, test } from "bun:test";

import { runAgent } from "../../src/cold/agent.ts";
import { overlayToPatch, supervisor } from "../../src/cold/agents/supervisor.ts";
import type { SupervisorOut } from "../../src/cold/schemas.ts";
import { buildTools, tightenProblem } from "../../src/cold/tools.ts";
import { readLimits } from "../../src/core/state.ts";
import { answer, fakeChat, NOW, type Rig, rig } from "./rig.ts";

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose();
});

const nullOverlay: SupervisorOut["overlay"] = {
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
};

describe("limits.tighten vs effective", () => {
  test("looser than risk.yaml rejected; tighter accepted; then looser than the new effective rejected", async () => {
    const r = rig();
    rigs.push(r);
    const tools = buildTools(r.toolDeps, "supervisor", "apply");
    // risk.yaml: max_leverage 3
    const loose = await tools.call("limits.tighten", { patch: { max_leverage: 4 } });
    expect(loose.ok).toBe(false);
    expect(loose.rejected).toContain("max_leverage");
    expect(readLimits(r.stateDir)).toBeNull();

    const tight = await tools.call("limits.tighten", { patch: { max_leverage: 2, reason: "test", expires_at: NOW + 3_600_000 } });
    expect(tight.ok).toBe(true);
    expect(r.toolDeps.limits().max_leverage).toBe(2);

    const relax = await tools.call("limits.tighten", { patch: { max_leverage: 2.5 } });
    expect(relax.ok).toBe(false);
    expect(r.toolDeps.limits().max_leverage).toBe(2);

    const shrink = await tools.call("limits.tighten", { patch: { engines_paused: ["basis"] } });
    expect(shrink.ok).toBe(true);
    const drop = await tools.call("limits.tighten", { patch: { engines_paused: ["liqfade"] } });
    expect(drop.ok).toBe(false);
    expect(drop.rejected).toContain("basis");
  });

  test("record mode mirrors the check without writing", async () => {
    const r = rig();
    rigs.push(r);
    const tools = buildTools(r.toolDeps, "supervisor", "record");
    expect((await tools.call("limits.tighten", { patch: { max_leverage: 4 } })).ok).toBe(false);
    expect((await tools.call("limits.tighten", { patch: { max_leverage: 2 } })).ok).toBe(true);
    expect(readLimits(r.stateDir)).toBeNull();
  });

  test("overlayToPatch drops nulls and resolves expiry", () => {
    const out: SupervisorOut = { action: "tighten", overlay: { ...nullOverlay, max_leverage: 2, engines_paused: ["basis"], expires_in_min: 30 }, kill_reason: null, rationale: "dd" };
    const p = overlayToPatch(out, NOW);
    expect(p).toEqual({ max_leverage: 2, engines_paused: ["basis"], reason: "dd", expires_at: NOW + 30 * 60_000 });
    expect(overlayToPatch({ ...out, overlay: nullOverlay }, NOW)).toBeNull();
  });

  test("supervisor run: looser overlay rejected through the tool, tighter applied, kill routes to kill.now", async () => {
    let step = 0;
    const outs: SupervisorOut[] = [
      { action: "tighten", overlay: { ...nullOverlay, max_leverage: 5 }, kill_reason: null, rationale: "loosen (must fail)" },
      { action: "tighten", overlay: { ...nullOverlay, max_leverage: 2, expires_in_min: 60 }, kill_reason: null, rationale: "drawdown 3.8%" },
      { action: "kill", overlay: nullOverlay, kill_reason: "drawdown 4.1%", rationale: "kill" },
    ];
    const { chat } = fakeChat({ "test/primary": ({ req }) => answer(outs[step++], req.model) });
    const r = rig({ chat });
    rigs.push(r);
    const cfg = { model: "test/primary", temperature: 0 };

    const a = await runAgent(supervisor, cfg, r.deps);
    expect(a.primary.schemaValid).toBe(true);
    expect(a.primary.applied).toBe(false);
    expect(a.primary.toolRejections).toBe(1);
    expect(readLimits(r.stateDir)).toBeNull();

    const b = await runAgent(supervisor, cfg, r.deps);
    expect(b.primary.applied).toBe(true);
    expect(r.toolDeps.limits().max_leverage).toBe(2);
    expect(readLimits(r.stateDir)?.actor).toBe("supervisor");

    const c = await runAgent(supervisor, cfg, r.deps);
    expect(c.primary.applied).toBe(true);
    expect(r.kills).toEqual(["supervisor: drawdown 4.1%"]);
  });
});

describe("min_liq_distance_pct floor semantics in tightenProblem", () => {
  test("lowering min_liq_distance_pct (loosening the floor) is reported as looser", () => {
    const r = rig();
    rigs.push(r);
    // risk.yaml: min_liq_distance_pct=15; lowering to 10 is looser (less required distance)
    const current = r.toolDeps.limits();
    expect(current.min_liq_distance_pct).toBe(15);
    const result = tightenProblem({ min_liq_distance_pct: 10 }, current);
    expect(result).not.toBeNull();
    expect(result).toContain("min_liq_distance_pct");
    expect(result).toContain("10");
  });

  test("raising min_liq_distance_pct (tightening the floor) is accepted by tightenProblem", () => {
    const r = rig();
    rigs.push(r);
    const current = r.toolDeps.limits();
    // risk.yaml: min_liq_distance_pct=15; raising to 20 is tighter (more required distance)
    const result = tightenProblem({ min_liq_distance_pct: 20 }, current);
    expect(result).toBeNull();
  });

  test("equal min_liq_distance_pct is accepted (no change = not looser)", () => {
    const r = rig();
    rigs.push(r);
    const current = r.toolDeps.limits();
    expect(tightenProblem({ min_liq_distance_pct: current.min_liq_distance_pct }, current)).toBeNull();
  });

  test("limits.tighten tool: lower min_liq_distance_pct rejected in apply mode (apply parity)", async () => {
    const r = rig();
    rigs.push(r);
    const tools = buildTools(r.toolDeps, "supervisor", "apply");
    const res = await tools.call("limits.tighten", { patch: { min_liq_distance_pct: 5 } });
    expect(res.ok).toBe(false);
    expect(res.rejected).toContain("min_liq_distance_pct");
    expect(readLimits(r.stateDir)).toBeNull();
  });

  test("limits.tighten tool: lower min_liq_distance_pct rejected in record mode (shadow parity)", async () => {
    const r = rig();
    rigs.push(r);
    const tools = buildTools(r.toolDeps, "supervisor", "record");
    const res = await tools.call("limits.tighten", { patch: { min_liq_distance_pct: 5 } });
    expect(res.ok).toBe(false);
    expect(res.rejected).toContain("min_liq_distance_pct");
    expect(readLimits(r.stateDir)).toBeNull();
  });

  test("limits.tighten tool: higher min_liq_distance_pct accepted in both modes", async () => {
    const r = rig();
    rigs.push(r);
    const applyTools = buildTools(r.toolDeps, "supervisor", "apply");
    const res = await applyTools.call("limits.tighten", { patch: { min_liq_distance_pct: 25, reason: "test", expires_at: NOW + 3_600_000 } });
    expect(res.ok).toBe(true);
    expect(r.toolDeps.limits().min_liq_distance_pct).toBe(25);

    const r2 = rig();
    rigs.push(r2);
    const recTools = buildTools(r2.toolDeps, "supervisor", "record");
    const res2 = await recTools.call("limits.tighten", { patch: { min_liq_distance_pct: 25 } });
    expect(res2.ok).toBe(true);
    expect(readLimits(r2.stateDir)).toBeNull(); // record mode never writes
  });
});
