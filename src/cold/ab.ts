// Shadow A/B metrics: agreement between primary and shadow decisions (per agent type) and the
// 1-hour delayed pnl back-fill that attributes `trades.realized` to the engines a run touched.

import type { Ledger } from "../core/ledger.ts";
import { type AgentName, ENGINE_IDS, type EngineId } from "../core/types.ts";

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 100;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (100 * inter) / (a.size + b.size - inter);
}

/** `engine.field=value` strings for every non-null field of every patch (rationale excluded). */
export function patchKeys(decision: unknown): Set<string> {
  const out = new Set<string>();
  const patches = obj(decision).patches;
  if (!Array.isArray(patches)) return out;
  for (const raw of patches) {
    const p = obj(raw);
    const engine = typeof p.engine === "string" ? p.engine : "?";
    for (const [k, v] of Object.entries(p)) {
      if (k === "engine" || k === "rationale" || v === null || v === undefined) continue;
      if (k === "params") {
        for (const [pk, pv] of Object.entries(obj(v))) if (pv !== null && pv !== undefined) out.add(`${engine}.params.${pk}=${JSON.stringify(pv)}`);
      } else if (k === "symbols" && Array.isArray(v)) {
        out.add(`${engine}.symbols=${[...v].sort().join(",")}`);
      } else {
        out.add(`${engine}.${k}=${JSON.stringify(v)}`);
      }
    }
  }
  return out;
}

function overlayKeys(decision: unknown): Set<string> {
  const out = new Set<string>();
  const d = obj(decision);
  const action = typeof d.action === "string" ? d.action : "none";
  out.add(`action=${action}`);
  if (action !== "tighten") return out;
  for (const [k, v] of Object.entries(obj(d.overlay))) {
    if (v === null || v === undefined || k === "expires_in_min") continue;
    if (k === "per_engine_max_notional_usd") {
      for (const [e, ev] of Object.entries(obj(v))) if (ev !== null && ev !== undefined) out.add(`per_engine.${e}=${ev}`);
    } else if (Array.isArray(v)) {
      out.add(`${k}=${[...v].sort().join(",")}`);
    } else {
      out.add(`${k}=${JSON.stringify(v)}`);
    }
  }
  return out;
}

function budgetVector(decision: unknown): number[] {
  const b = obj(obj(decision).budgets);
  return ENGINE_IDS.map((e) => (typeof b[e] === "number" ? (b[e] as number) : 0));
}

function routeKeys(decision: unknown): Set<string> {
  const out = new Set<string>();
  const pricing = obj(decision).pricing;
  if (!Array.isArray(pricing)) return out;
  for (const raw of pricing) {
    const r = obj(raw);
    out.add(`${String(r.route)}=${String(r.price_usd)}`);
  }
  return out;
}

/** 0..100. Commander/Coach: Jaccard over patch keys; Supervisor: identical verdict; Treasurer: cosine; Sales: Jaccard over routes. */
export function agreement(agent: AgentName, primary: unknown, shadow: unknown): number {
  switch (agent) {
    case "commander":
    case "coach":
      return jaccard(patchKeys(primary), patchKeys(shadow));
    case "supervisor": {
      const a = overlayKeys(primary);
      const b = overlayKeys(shadow);
      if (a.size !== b.size) return 0;
      for (const x of a) if (!b.has(x)) return 0;
      return 100;
    }
    case "treasurer": {
      const a = budgetVector(primary);
      const b = budgetVector(shadow);
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i++) {
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        dot += x * y;
        na += x * x;
        nb += y * y;
      }
      if (na === 0 && nb === 0) return 100;
      if (na === 0 || nb === 0) return 0;
      return (100 * dot) / Math.sqrt(na * nb);
    }
    case "sales":
      return jaccard(routeKeys(primary), routeKeys(shadow));
  }
}

/** Engines a decision touched: patched engines, paused engines, budgeted engines, or all on kill. */
export function touchedEngines(agent: AgentName, decision: unknown): EngineId[] {
  const d = obj(decision);
  const ids = new Set<EngineId>();
  const isEngine = (v: unknown): v is EngineId => typeof v === "string" && (ENGINE_IDS as readonly string[]).includes(v);
  switch (agent) {
    case "commander":
    case "coach":
      if (Array.isArray(d.patches)) for (const p of d.patches) if (isEngine(obj(p).engine)) ids.add(obj(p).engine as EngineId);
      break;
    case "supervisor": {
      if (d.action === "kill") return [...ENGINE_IDS];
      const paused = obj(d.overlay).engines_paused;
      if (paused === "all") return [...ENGINE_IDS];
      if (Array.isArray(paused)) for (const e of paused) if (isEngine(e)) ids.add(e);
      for (const e of Object.keys(obj(obj(d.overlay).per_engine_max_notional_usd))) if (isEngine(e)) ids.add(e);
      break;
    }
    case "treasurer":
      for (const [e, v] of Object.entries(obj(d.budgets))) if (isEngine(e) && typeof v === "number") ids.add(e);
      break;
    case "sales":
      break;
  }
  return [...ids];
}

const HOUR_MS = 3_600_000;

/** Fills `pnl_1h_usd` for runs older than one hour: sum of trades.realized for touched engines in (run_ts, run_ts + 1 h].
 * For shadow rows both primary and shadow receive attribution from the engines the **primary** touched,
 * so shadow and primary attribution are directly comparable. Falls back to the shadow's own decision
 * only when the matching primary row is absent (orphaned shadow). */
export function backfillPnl1h(ledger: Ledger, nowMs: number): number {
  const cutoff = nowMs - HOUR_MS;
  const rows = ledger.db
    .query<{ run_id: string; role: "primary" | "shadow"; agent: AgentName; ts_wall: number; decision_json: string }, [number]>(
      "SELECT run_id, role, agent, ts_wall, decision_json FROM agent_runs WHERE pnl_1h_usd IS NULL AND ts_wall <= ? ORDER BY id",
    )
    .all(cutoff);
  if (rows.length === 0) return 0;

  // Pre-load all primary decisions whose runs are referenced (covers both primary and shadow rows).
  const primaryDecisions = new Map<string, unknown>();
  const primaries = ledger.db
    .query<{ run_id: string; decision_json: string }, [number]>(
      "SELECT run_id, decision_json FROM agent_runs WHERE role = 'primary' AND ts_wall <= ? ORDER BY id",
    )
    .all(cutoff);
  for (const p of primaries) {
    try {
      primaryDecisions.set(p.run_id, JSON.parse(p.decision_json));
    } catch {
      // keep absent; fall back to shadow's own decision below
    }
  }

  const sum = ledger.db.prepare<{ s: number }, [number, number, string]>(
    "SELECT COALESCE(SUM(realized), 0) AS s FROM trades WHERE ts_wall > ? AND ts_wall <= ? AND engine = ?",
  );
  let filled = 0;
  for (const r of rows) {
    // Shadow rows: attribute using the primary's touched engines for a fair comparison.
    // Primary rows: use their own decision. Orphaned shadow (no primary found): fall back to own.
    let decision: unknown;
    if (r.role === "shadow") {
      decision = primaryDecisions.get(r.run_id) ?? (() => {
        try { return JSON.parse(r.decision_json); } catch { return null; }
      })();
    } else {
      try { decision = JSON.parse(r.decision_json); } catch { decision = null; }
    }
    let pnl = 0;
    for (const e of touchedEngines(r.agent, decision)) pnl += sum.get(r.ts_wall, r.ts_wall + HOUR_MS, e)?.s ?? 0;
    filled += ledger.updateAgentRun(r.run_id, r.role, { pnl1hUsd: pnl });
  }
  return filled;
}
