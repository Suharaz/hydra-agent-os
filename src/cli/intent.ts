// cli intent <engine> <venue> <symbol> <side> <qty> [--limit p] [--tp p] [--sl p] [--paper]
// Boots the runtime, builds the executor stack (kernel, positions, REST), submits one intent and prints
// the result. Fills are synthesized from the REST ack here since no user-data stream runs in this process.

import { nowNs } from "../core/clock.ts";
import { ENGINE_IDS, type EngineId, type Intent, type Side, VENUES, type Venue } from "../core/types.ts";
import { buildExecutor } from "../hot/executor.ts";
import { boot } from "../main.ts";

export const description = "Submit one intent through kernel + executor: intent <engine> <venue> <symbol> <side> <qty> [--limit p] [--tp p] [--sl p] [--paper]";

export const STATE_DIR = "state";
export const CONFIG_DIR = "config";

interface ParsedIntent {
  intent: Intent;
}

function usage(): string {
  return "usage: cli intent <engine> <venue> <symbol> <side> <qty> [--limit price] [--tp price] [--sl price] [--paper]";
}

export function parseIntentArgs(args: string[]): ParsedIntent | string {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key === "paper") flags[key] = true;
      else {
        const v = args[i + 1];
        if (v === undefined) return `--${key} needs a value`;
        flags[key] = v;
        i++;
      }
    } else positional.push(a);
  }
  if (positional.length !== 5) return usage();
  const [engine, venue, symbol, sideRaw, qtyRaw] = positional as [string, string, string, string, string];
  if (!ENGINE_IDS.includes(engine as EngineId)) return `unknown engine "${engine}"; expected one of ${ENGINE_IDS.join(", ")}`;
  if (!VENUES.includes(venue as Venue)) return `unknown venue "${venue}"; expected one of ${VENUES.join(", ")}`;
  const side = sideRaw.toUpperCase();
  if (side !== "BUY" && side !== "SELL") return `side must be BUY or SELL`;
  const qty = Number(qtyRaw);
  if (!(qty > 0)) return `qty must be > 0`;
  const num = (k: string): number | undefined | string => {
    const v = flags[k];
    if (v === undefined) return undefined;
    const n = Number(v);
    return n > 0 ? n : `--${k} must be a positive number`;
  };
  const limit = num("limit");
  const tp = num("tp");
  const sl = num("sl");
  for (const v of [limit, tp, sl]) if (typeof v === "string") return v;
  const intent: Intent = {
    id: `cli-${Date.now().toString(36)}`,
    engine: engine as EngineId,
    venue: venue as Venue,
    symbol: symbol.toUpperCase(),
    side: side as Side,
    qty,
    type: limit === undefined ? "MARKET" : "LIMIT",
    ttlMs: 60_000,
    paper: flags.paper === true,
    tSignalNs: nowNs(),
  };
  if (typeof limit === "number") intent.price = limit;
  if (typeof tp === "number") intent.tp = tp;
  if (typeof sl === "number") intent.sl = sl;
  return { intent };
}

export default async function intent(args: string[]): Promise<number> {
  const parsed = parseIntentArgs(args);
  if (typeof parsed === "string") {
    console.error(parsed);
    return 2;
  }
  const rt = await boot({ configDir: CONFIG_DIR });
  const stack = buildExecutor({ env: rt.env, config: rt.config, ledger: rt.ledger, stateDir: STATE_DIR, configDir: CONFIG_DIR, fillsFromAck: true });
  let code = 0;
  try {
    await stack.loadSymbols();
    stack.positions.start();
    stack.executor.start();
    if (stack.futuresRest !== null || stack.spotRest !== null) await stack.positions.reconcile();
    const result = await stack.executor.submit(parsed.intent);
    console.log(JSON.stringify(result, null, 2));
    code = result.ok ? 0 : 1;
  } catch (err) {
    console.error(`intent failed: ${err instanceof Error ? err.message : String(err)}`);
    code = 1;
  } finally {
    stack.executor.stop();
    stack.positions.stop();
    await rt.shutdown();
  }
  return code;
}
