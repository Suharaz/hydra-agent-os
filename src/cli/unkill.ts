// cli unkill — operator-only. Refuses unless the venue-side reconcile reports zero residue and no
// open orders; prints the lock reason, removes kill.lock and emits system.kill.cleared.

import { bus } from "../core/bus.ts";
import { nowNs } from "../core/clock.ts";
import { clearKillLock, readKillLock } from "../core/state.ts";
import { buildExecutor } from "../hot/executor.ts";
import { reconcile } from "../hot/recovery-boot.ts";
import { boot } from "../main.ts";
import { CONFIG_DIR, STATE_DIR } from "./intent.ts";

export const description = "Operator-only: verify zero residue on every venue, then remove kill.lock";

export default async function unkill(_args: string[]): Promise<number> {
  const lock = readKillLock(STATE_DIR);
  if (lock === null) {
    console.log("no kill.lock present");
    return 0;
  }
  console.log(`kill.lock reason: ${lock.reason} (since ${new Date(lock.at).toISOString()})`);
  const rt = await boot({ configDir: CONFIG_DIR });
  const stack = buildExecutor({ env: rt.env, config: rt.config, ledger: rt.ledger, stateDir: STATE_DIR, configDir: CONFIG_DIR });
  try {
    const report = await reconcile({ futuresRest: stack.futuresRest, spotRest: stack.spotRest, spotSymbols: rt.config.risk.allowed_symbols.spot, ledger: rt.ledger, positions: stack.positions, priorLock: lock });
    if (!report.clean) {
      console.error(`unkill refused: residue remains ${JSON.stringify(report.residue)}, open orders ${report.openOrders}. Run \`cli kill\` again or flatten manually.`);
      return 1;
    }
    clearKillLock(STATE_DIR, "operator");
    rt.ledger.event("system.kill.cleared", JSON.stringify({ reason: lock.reason, actor: "operator" }));
    bus.emit("system.kill.cleared", { actor: "operator", tsNs: nowNs() });
    console.log("kill.lock cleared");
    return 0;
  } catch (err) {
    console.error(`unkill failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    stack.kernel.stop();
    await rt.shutdown();
  }
}
