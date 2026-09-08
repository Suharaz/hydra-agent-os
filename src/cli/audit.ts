// cli audit [--tail N] [--since ISO-8601] — prints the dashboard audit trail from the ledger
// (`dashboard_audit`) over a read-only connection, so it works while HYDRA is running.
// One line per row, oldest first: <ISO ts> <role> <session> <action> <status> <detail|->

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLedgerReader, openReadOnly } from "../core/ledger.ts";
import { STATE_DIR } from "./intent.ts";

export const description = "Print the dashboard audit trail (who did what, when): audit [--tail N] [--since ISO-8601]";

const DEFAULT_TAIL = 50;

interface AuditArgs {
  tail: number;
  sinceMs: number | undefined;
}

function parseArgs(args: string[]): AuditArgs | string {
  let tail = DEFAULT_TAIL;
  let sinceMs: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--tail") {
      const raw = args[++i];
      const n = raw === undefined ? NaN : Number(raw);
      if (!Number.isInteger(n) || n <= 0) return `--tail expects a positive integer, got ${raw ?? "<missing>"}`;
      tail = n;
    } else if (a === "--since") {
      const raw = args[++i];
      const ms = raw === undefined ? NaN : Date.parse(raw);
      if (Number.isNaN(ms)) return `--since expects an ISO-8601 timestamp, got ${raw ?? "<missing>"}`;
      sinceMs = ms;
    } else {
      return `unknown argument: ${a}`;
    }
  }
  return { tail, sinceMs };
}

export default async function audit(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (typeof parsed === "string") {
    console.error(`audit: ${parsed}\nusage: bun run cli audit [--tail N] [--since ISO-8601]`);
    return 2;
  }
  const path = join(STATE_DIR, "hydra.sqlite");
  if (!existsSync(path)) {
    console.error(`audit: ledger not found at ${path}; boot HYDRA once (bun run start) to create it`);
    return 1;
  }
  const db = openReadOnly(path);
  try {
    let rows;
    try {
      rows = createLedgerReader(db).dashboardAudit(parsed.tail, parsed.sinceMs);
    } catch (err) {
      // The read-only connection cannot create tables; an older ledger gains `dashboard_audit`
      // on the next writer boot.
      if (err instanceof Error && err.message.includes("no such table")) {
        console.error(`audit: ${path} has no dashboard_audit table yet; boot HYDRA once to migrate it`);
        return 1;
      }
      throw err;
    }
    // Reader returns newest first; print oldest first so the terminal reads chronologically.
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      console.log(
        `${new Date(r.tsWall).toISOString()} ${r.role.padEnd(8)} ${r.session.padEnd(8)} ${r.action.padEnd(14)} ${r.status} ${r.detail ?? "-"}`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}
