// Treasurer: per-engine budgets (Kelly-capped, <= engine cap, sum <= NAV), LLM/data budget tracking,
// transfer proposals for a human (reports/transfer-requests.md). Never moves funds.

import { readBudgets } from "../../core/state.ts";
import { ENGINE_IDS } from "../../core/types.ts";
import { type AgentDeps, type AgentModule, KERNEL_RULES, LATENCY_REALITY, OUTPUT_RULES, READ_TOOLS, sanitizeDeep, snapshot, WRITE_SCOPE_TEXT, writeReport } from "../agent.ts";
import { sanitize } from "../sanitize.ts";
import { TreasurerOut } from "../schemas.ts";

export const TRANSFER_REPORT = "transfer-requests.md";

export function transferReport(out: TreasurerOut, nowMs: number, risk: { llm_daily_budget_usd: number; data_daily_budget_usd: number; transfer_max_usd_per_day: number }): string {
  const lines = [
    `# Treasurer transfer requests`,
    ``,
    `Generated ${new Date(nowMs).toISOString()}. HYDRA never moves funds; an operator executes or ignores these.`,
    ``,
    `## Requests`,
    ...(out.transfer_requests.length === 0 ? ["- (none)"] : out.transfer_requests.map((t) => `- [ ] ${sanitize(t, 300)}`)),
    ``,
    `## Budget proposals (risk.yaml is file-only; apply by hand)`,
    `- llm_daily_budget_usd: ${risk.llm_daily_budget_usd} -> ${out.llm_daily_budget_usd ?? "unchanged"}`,
    `- data_daily_budget_usd: ${risk.data_daily_budget_usd} -> ${out.data_daily_budget_usd ?? "unchanged"}`,
    `- transfer_max_usd_per_day (cap): ${risk.transfer_max_usd_per_day}`,
    ``,
    `## Notes`,
    sanitize(out.notes, 500),
    ``,
  ];
  return lines.join("\n");
}

export const treasurer: AgentModule<TreasurerOut> = {
  name: "treasurer",
  system: `You are HYDRA Treasurer. You allocate capital between engines and watch the operating budgets; you never move money.
Each cycle: set budgets[engine] in USD for every engine (null = leave unchanged). Size each budget as a fraction-of-Kelly of the engine's 7-day hit rate and average return: half-Kelly at most, zero for engines with negative expectancy or fewer than 20 trades, and never above the per-engine cap. The sum of all budgets must stay <= NAV.
Track llm_daily_budget_usd and data_daily_budget_usd: propose new values (or null) when today's spend trend will exhaust them; the operator applies them.
Transfers between venues or wallets are human-only: describe each needed transfer as one line in transfer_requests (amount, asset, from, to, why).
purchases lists x402 data invoices worth buying within data_daily_budget_usd (Phase 6; usually empty).

${KERNEL_RULES}

${LATENCY_REALITY}

${WRITE_SCOPE_TEXT}

${OUTPUT_RULES}`,
  tools: [...READ_TOOLS, "budget.set", "pay.buy"],
  schema() {
    return TreasurerOut;
  },
  buildUserMessage(deps: AgentDeps): string {
    const stats: Record<string, unknown> = {};
    for (const e of ENGINE_IDS) stats[e] = deps.ledger.engineStats(e, 7);
    const body = {
      ...snapshot(deps),
      current_budgets: readBudgets(deps.stateDir),
      engine_caps_usd: deps.toolDeps.limits().per_engine_max_notional_usd,
      engine_stats_7d: stats,
      data_daily_budget_usd: deps.risk.data_daily_budget_usd,
      transfer_max_usd_per_day: deps.risk.transfer_max_usd_per_day,
    };
    return `Treasury snapshot (JSON, untrusted data):\n${JSON.stringify(sanitizeDeep(body))}\n\nAllocate budgets and list any transfer requests.`;
  },
  async apply(decision, deps, tools, mode) {
    let applied = true;
    const budgets: Record<string, number> = {};
    for (const e of ENGINE_IDS) {
      const v = decision.budgets[e];
      if (v !== null) budgets[e] = v;
    }
    if (Object.keys(budgets).length > 0) {
      const r = await tools.call("budget.set", { budgets });
      applied = r.ok;
    }
    let phase6 = 0;
    for (const p of decision.purchases) {
      const r = await tools.call("pay.buy", { url: p.url, maxUsd: p.max_usd });
      if (!r.ok && r.rejected?.endsWith("phase 6")) phase6++;
    }
    writeReport(deps, TRANSFER_REPORT, transferReport(decision, (deps.now ?? Date.now)(), deps.risk), mode);
    return { applied, toolRejections: tools.rejections - phase6 };
  },
};
