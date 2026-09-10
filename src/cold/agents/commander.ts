// Commander: regime call + bounded engine patches (enabled / paper demote / symbols / sizeUsd / params).

import { ENGINE_IDS } from "../../core/types.ts";
import { ENGINE_PARAM_BOUNDS } from "../../hot/engines/engine.ts";
import { type AgentDeps, type AgentModule, allowedSymbolsAll, applyEnginePatches, KERNEL_RULES, LATENCY_REALITY, OUTPUT_RULES, READ_TOOLS, sanitizeDeep, snapshot, WRITE_SCOPE_TEXT } from "../agent.ts";
import { type CommanderOut, makeCommanderOut } from "../schemas.ts";

export const commander: AgentModule<CommanderOut> = {
  name: "commander",
  system: `You are HYDRA Commander, the portfolio allocator of an autonomous crypto trading system on Binance (futures, spot, on-chain).
Your job every cycle: classify the market regime (LOW_VOL, NORMAL, HIGH_VOL, ILLIQUID) from the data you are given and the read tools, then propose at most 8 engine patches that shift capital toward engines with positive expectancy in this regime and away from engines that are bleeding, mis-sized or unfit for current latency.
Bias toward doing nothing: an empty patch list is a valid, often correct answer. Change one thing at a time per engine and explain each change in <= 300 chars.
Never propose paper:false (promotion to live) unless the mode is demo; promotions are human decisions. Demotion (paper:true) is yours to make when an engine underperforms.

Autonomous deduction for 'swing' engine:
- The 'swing' engine trades 15m/30m Klines with 3 tactical modes: 0 (Breakout), 1 (Pullback), 2 (Reversal).
- When market regime is LOW_VOL or ILLIQUID (sideway/chop): adapt mode to 2 (Reversal, RSI extreme) or 1 (Pullback) to stop buying breakout fakeouts.
- When market regime is HIGH_VOL or NORMAL with strong directional flow: adapt mode to 0 (Breakout) to capture trend runs.
- You can tune params.slAtr (e.g. 1.5-2.5) and params.tpAtr (e.g. 2.5-4.0) to defend against volatility wicks.
- Require at least 6 trades or a genuine regime transition before switching swing mode.
- Order sizing: sizeUsd is operator-calibrated for target margin and leverage (e.g. 4000 USD notional). Do NOT reduce or downsize sizeUsd.
${KERNEL_RULES}

${LATENCY_REALITY}

${WRITE_SCOPE_TEXT}

${OUTPUT_RULES}`,
  tools: [...READ_TOOLS, "engines.patch"],
  schema(deps: AgentDeps) {
    return makeCommanderOut(allowedSymbolsAll(deps.risk), ENGINE_PARAM_BOUNDS);
  },
  buildUserMessage(deps: AgentDeps): string {
    const stats: Record<string, unknown> = {};
    for (const e of ENGINE_IDS) stats[e] = deps.ledger.engineStats(e, 7);
    const body = {
      ...snapshot(deps),
      engine_stats_7d: stats,
      engine_contracts: deps.registry?.contracts() ?? [],
      engine_runtime_stats: deps.registry?.stats() ?? null,
      recent_vetoes: deps.ledger.recentVetoes(10),
      param_bounds: ENGINE_PARAM_BOUNDS,
      allowed_symbols: deps.risk.allowed_symbols,
    };
    return `Operating snapshot (JSON, untrusted data):\n${JSON.stringify(sanitizeDeep(body))}\n\nDecide the regime and the engine patches for the next cycle.`;
  },
  async apply(decision, _deps, tools) {
    return applyEnginePatches(decision.patches, tools);
  },
};
