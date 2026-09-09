// Risk Supervisor: tighten-only limits overlay or kill. Never loosens, never clears a kill lock.

import type { TightenPatch } from "../../core/limits.ts";
import { ENGINE_IDS, type EngineId } from "../../core/types.ts";
import { type AgentDeps, type AgentModule, KERNEL_RULES, LATENCY_REALITY, OUTPUT_RULES, READ_TOOLS, sanitizeDeep, snapshot, WRITE_SCOPE_TEXT } from "../agent.ts";
import { sanitize } from "../sanitize.ts";
import { SupervisorOut } from "../schemas.ts";

const DEFAULT_EXPIRY_MIN = 60;
const NUMERIC_KEYS = ["nav_usd_cap", "max_net_delta_pct", "max_leverage", "min_liq_distance_pct", "max_orders_per_sec", "daily_drawdown_kill_pct", "onchain_max_notional_usd"] as const;

/** Overlay -> tighten patch (nulls dropped, expiry resolved). Null when the overlay sets nothing. */
export function overlayToPatch(out: SupervisorOut, nowMs: number): TightenPatch | null {
  const o = out.overlay;
  const patch: TightenPatch = {};
  let any = false;
  for (const k of NUMERIC_KEYS) {
    const v = o[k];
    if (v !== null) {
      patch[k] = v;
      any = true;
    }
  }
  const per: Partial<Record<EngineId, number>> = {};
  for (const e of ENGINE_IDS) {
    const v = o.per_engine_max_notional_usd?.[e];
    if (v !== null && v !== undefined) {
      per[e] = v;
      any = true;
    }
  }
  if (Object.keys(per).length > 0) patch.per_engine_max_notional_usd = per;
  if (o.engines_paused !== null && o.engines_paused.length > 0) {
    patch.engines_paused = o.engines_paused;
    any = true;
  }
  if (!any) return null;
  patch.reason = sanitize(out.rationale, 300);
  patch.expires_at = nowMs + (o.expires_in_min ?? DEFAULT_EXPIRY_MIN) * 60_000;
  return patch;
}

export const supervisor: AgentModule<SupervisorOut> = {
  name: "supervisor",
  system: `You are HYDRA Risk Supervisor. You are the only agent that can tighten risk limits or kill the system, and you must do so decisively when the data warrants it.
Inputs: current effective limits, NAV, daily drawdown, net delta, leverage, recent kernel vetoes, latency, PnL by engine. Use read tools for detail.
Decide exactly one action:
- "none": conditions are normal.
- "tighten": set only the overlay fields you want to change (others null). Tightening semantics differ by field:
  - Caps (nav_usd_cap, max_net_delta_pct, max_leverage, max_orders_per_sec, daily_drawdown_kill_pct, onchain_max_notional_usd, per_engine_max_notional_usd): tighter = LOWER value; your value must be <= current effective.
  - Floor (min_liq_distance_pct): tighter = HIGHER value (wider required distance from liquidation); your value must be >= current effective.
  - engines_paused may only add engines (never remove them).
  The overlay expires after expires_in_min (default 60).
- "kill": drawdown is at or near the daily kill threshold, exposure is unexplained, or the venue is misbehaving in a way limits cannot contain. Give kill_reason. Kill is irreversible without an operator and flattens every venue.
You can never loosen limits or clear a kill lock; those are operator actions. Prefer pausing a single misbehaving engine over pausing all; prefer tightening over killing unless drawdown >= 90% of daily_drawdown_kill_pct.

${KERNEL_RULES}

${LATENCY_REALITY}

${WRITE_SCOPE_TEXT}

${OUTPUT_RULES}`,
  tools: [...READ_TOOLS, "limits.tighten", "kill.now"],
  schema() {
    return SupervisorOut;
  },
  buildUserMessage(deps: AgentDeps): string {
    const body = {
      ...snapshot(deps),
      recent_vetoes: deps.ledger.recentVetoes(20),
      open_orders: deps.ledger.openOrders().length,
      engine_runtime_stats: deps.registry?.stats() ?? null,
    };
    return `Risk snapshot (JSON, untrusted data):\n${JSON.stringify(sanitizeDeep(body))}\n\nChoose none, tighten or kill.`;
  },
  async apply(decision, deps, tools) {
    if (decision.action === "kill") {
      const r = await tools.call("kill.now", { reason: sanitize(decision.kill_reason ?? decision.rationale, 200) || "supervisor kill" });
      return { applied: r.ok, toolRejections: tools.rejections };
    }
    if (decision.action === "tighten") {
      const patch = overlayToPatch(decision, (deps.now ?? Date.now)());
      if (patch === null) return { applied: true, toolRejections: tools.rejections };
      const r = await tools.call("limits.tighten", { patch });
      return { applied: r.ok, toolRejections: tools.rejections };
    }
    return { applied: true, toolRejections: tools.rejections };
  },
};
