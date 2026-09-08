#!/usr/bin/env bun
// scripts/reconcile.ts — Ledger-vs-venue position diff + open-order check.
//
// Boots the full hot-lane (feed→executor→engines→agents) so Positions is live,
// then runs two complementary checks:
//   1. positions.reconcile() — compares ledger qty (Positions.snapshot()) vs
//      venue positionRisk / spot account for every symbol; yields ReconcileDiff[].
//   2. recovery-boot reconcile() — venue-side open orders + non-zero residue.
// Prints a table, then "reconcile: N diffs" (exit 0 when N=0 else 1) — or, without venue keys,
// "reconcile: UNVERIFIED (no venue keys)" with exit 2: an unqueried venue is never reported clean.
//
// Note: scripts/ is outside tsconfig include; bun-types globals available at runtime.

import { boot } from "../src/main.ts";
import { hotLaneModules } from "../src/wiring.ts";
import type { HotLane } from "../src/wiring.ts";
import { reconcile as venueReconcile } from "../src/hot/recovery-boot.ts";
import type { VenueReconcile } from "../src/hot/recovery-boot.ts";
import type { ReconcileReport } from "../src/hot/positions.ts";
import { loadConfig } from "../src/core/config.ts";

// Hold the HotLane reference so we can reach executor.stack after boot starts it.
let hotLane: HotLane | null = null;

const rt = await boot({
  modules: (ctx) => {
    hotLane = hotLaneModules(ctx);
    return hotLane.modules;
  },
});

const env = rt.env;
const config = loadConfig("config");
const spotSymbols: readonly string[] = config.risk.allowed_symbols.spot;

const noKeys = env.keys.spot === null && env.keys.futures === null;
if (noKeys) console.log("no venue keys: venue side skipped");

// After boot() returns, the modules factory has definitely run — hotLane is set.
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const lane = hotLane!;

// ---- 1. Positions.reconcile() — ledger qty vs positionRisk/spot balances ---
let posReport: ReconcileReport = { diffs: [], residue: { futures: [], spot: [], dex: [] }, clean: true };

if (!noKeys) {
  const stack = lane.executor.stack;
  if (stack !== null) {
    posReport = await stack.positions.reconcile();
  } else {
    console.warn("WARN: executor stack not ready; positions diff skipped");
  }
}

// ---- 2. recovery-boot reconcile() — open orders + residue ------------------
let venueResult: VenueReconcile = {
  residue: { futures: [], spot: [], dex: [] },
  openOrders: 0,
  clean: true,
};

if (!noKeys) {
  const stack = lane.executor.stack;
  venueResult = await venueReconcile({
    futuresRest: stack?.futuresRest ?? null,
    spotRest: stack?.spotRest ?? null,
    spotSymbols,
  });
}

// ---- 3. Ledger open orders (for display) — via rt.ledger -------------------
interface OrderRow {
  id: number;
  venue: string;
  status: string;
  client_id: string;
}

const ledgerOpen = rt.ledger.db
  .query<OrderRow, []>(
    "SELECT id, venue, status, client_id FROM orders WHERE status IN ('PENDING','NEW','PARTIALLY_FILLED') ORDER BY id",
  )
  .all();

// ---- 4. Total diffs --------------------------------------------------------
const posDiffs = posReport.diffs.length;
const futuresResidue = venueResult.residue.futures;
const spotResidue = venueResult.residue.spot;
// Count each component independently so stray open orders fail even when residue arrays are empty.
const residueDiffs = futuresResidue.length + spotResidue.length + venueResult.openOrders;
const totalDiffs = noKeys ? 0 : posDiffs + residueDiffs;

// ---- Print -----------------------------------------------------------------
const pad = (s: string, n: number) => s.padEnd(n);

console.log("\n── Ledger open orders ──────────────────────────────────────");
if (ledgerOpen.length === 0) {
  console.log("  (none)");
} else {
  console.log(`  ${"id".padEnd(8)} ${"venue".padEnd(10)} ${"status".padEnd(20)} client_id`);
  for (const o of ledgerOpen) {
    console.log(`  ${String(o.id).padEnd(8)} ${pad(o.venue, 10)} ${pad(o.status, 20)} ${o.client_id}`);
  }
}

console.log("\n── Position diffs (ledger qty vs venue positionRisk/balances) ─");
if (noKeys) {
  console.log("  (skipped — no keys)");
} else if (posReport.diffs.length === 0) {
  console.log("  (clean)");
} else {
  console.log(`  ${"venue".padEnd(10)} ${"symbol".padEnd(12)} ${"ledger qty".padEnd(14)} venue qty`);
  for (const d of posReport.diffs) {
    console.log(`  ${pad(d.venue, 10)} ${pad(d.symbol, 12)} ${String(d.ledgerQty).padEnd(14)} ${d.venueQty}`);
  }
}

console.log("\n── Venue residue (non-zero positions / open orders) ────────");
if (noKeys) {
  console.log("  (skipped — no keys)");
} else if (futuresResidue.length === 0 && spotResidue.length === 0 && venueResult.openOrders === 0) {
  console.log("  (clean)");
} else {
  if (venueResult.openOrders > 0) console.log(`  open orders: ${venueResult.openOrders}`);
  console.log(`  ${"venue".padEnd(10)} ${"symbol".padEnd(12)} qty`);
  for (const r of futuresResidue) console.log(`  ${"futures".padEnd(10)} ${pad(r.symbol, 12)} ${r.qty}`);
  for (const r of spotResidue) console.log(`  ${"spot".padEnd(10)} ${pad(r.symbol, 12)} ${r.qty}`);
}

console.log("\n── Summary ─────────────────────────────────────────────────");
console.log(`  position diffs (ledger vs venue) : ${noKeys ? "n/a" : posDiffs}`);
console.log(`  venue residue symbols            : ${noKeys ? "n/a" : futuresResidue.length + spotResidue.length}`);
console.log(`  venue open orders                : ${noKeys ? "n/a" : venueResult.openOrders}`);
if (noKeys) {
  console.log("  reconcile: UNVERIFIED (no venue keys; venue side not queried)");
  await rt.shutdown();
  process.exit(2);
}
console.log(`  reconcile: ${totalDiffs} diffs`);

await rt.shutdown();
process.exit(totalDiffs === 0 ? 0 : 1);
