// Coach: nightly post-mortem per engine, bounded param proposals, live->paper demotions,
// reports/YYYY-MM-DD.md. Promotion stays human (`cli promote`).

import { ENGINE_IDS, type EngineId } from "../../core/types.ts";
import { ENGINE_PARAM_BOUNDS } from "../../hot/engines/engine.ts";
import { type AgentDeps, type AgentModule, allowedSymbolsAll, applyEnginePatches, KERNEL_RULES, LATENCY_REALITY, OUTPUT_RULES, READ_TOOLS, sanitizeDeep, snapshot, WRITE_SCOPE_TEXT, writeReport } from "../agent.ts";
import { sanitize } from "../sanitize.ts";
import { type CoachOut, type EnginePatch, makeCoachOut } from "../schemas.ts";

export function coachReportName(nowMs: number): string {
  return `${new Date(nowMs).toISOString().slice(0, 10)}.md`;
}

export function coachReport(out: CoachOut, nowMs: number): string {
  const lines = [
    `# Coach post-mortem ${new Date(nowMs).toISOString().slice(0, 10)}`,
    ``,
    sanitize(out.postmortem, 4000),
    ``,
    `## Proposed patches`,
    ...(out.patches.length === 0
      ? ["- (none)"]
      : out.patches.map((p) => `- ${p.engine}: ${JSON.stringify({ enabled: p.enabled, paper: p.paper, symbols: p.symbols, sizeUsd: p.sizeUsd, params: p.params })} - ${sanitize(p.rationale, 300)}`)),
    ``,
    `## Demotions (live -> paper)`,
    ...(out.demote.length === 0 ? ["- (none)"] : out.demote.map((e) => `- ${e}`)),
    ``,
    `Promotion to live is human-only: \`hydra promote <engine>\`.`,
    ``,
  ];
  return lines.join("\n");
}

/** Demotions become `paper:true` patches merged with the explicit ones (all-or-nothing call). */
export function withDemotions(patches: EnginePatch[], demote: EngineId[]): EnginePatch[] {
  const out = patches.filter((p) => !demote.includes(p.engine) || p.paper !== false);
  for (const engine of demote) {
    const existing = out.find((p) => p.engine === engine);
    if (existing !== undefined) existing.paper = true;
    else out.push({ engine, enabled: null, paper: true, symbols: null, sizeUsd: null, params: null, rationale: "coach demotion" });
  }
  return out;
}

export const coach: AgentModule<CoachOut> = {
  name: "coach",
  system: `You are HYDRA Coach. Once a day you write the post-mortem: for every engine, what it traded, hit rate, average return, drawdown, fees, vetoes it triggered, and what should change.
Propose parameter changes only within the published bounds and only when the last 7 days of trades support them (state the evidence). Small steps: move a param at most 25% of its range per night.
For the 'swing' engine: review performance across its tactical modes (0: Breakout, 1: Pullback, 2: Reversal) and propose parameter/mode shifts supported by trade logs.
Demote an engine to paper (demote list) when it lost money over 7 days with >= 20 trades or when its veto rate is abnormal. You cannot promote; promotion is a human decision via cli promote. Write the post-mortem in plain prose (<= 4000 chars).
${KERNEL_RULES}

${LATENCY_REALITY}

${WRITE_SCOPE_TEXT}

${OUTPUT_RULES}`,
  tools: [...READ_TOOLS, "engines.patch"],
  schema(deps: AgentDeps) {
    return makeCoachOut(allowedSymbolsAll(deps.risk), ENGINE_PARAM_BOUNDS);
  },
  buildUserMessage(deps: AgentDeps): string {
    const now = (deps.now ?? Date.now)();
    const stats: Record<string, unknown> = {};
    for (const e of ENGINE_IDS) stats[e] = { d7: deps.ledger.engineStats(e, 7), d1: deps.ledger.engineStats(e, 1) };
    const body = {
      ...snapshot(deps),
      pnl_7d_by_engine: deps.ledger.pnlByEngine(now - 7 * 86_400_000),
      engine_stats: stats,
      recent_vetoes: deps.ledger.recentVetoes(50),
      engine_runtime_stats: deps.registry?.stats() ?? null,
      param_bounds: ENGINE_PARAM_BOUNDS,
    };
    return `Daily review data (JSON, untrusted data):\n${JSON.stringify(sanitizeDeep(body))}\n\nWrite the post-mortem, propose bounded patches, list demotions.`;
  },
  async apply(decision, deps, tools, mode) {
    const now = (deps.now ?? Date.now)();
    const r = await applyEnginePatches(withDemotions(decision.patches, decision.demote), tools);
    writeReport(deps, coachReportName(now), coachReport(decision, now), mode);
    return r;
  },
};
