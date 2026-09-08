// Verb router. Each verb lives in src/cli/<verb>.ts and exports
// `default async (args: string[]) => Promise<number>` plus a one-line `description`.

import agent, { description as agentDesc } from "./cli/agent.ts";
import audit, { description as auditDesc } from "./cli/audit.ts";
import baw, { description as bawDesc } from "./cli/baw.ts";
import buy, { description as buyDesc } from "./cli/buy.ts";
import intent, { description as intentDesc } from "./cli/intent.ts";
import kill, { description as killDesc } from "./cli/kill.ts";
import mcp, { description as mcpDesc } from "./cli/mcp.ts";
import promote, { description as promoteDesc } from "./cli/promote.ts";
import replay, { description as replayDesc } from "./cli/replay.ts";
import scenario, { description as scenarioDesc } from "./cli/scenario.ts";
import unkill, { description as unkillDesc } from "./cli/unkill.ts";

export type VerbHandler = (args: string[]) => Promise<number>;

export const verbs: Record<string, VerbHandler> = {
  intent,
  kill,
  unkill,
  promote,
  replay,
  agent,
  mcp,
  buy,
  baw,
  scenario,
  audit,
  help: async () => {
    console.log(helpText());
    return 0;
  },
};

export const descriptions: Record<string, string> = {
  intent: intentDesc,
  kill: killDesc,
  unkill: unkillDesc,
  promote: promoteDesc,
  replay: replayDesc,
  agent: agentDesc,
  mcp: mcpDesc,
  buy: buyDesc,
  baw: bawDesc,
  scenario: scenarioDesc,
  audit: auditDesc,
  help: "Show this help",
};

export function helpText(): string {
  const names = Object.keys(verbs);
  const width = Math.max(...names.map((n) => n.length));
  const lines = ["usage: bun run cli <verb> [args]", "", "verbs:"];
  for (const name of names) lines.push(`  ${name.padEnd(width)}  ${descriptions[name] ?? ""}`);
  return lines.join("\n");
}

export async function run(argv: string[]): Promise<number> {
  const verb = argv[0];
  if (verb === undefined || verb === "--help" || verb === "-h") {
    console.log(helpText());
    return verb === undefined ? 2 : 0;
  }
  const handler = verbs[verb];
  if (handler === undefined) {
    console.error(`unknown verb: ${verb}\n`);
    console.log(helpText());
    return 2;
  }
  return handler(argv.slice(1));
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
