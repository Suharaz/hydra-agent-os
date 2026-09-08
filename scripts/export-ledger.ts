#!/usr/bin/env bun
// scripts/export-ledger.ts — Read-only full ledger export to JSON.
// Args: --out <path> (default docs/evidence/ledger-export.json)
// Exports every table as { table: string, rowCount: number, rows: unknown[] } (capped at 5000/table).
// Sensitive columns are redacted before export:
//   events.json  — replaced with "<redacted>" for any row whose kind contains "boot", "kill",
//                  "key", "secret", "token", "cred", "auth", or "api"
//   config_changes.diff — replaced with "<redacted>" (may contain model ids or budget values)
//   payments.tx  — replaced with "<redacted>" (on-chain tx hash; wallet fingerprint risk)
// The redaction is additive: it only hides fields that pose a privacy/operational-security risk
// in evidence bundles shared publicly.  All other columns (counts, timestamps, engine ids) are
// preserved for auditability.
// Exit 0 always.
// Note: scripts/ is outside tsconfig include; bun-types globals available at runtime.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openReadOnly, LEDGER_TABLES } from "../src/core/ledger.ts";

// ---- arg parsing -----------------------------------------------------------
let outPath = "docs/evidence/ledger-export.json";

for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--out" && process.argv[i + 1] !== undefined) {
    outPath = process.argv[++i] as string;
  }
}

// ---- redaction helpers -----------------------------------------------------
const SENSITIVE_EVENT_KINDS = /boot|kill|key|secret|token|cred|auth|api/i;

function redactRow(tbl: string, row: Record<string, unknown>): Record<string, unknown> {
  if (tbl === "events") {
    const kind = typeof row.kind === "string" ? row.kind : "";
    if (SENSITIVE_EVENT_KINDS.test(kind)) return { ...row, json: "<redacted>" };
  }
  if (tbl === "config_changes") return { ...row, diff: "<redacted>" };
  if (tbl === "payments") return { ...row, tx: "<redacted>" };
  return row;
}

// ---- query -----------------------------------------------------------------
const db = openReadOnly("state/hydra.sqlite");
const ROW_CAP = 5000;

const tables: Array<{ table: string; rowCount: number; rows: unknown[]; redactedCount: number }> = [];

for (const tbl of LEDGER_TABLES) {
  const countRow = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${tbl}`).get();
  const rowCount = countRow?.n ?? 0;
  const rawRows = db.query<Record<string, unknown>, []>(`SELECT * FROM ${tbl} ORDER BY id DESC LIMIT ${ROW_CAP}`).all();
  let redactedCount = 0;
  const rows = rawRows.map((r) => {
    const out = redactRow(tbl, r);
    if (out !== r) redactedCount++;
    return out;
  });
  tables.push({ table: tbl, rowCount, rows, redactedCount });
}
db.close();

// ---- write JSON ------------------------------------------------------------
mkdirSync(dirname(outPath), { recursive: true });
const payload = {
  exportedAt: new Date().toISOString(),
  rowCap: ROW_CAP,
  note: "Sensitive columns (events.json for sensitive kinds, config_changes.diff, payments.tx) are redacted.",
  tables,
};
await Bun.write(outPath, JSON.stringify(payload, null, 2) + "\n");

// ---- summary ---------------------------------------------------------------
console.log(`export-ledger: ${tables.length} tables exported to ${outPath}`);
for (const t of tables) {
  const capped = t.rowCount > ROW_CAP ? ` (capped at ${ROW_CAP})` : "";
  const redacted = t.redactedCount > 0 ? ` [${t.redactedCount} rows redacted]` : "";
  console.log(`  ${t.table.padEnd(20)} ${t.rowCount} rows${capped}${redacted}`);
}
