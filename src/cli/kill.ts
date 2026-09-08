// cli kill [reason] — boots the runtime, runs the kill switch against both venues, prints the
// result. Re-running is never a no-op: the loop re-verifies and re-flattens residue.

import { buildExecutor } from "../hot/executor.ts";
import { boot } from "../main.ts";
import { CONFIG_DIR, STATE_DIR } from "./intent.ts";

export const description = "Trigger the kill switch: cancel all, flatten every venue, write kill.lock: kill [reason]";

export default async function kill(args: string[]): Promise<number> {
  const reason = args.length > 0 ? args.join(" ") : "operator";
  const rt = await boot({ configDir: CONFIG_DIR });
  const stack = buildExecutor({ env: rt.env, config: rt.config, ledger: rt.ledger, stateDir: STATE_DIR, configDir: CONFIG_DIR });
  let code = 0;
  try {
    stack.positions.start();
    await stack.loadSymbols();
    if (stack.futuresRest !== null || stack.spotRest !== null) await stack.positions.reconcile();
    const result = await stack.kill(reason);
    console.log(JSON.stringify(result, null, 2));
    code = result.flat ? 0 : 1;
  } catch (err) {
    console.error(`kill failed: ${err instanceof Error ? err.message : String(err)}`);
    code = 1;
  } finally {
    stack.positions.stop();
    stack.kernel.stop();
    await rt.shutdown();
  }
  return code;
}
