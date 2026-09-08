// cli promote <engine> — the only path from paper:true to paper:false in live. Writes engines.yaml
// as the operator (recorded in config_changes).

import { writeEngines } from "../core/config.ts";
import { openLedger } from "../core/ledger.ts";
import { ENGINE_IDS, type EngineId } from "../core/types.ts";
import { CONFIG_DIR } from "./intent.ts";

export const description = "Operator-only: promote an engine paper -> live: promote <engine>";

export default async function promote(args: string[]): Promise<number> {
  const engine = args[0];
  if (engine === undefined || !ENGINE_IDS.includes(engine as EngineId)) {
    console.error(`usage: cli promote <engine>; engines: ${ENGINE_IDS.join(", ")}`);
    return 2;
  }
  const ledger = openLedger("state/hydra.sqlite");
  try {
    const r = await writeEngines(CONFIG_DIR, { [engine]: { paper: false } }, "operator", ledger);
    console.log(r.changed ? `${engine}: paper -> live (engines.yaml ${r.hash.slice(0, 8)})` : `${engine}: already live (engines.yaml ${r.hash.slice(0, 8)})`);
    return 0;
  } catch (err) {
    console.error(`promote failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    ledger.close();
  }
}
