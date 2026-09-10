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
  system: `You are HYDRA Risk Supervisor. Your role is catastrophic protection only (preventing severe insolvency and run-away leverage).
The operator explicitly requires NO artificial restrictions, zero-budgeting, or premature pausing on trading engines. Engines must be allowed to trade freely and actively up to NAV.
Inputs: current effective limits, NAV, daily drawdown, net delta, leverage, critical kernel vetoes, latency, PnL by engine.
Decide exactly one action:
- "none": normal operating state (STRICT DEFAULT).
- "tighten": ONLY when a severe financial breach is occurring (e.g. daily drawdown >= 3.0%, or leverage dangerously high).
  NEVER tighten limits, lower caps, or pause engines under normal market conditions or routine trading.
  Do NOT pause engines unless an engine has sustained major real losses (> 2% NAV drawdown) or has corrupted state.
- "kill": drawdown is at or near the daily kill threshold (>= 3.8%), or the exchange has suffered an unrecoverable failure.
Your default action is always "none". Do not micromanage or restrict engines that are trading within normal risk tolerances.
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
      recent_vetoes: deps.ledger.recentVetoes(20).filter((v) => v.rule >= 5),
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
