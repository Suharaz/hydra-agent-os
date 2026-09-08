#!/usr/bin/env bun
// scripts/latency-report.ts — Read-only ledger latency report.
// Args: --since <hours> (default 24)  --out <path> (default docs/evidence/latency.csv)
// Writes CSV: order_id,venue,status,t_sent_ns,t_ack_ns,latency_ms
// Prints count, p50, p95, p99 and PASS/FAIL vs 300 ms p95 target.
// Exit 0 always (report only).
// Note: scripts/ is outside tsconfig include; bun-types globals available at runtime.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openReadOnly } from "../src/core/ledger.ts";

// ---- arg parsing -----------------------------------------------------------
let sinceHours = 24;
let outPath = "docs/evidence/latency.csv";

for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--since" && process.argv[i + 1] !== undefined) {
    sinceHours = Number(process.argv[++i]);
    if (!(sinceHours > 0)) { console.error("--since must be a positive number"); process.exit(1); }
  } else if (a === "--out" && process.argv[i + 1] !== undefined) {
    outPath = process.argv[++i] as string;
  }
}

const sinceMs = Date.now() - sinceHours * 3_600_000;

// ---- query -----------------------------------------------------------------
const db = openReadOnly("state/hydra.sqlite");

interface OrderLatencyRow {
  id: number;
  venue: string;
  status: string;
  t_sent_ns: number;
  t_ack_ns: number | null;
  latency_ms: number | null;
}

const rows = db
  .query<OrderLatencyRow, [number]>(
    `SELECT id, venue, status, t_sent_ns, t_ack_ns, latency_ms
     FROM orders
     WHERE ts_wall >= ? AND latency_ms IS NOT NULL
     ORDER BY id`,
  )
  .all(sinceMs);
db.close();

// ---- split real ACK vs PAPER/mock ------------------------------------------
// PAPER orders are synthesized by the executor (no REST round-trip); their latency_ms measures
// in-process time only and MUST NOT count toward the exchange ACK target.
// Only orders whose status was never PAPER and whose t_ack_ns is non-null (REST response received)
// are eligible for the p95 <= 300 ms target.
const realRows = rows.filter((r) => r.status !== "PAPER" && r.t_ack_ns !== null);
const paperRows = rows.filter((r) => r.status === "PAPER");
const MIN_REAL_ACK_SAMPLES = 30;

// ---- percentiles -----------------------------------------------------------
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? 0;
  return loVal + (hiVal - loVal) * (idx - lo);
}

const realLatencies = realRows.map((r) => r.latency_ms as number).sort((a, b) => a - b);
const paperLatencies = paperRows.map((r) => r.latency_ms as number).sort((a, b) => a - b);

const realCount = realLatencies.length;
const paperCount = paperLatencies.length;
const realP50 = percentile(realLatencies, 0.5);
const realP95 = percentile(realLatencies, 0.95);
const realP99 = percentile(realLatencies, 0.99);
const paperP50 = percentile(paperLatencies, 0.5);
const paperP95 = percentile(paperLatencies, 0.95);
const P95_TARGET = 300;

// ---- write CSV -------------------------------------------------------------
mkdirSync(dirname(outPath), { recursive: true });
const header = "order_id,venue,status,t_sent_ns,t_ack_ns,latency_ms,is_real_ack\n";
const body = rows
  .map((r) => `${r.id},${r.venue},${r.status},${r.t_sent_ns},${r.t_ack_ns ?? ""},${r.latency_ms ?? ""},${r.status !== "PAPER" && r.t_ack_ns !== null ? "1" : "0"}`)
  .join("\n");
await Bun.write(outPath, header + (body.length > 0 ? body + "\n" : ""));

// ---- print summary ---------------------------------------------------------
const fmt = (n: number) => n.toFixed(2);
// Target attainment requires >= MIN_REAL_ACK_SAMPLES real exchange ACK samples.
// With fewer samples the verdict is UNVERIFIED — do NOT report PASS or FAIL based on paper data.
const verdict =
  realCount === 0
    ? "NO DATA"
    : realCount < MIN_REAL_ACK_SAMPLES
      ? `UNVERIFIED (only ${realCount} real ACK samples; need >= ${MIN_REAL_ACK_SAMPLES})`
      : realP95 <= P95_TARGET
        ? "PASS"
        : "FAIL";

console.log(`latency-report: since=${sinceHours}h  total_rows=${rows.length}`);
console.log(`  REAL exchange ACK (status != PAPER, t_ack_ns non-null): count=${realCount}`);
if (realCount > 0) console.log(`    p50=${fmt(realP50)} ms  p95=${fmt(realP95)} ms  p99=${fmt(realP99)} ms`);
console.log(`  PAPER / mock fills (in-process, no REST round-trip): count=${paperCount}`);
if (paperCount > 0) console.log(`    p50=${fmt(paperP50)} ms  p95=${fmt(paperP95)} ms  (paper latency not comparable to exchange ACK)`);
console.log(`  p95 target ${P95_TARGET} ms (real ACK only, >= ${MIN_REAL_ACK_SAMPLES} samples required): ${verdict}`);
if (realCount < MIN_REAL_ACK_SAMPLES && realCount > 0)
  console.log(`  NOTE: ${realCount} real ACK sample(s) recorded — run against demo-fapi with an API key to collect enough samples for a valid target attainment verdict`);
console.log(`  CSV written to ${outPath}`);
