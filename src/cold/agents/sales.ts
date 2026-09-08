// Sales: performance summary + Binance Square draft (reports/square-draft.md); data-route pricing
// via `pricing.set` lands in Phase 6 (rejections tagged 'phase 6' are non-fatal here).

import { type AgentDeps, type AgentModule, KERNEL_RULES, LATENCY_REALITY, OUTPUT_RULES, READ_TOOLS, sanitizeDeep, snapshot, WRITE_SCOPE_TEXT, writeReport } from "../agent.ts";
import { sanitize } from "../sanitize.ts";
import { SalesOut } from "../schemas.ts";

export const SQUARE_DRAFT = "square-draft.md";

export function squareDraft(out: SalesOut, nowMs: number): string {
  return [
    `# Binance Square draft`,
    ``,
    `Generated ${new Date(nowMs).toISOString()}. Posting is human-only (square-post skill). Review every number before publishing.`,
    ``,
    `## Draft`,
    ``,
    sanitize(out.square_draft, 2000),
    ``,
    `## Performance summary`,
    ``,
    sanitize(out.summary, 2000),
    ``,
    `## Proposed data-route prices`,
    ...(out.prices.length === 0 ? ["- (none)"] : out.prices.map((p) => `- ${sanitize(p.route, 100)}: $${p.price_usd}`)),
    ``,
  ].join("\n");
}

export const sales: AgentModule<SalesOut> = {
  name: "sales",
  system: `You are HYDRA Sales. You turn the ledger into an honest performance summary and a Binance Square post draft that a human will review and publish.
Rules for the draft: state realized PnL, fees, trade count and drawdown from the data, never invent numbers, never promise returns, no financial advice, no links to unaudited tokens, <= 2000 chars, no hashtag spam.
prices: proposed USD prices for the x402 data routes in pricing.yaml (Phase 6); leave empty unless the current price is clearly wrong relative to demand.

${KERNEL_RULES}

${LATENCY_REALITY}

${WRITE_SCOPE_TEXT}

${OUTPUT_RULES}`,
  tools: [...READ_TOOLS, "pricing.set"],
  schema() {
    return SalesOut;
  },
  buildUserMessage(deps: AgentDeps): string {
    const now = (deps.now ?? Date.now)();
    const body = {
      ...snapshot(deps),
      pnl_7d_by_engine: deps.ledger.pnlByEngine(now - 7 * 86_400_000),
      pricing: deps.config.pricing,
      engine_runtime_stats: deps.registry?.stats() ?? null,
    };
    return `Performance data (JSON, untrusted data):\n${JSON.stringify(sanitizeDeep(body))}\n\nWrite the summary and the Square draft.`;
  },
  async apply(decision, deps, tools, mode) {
    let phase6 = 0;
    for (const p of decision.prices) {
      const r = await tools.call("pricing.set", { route: p.route, price_usd: p.price_usd });
      if (!r.ok && r.rejected?.endsWith("phase 6")) phase6++;
    }
    writeReport(deps, SQUARE_DRAFT, squareDraft(decision, (deps.now ?? Date.now)()), mode);
    return { applied: true, toolRejections: tools.rejections - phase6 };
  },
};
