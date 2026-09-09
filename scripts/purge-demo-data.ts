// Removes only records explicitly marked as synthetic by the old showcase generator.
// Does not generate trading history, lessons, or mutate verified dream memory.
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

const STATE_DIR = "state";

// Purge previously seeded rows from the runtime ledger.
//    The dashboard must show only genuine live activity — no fabricated trade history.
const LEDGER_PATH = `${STATE_DIR}/hydra.sqlite`;
if (existsSync(LEDGER_PATH)) {
  const db = new Database(LEDGER_PATH);
  db.run("PRAGMA busy_timeout = 4000;");
  const purged = { trades: 0, vetoes: 0, agent_runs: 0 };
  try {
    purged.trades = db.query(`DELETE FROM trades WHERE venue = 'demo'`).run().changes;
    purged.vetoes = db.query(`DELETE FROM vetoes WHERE intent_id LIKE 'seed-%'`).run().changes;
    purged.agent_runs = db.query(`DELETE FROM agent_runs WHERE run_id LIKE 'seed-%'`).run().changes;
  } catch (e) {
    console.log(`-> purge skipped (ledger tables not ready): ${e instanceof Error ? e.message : String(e)}`);
  }
  db.close();
  console.log(`\n-> Purged seeded rows: trades=${purged.trades}, vetoes=${purged.vetoes}, agent_runs=${purged.agent_runs}.`);
} else {
  console.log(`\n-> Ledger ${LEDGER_PATH} not present; nothing to purge.`);
}
console.log("-> No fabricated trade history seeded. Dashboard reflects live data only.");
