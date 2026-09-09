// cli agent run <name> [--no-shadow] — boots the hot lane (so tools see live positions and the kill
// switch), runs one agent cycle immediately, prints models used + decision JSON, shuts down.

import { type AgentRunResult, runAgent } from "../cold/agent.ts";
import { AGENT_MODULES, buildAgentDeps } from "../cold/scheduler.ts";
import { AGENT_NAMES, type AgentName } from "../core/types.ts";
import { boot } from "../main.ts";
import { type HotLane, hotLaneModules } from "../wiring.ts";
import { CONFIG_DIR, STATE_DIR } from "./intent.ts";

export const description = "Run one cold-lane agent cycle immediately: agent run <name> [--no-shadow]";
export const subverbs = ["run"] as const;

function usage(): number {
  console.error(`usage: hydra agent run <${AGENT_NAMES.join("|")}> [--no-shadow]`);
  return 2;
}

export default async function agent(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === undefined || !(subverbs as readonly string[]).includes(sub)) return usage();
  const name = args[1];
  if (name === undefined || !(AGENT_NAMES as readonly string[]).includes(name)) return usage();
  const noShadow = args.includes("--no-shadow");

  let hot: HotLane | null = null;
  const rt = await boot({
    configDir: CONFIG_DIR,
    stateDir: STATE_DIR,
    modules: (ctx) => {
      hot = hotLaneModules(ctx);
      return hot.modules;
    },
  });
  let code = 1;
  try {
    const apiKey = rt.env.yescaleApiKey;
    if (apiKey === null) {
      console.error("YESCALE_API_KEY not set; cold lane disabled");
      return 1;
    }
    const lane = hot as HotLane | null;
    const { deps, stop } = buildAgentDeps(
      { env: rt.env, config: rt.config, ledger: rt.ledger, stateDir: STATE_DIR, configDir: CONFIG_DIR, stack: () => lane?.executor.stack ?? null, registry: lane?.registry ?? null },
      apiKey,
    );
    const cfgIn = rt.config.agents.agents[name as AgentName];
    const { shadow_model, ...rest } = cfgIn;
    const cfg = noShadow || shadow_model === undefined ? rest : cfgIn;
    let result: AgentRunResult;
    try {
      result = await runAgent(AGENT_MODULES[name as AgentName], cfg, deps);
    } finally {
      stop();
    }
    console.log(`run_id: ${result.runId}`);
    console.log(`primary: ${result.primary.model} (schema_valid=${result.primary.schemaValid} applied=${result.primary.applied} cost=$${result.primary.costUsd.toFixed(4)} latency=${Math.round(result.primary.latencyMs)}ms tool_rejections=${result.primary.toolRejections})`);
    if (result.primary.error !== undefined) console.log(`primary error: ${result.primary.error}`);
    if (result.shadow !== undefined) {
      console.log(`shadow: ${result.shadow.model} (schema_valid=${result.shadow.schemaValid} cost=$${result.shadow.costUsd.toFixed(4)} latency=${Math.round(result.shadow.latencyMs)}ms agreement=${result.shadow.agreementPct ?? "n/a"})`);
      if (result.shadow.error !== undefined) console.log(`shadow error: ${result.shadow.error}`);
    }
    console.log(JSON.stringify(result.primary.decision, null, 2));
    if (result.shadow !== undefined) console.log(`shadow decision:\n${JSON.stringify(result.shadow.decision, null, 2)}`);
    code = result.primary.schemaValid && result.primary.error === undefined ? 0 : 1;
  } catch (err) {
    console.error(`agent run failed: ${err instanceof Error ? err.message : String(err)}`);
    code = 1;
  } finally {
    await rt.shutdown();
  }
  return code;
}
