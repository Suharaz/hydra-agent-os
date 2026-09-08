// bun:sqlite ledger. WAL, busy_timeout=2000, synchronous=NORMAL.
// Hot-lane tables (intents/orders/fills/trades/vetoes) are synchronous write-through: the row is
// durable before the caller makes its next network call. Telemetry (events/positions_snap) is
// batched on a 50 ms unref'd timer inside one transaction; flush()/close() drain.

import { Database, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { nowNs, utcDayStartMs, wallMs } from "./clock.ts";
import type { AgentDecision, AgentName, AgentRole, EngineId, Fill, Intent, Order, OrderStatus, Payment, Trade, Venue, Veto } from "./types.ts";

export const LEDGER_TABLES = [
  "events",
  "intents",
  "orders",
  "fills",
  "trades",
  "vetoes",
  "positions_snap",
  "pnl_daily",
  "llm_calls",
  "agent_runs",
  "payments",
  "config_changes",
  "fill_recovery_cursor",
  "dashboard_audit",
] as const;

const BASE = "id INTEGER PRIMARY KEY, ts_ns INTEGER NOT NULL, ts_wall INTEGER NOT NULL";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (${BASE}, kind TEXT NOT NULL, json TEXT);
CREATE TABLE IF NOT EXISTS intents (${BASE}, engine TEXT NOT NULL, venue TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
  qty REAL NOT NULL, type TEXT NOT NULL, paper INT NOT NULL, t_signal_ns INTEGER NOT NULL, json TEXT);
CREATE TABLE IF NOT EXISTS orders (${BASE}, intent_id INTEGER, venue TEXT NOT NULL, client_id TEXT NOT NULL UNIQUE, ext_id TEXT,
  status TEXT NOT NULL, t_sent_ns INTEGER NOT NULL, t_ack_ns INTEGER, latency_ms REAL, json TEXT);
CREATE TABLE IF NOT EXISTS fills (${BASE}, order_id INTEGER NOT NULL, venue TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
  trade_id TEXT NOT NULL, price REAL NOT NULL, qty REAL NOT NULL, fee REAL NOT NULL, fee_asset TEXT NOT NULL, UNIQUE(venue, symbol, trade_id));
CREATE TABLE IF NOT EXISTS trades (${BASE}, engine TEXT NOT NULL, venue TEXT NOT NULL, symbol TEXT NOT NULL, opened_ns INTEGER NOT NULL,
  closed_ns INTEGER NOT NULL, qty REAL NOT NULL, entry REAL NOT NULL, exit REAL NOT NULL, realized REAL NOT NULL, fees REAL NOT NULL, ret_bps REAL NOT NULL);
CREATE TABLE IF NOT EXISTS vetoes (${BASE}, intent_id TEXT NOT NULL, rule INTEGER NOT NULL, detail TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS positions_snap (${BASE}, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pnl_daily (${BASE}, engine TEXT NOT NULL, date TEXT NOT NULL, realized REAL NOT NULL, fees REAL NOT NULL,
  trades INTEGER NOT NULL, wins INTEGER NOT NULL, max_dd_bps REAL NOT NULL, UNIQUE(engine, date));
CREATE TABLE IF NOT EXISTS llm_calls (${BASE}, run_id TEXT NOT NULL, agent TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, latency_ms REAL NOT NULL, schema_valid INT NOT NULL, json TEXT);
CREATE TABLE IF NOT EXISTS agent_runs (${BASE}, run_id TEXT NOT NULL, agent TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
  decision_json TEXT NOT NULL, applied INT NOT NULL, tool_rejections INTEGER NOT NULL, cost_usd REAL NOT NULL, latency_ms REAL NOT NULL,
  schema_valid INT NOT NULL, agreement_pct REAL NULL, pnl_1h_usd REAL NULL, UNIQUE(run_id, role));
CREATE TABLE IF NOT EXISTS payments (${BASE}, direction TEXT NOT NULL, counterparty TEXT NOT NULL, amount REAL NOT NULL, asset TEXT NOT NULL,
  network TEXT NOT NULL, tx TEXT NOT NULL, json TEXT);
CREATE TABLE IF NOT EXISTS config_changes (${BASE}, actor TEXT NOT NULL, path TEXT NOT NULL, before_hash TEXT NOT NULL, after_hash TEXT NOT NULL, diff TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dashboard_audit (${BASE}, session TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, status INTEGER NOT NULL,
  ua TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS fill_recovery_cursor (venue TEXT NOT NULL, symbol TEXT NOT NULL, next_id INTEGER NOT NULL, PRIMARY KEY (venue, symbol));
CREATE INDEX IF NOT EXISTS ix_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS ix_trades_engine_wall ON trades(engine, ts_wall);
CREATE INDEX IF NOT EXISTS ix_fills_venue_symbol ON fills(venue, symbol);
CREATE INDEX IF NOT EXISTS ix_agent_runs_agent_wall ON agent_runs(agent, ts_wall);
CREATE INDEX IF NOT EXISTS ix_llm_calls_wall ON llm_calls(ts_wall);
CREATE INDEX IF NOT EXISTS ix_payments_wall ON payments(direction, ts_wall);
CREATE INDEX IF NOT EXISTS ix_dashboard_audit_wall ON dashboard_audit(ts_wall);
`;

// ---- row shapes -----------------------------------------------------------

export interface OrderAck {
  extId?: string | null;
  status: OrderStatus;
  tAckNs: number;
  latencyMs: number;
  json?: string;
}

export interface PnlDailyRow {
  engine: EngineId;
  date: string;
  realized: number;
  fees: number;
  trades: number;
  wins: number;
  maxDdBps: number;
}

export interface LlmCallRow {
  runId: string;
  agent: AgentName;
  role: AgentRole;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  schemaValid: boolean;
  json?: string;
}

export type AgentRunRow = AgentDecision & { agreementPct?: number | null; pnl1hUsd?: number | null };

export interface AgentRunPatch {
  applied?: boolean;
  toolRejections?: number;
  agreementPct?: number | null;
  pnl1hUsd?: number | null;
  decision?: unknown;
}

export interface ConfigChangeRow {
  actor: string;
  path: string;
  before_hash: string;
  after_hash: string;
  diff: string;
}

/** One dashboard action: who (session prefix / bearer), what, and the HTTP status it produced. */
export interface DashboardAuditRow {
  session: string;
  role: string;
  action: string;
  status: number;
  ua: string;
  detail: string | null;
}

export interface DashboardAuditRead extends DashboardAuditRow {
  id: number;
  tsWall: number;
}

export interface EngineStats {
  trades: number;
  hitRate: number;
  avgRetBps: number;
  sharpe: number;
  maxDdBps: number;
}

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
}

export interface PnlByEngineRow {
  engine: EngineId;
  realized: number;
  fees: number;
  trades: number;
  wins: number;
}

export interface VetoRow {
  id: number;
  tsNs: number;
  tsWall: number;
  intentId: string;
  rule: number;
  detail: string;
}

export interface AbModelMetrics {
  runs: number;
  costUsd: number;
  p50LatencyMs: number;
  schemaValidRate: number;
  /** Share of runs with at least one tool rejection. */
  toolRejectRate: number;
  agreementPct: number | null;
  pnl1hUsd: number | null;
}

// ---- helpers --------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] as number;
}

function rowid(r: { lastInsertRowid: number | bigint }): number {
  return Number(r.lastInsertRowid);
}

interface Pending {
  table: 0 | 1; // 0 = events, 1 = positions_snap
  tsNs: number;
  tsWall: number;
  a: string;
  b: string | null;
}

/** Order columns not in the spec'd `orders` schema live in `json`. */
const OrderJson = z.object({
  symbol: z.string().default(""),
  side: z.enum(["BUY", "SELL"]).default("BUY"),
  qty: z.number().default(0),
  price: z.number().nullable().default(null),
});

// ---- ledger ---------------------------------------------------------------

export class Ledger {
  readonly db: Database;
  private readonly queue: Pending[] = [];
  private readonly timer: Timer;
  private closed = false;

  private readonly stIntent: Statement;
  private readonly stOrder: Statement;
  private readonly stOrderAck: Statement;
  private readonly stOrderStatus: Statement;
  private readonly stFill: Statement;
  private readonly stTrade: Statement;
  private readonly stVeto: Statement;
  private readonly stPnlDaily: Statement;
  private readonly stLlmCall: Statement;
  private readonly stAgentRun: Statement;
  private readonly stPayment: Statement;
  private readonly stConfigChange: Statement;
  private readonly stDashboardAudit: Statement;
  private readonly stEvent: Statement;
  private readonly stSnap: Statement;
  private readonly flushTx: (batch: Pending[]) => void;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=2000");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec(SCHEMA);
    // S05 migration: rebuild fills UNIQUE on (venue, symbol, trade_id) for existing databases.
    // The old constraint was (venue, trade_id); SQLite cannot ALTER a unique constraint,
    // so we recreate the index idempotently. Existing rows with the old constraint are preserved
    // because CREATE TABLE IF NOT EXISTS does not change the existing table structure.
    this.migrateFilledUniqueIndex();

    this.stIntent = this.db.prepare(
      "INSERT INTO intents (ts_ns, ts_wall, engine, venue, symbol, side, qty, type, paper, t_signal_ns, json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    );
    this.stOrder = this.db.prepare(
      "INSERT INTO orders (ts_ns, ts_wall, intent_id, venue, client_id, ext_id, status, t_sent_ns, t_ack_ns, latency_ms, json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    );
    this.stOrderAck = this.db.prepare(
      "UPDATE orders SET ext_id = COALESCE(?, ext_id), status = ?, t_ack_ns = ?, latency_ms = ?, json = json_patch(COALESCE(json, '{}'), COALESCE(?, '{}')) WHERE id = ?",
    );
    this.stOrderStatus = this.db.prepare("UPDATE orders SET status = ?, json = json_patch(COALESCE(json, '{}'), COALESCE(?, '{}')) WHERE id = ?");
    this.stFill = this.db.prepare(
      "INSERT OR IGNORE INTO fills (ts_ns, ts_wall, order_id, venue, symbol, side, trade_id, price, qty, fee, fee_asset) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    );
    this.stTrade = this.db.prepare(
      "INSERT INTO trades (ts_ns, ts_wall, engine, venue, symbol, opened_ns, closed_ns, qty, entry, exit, realized, fees, ret_bps) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    this.stVeto = this.db.prepare("INSERT INTO vetoes (ts_ns, ts_wall, intent_id, rule, detail) VALUES (?,?,?,?,?)");
    this.stPnlDaily = this.db.prepare(
      `INSERT INTO pnl_daily (ts_ns, ts_wall, engine, date, realized, fees, trades, wins, max_dd_bps) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(engine, date) DO UPDATE SET ts_ns = excluded.ts_ns, ts_wall = excluded.ts_wall, realized = excluded.realized,
       fees = excluded.fees, trades = excluded.trades, wins = excluded.wins, max_dd_bps = excluded.max_dd_bps`,
    );
    this.stLlmCall = this.db.prepare(
      "INSERT INTO llm_calls (ts_ns, ts_wall, run_id, agent, role, model, prompt_tokens, completion_tokens, cost_usd, latency_ms, schema_valid, json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    this.stAgentRun = this.db.prepare(
      `INSERT INTO agent_runs (ts_ns, ts_wall, run_id, agent, role, model, decision_json, applied, tool_rejections, cost_usd, latency_ms, schema_valid, agreement_pct, pnl_1h_usd)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.stPayment = this.db.prepare(
      "INSERT INTO payments (ts_ns, ts_wall, direction, counterparty, amount, asset, network, tx, json) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    this.stConfigChange = this.db.prepare(
      "INSERT INTO config_changes (ts_ns, ts_wall, actor, path, before_hash, after_hash, diff) VALUES (?,?,?,?,?,?,?)",
    );
    this.stDashboardAudit = this.db.prepare("INSERT INTO dashboard_audit (ts_ns, ts_wall, session, role, action, status, ua, detail) VALUES (?,?,?,?,?,?,?,?)");
    this.stEvent = this.db.prepare("INSERT INTO events (ts_ns, ts_wall, kind, json) VALUES (?,?,?,?)");
    this.stSnap = this.db.prepare("INSERT INTO positions_snap (ts_ns, ts_wall, json) VALUES (?,?,?)");

    this.flushTx = this.db.transaction((batch: Pending[]) => {
      for (const p of batch) {
        if (p.table === 0) this.stEvent.run(p.tsNs, p.tsWall, p.a, p.b);
        else this.stSnap.run(p.tsNs, p.tsWall, p.a);
      }
    });

    this.timer = setInterval(() => this.flush(), 50);
    this.timer.unref();
  }

  // ---- write-through ------------------------------------------------------

  insertIntent(i: Intent): number {
    return rowid(
      this.stIntent.run(nowNs(), wallMs(), i.engine, i.venue, i.symbol, i.side, i.qty, i.type, i.paper ? 1 : 0, i.tSignalNs, JSON.stringify(i)),
    );
  }

  /** Inserted with status PENDING before the REST send; throws on duplicate client_id. */
  insertOrderPending(o: Omit<Order, "id" | "status"> & { status?: OrderStatus }): number {
    const json = JSON.stringify({ symbol: o.symbol, side: o.side, qty: o.qty, price: o.price ?? null });
    return rowid(
      this.stOrder.run(
        nowNs(),
        wallMs(),
        o.intentId,
        o.venue,
        o.clientId,
        o.extId ?? null,
        o.status ?? "PENDING",
        o.tSentNs,
        o.tAckNs ?? null,
        o.latencyMs ?? null,
        json,
      ),
    );
  }

  updateOrderAck(id: number, ack: OrderAck): void {
    this.stOrderAck.run(ack.extId ?? null, ack.status, ack.tAckNs, ack.latencyMs, ack.json ?? null, id);
  }

  updateOrderStatus(id: number, status: OrderStatus, json?: string): void {
    this.stOrderStatus.run(status, json ?? null, id);
  }

  /** Returns the row id, or null when (venue, trade_id) was already recorded. */
  insertFill(f: Fill): number | null {
    const r = this.stFill.run(f.tsNs, wallMs(), f.orderId, f.venue, f.symbol, f.side, f.tradeId, f.price, f.qty, f.fee, f.feeAsset);
    return r.changes === 0 ? null : rowid(r);
  }

  insertTrade(t: Trade): number {
    return rowid(
      this.stTrade.run(nowNs(), wallMs(), t.engine, t.venue, t.symbol, t.openedNs, t.closedNs, t.qty, t.entry, t.exit, t.realized, t.fees, t.retBps),
    );
  }

  insertVeto(v: Veto): number {
    return rowid(this.stVeto.run(nowNs(), wallMs(), v.intentId, v.rule, v.detail));
  }

  upsertPnlDaily(row: PnlDailyRow): void {
    this.stPnlDaily.run(nowNs(), wallMs(), row.engine, row.date, row.realized, row.fees, row.trades, row.wins, row.maxDdBps);
  }

  insertLlmCall(row: LlmCallRow): number {
    return rowid(
      this.stLlmCall.run(
        nowNs(),
        wallMs(),
        row.runId,
        row.agent,
        row.role,
        row.model,
        row.promptTokens,
        row.completionTokens,
        row.costUsd,
        row.latencyMs,
        row.schemaValid ? 1 : 0,
        row.json ?? null,
      ),
    );
  }

  insertAgentRun(row: AgentRunRow): number {
    return rowid(
      this.stAgentRun.run(
        nowNs(),
        wallMs(),
        row.runId,
        row.agent,
        row.role,
        row.model,
        JSON.stringify(row.decision ?? null),
        row.applied ? 1 : 0,
        row.toolRejections,
        row.costUsd,
        row.latencyMs,
        row.schemaValid ? 1 : 0,
        row.agreementPct ?? null,
        row.pnl1hUsd ?? null,
      ),
    );
  }

  updateAgentRun(runId: string, role: AgentRole, patch: AgentRunPatch): number {
    const sets: string[] = [];
    const args: (number | string | null)[] = [];
    if (patch.applied !== undefined) {
      sets.push("applied = ?");
      args.push(patch.applied ? 1 : 0);
    }
    if (patch.toolRejections !== undefined) {
      sets.push("tool_rejections = ?");
      args.push(patch.toolRejections);
    }
    if (patch.agreementPct !== undefined) {
      sets.push("agreement_pct = ?");
      args.push(patch.agreementPct);
    }
    if (patch.pnl1hUsd !== undefined) {
      sets.push("pnl_1h_usd = ?");
      args.push(patch.pnl1hUsd);
    }
    if (patch.decision !== undefined) {
      sets.push("decision_json = ?");
      args.push(JSON.stringify(patch.decision));
    }
    if (sets.length === 0) return 0;
    args.push(runId, role);
    return this.db.prepare(`UPDATE agent_runs SET ${sets.join(", ")} WHERE run_id = ? AND role = ?`).run(...args).changes;
  }

  insertPayment(p: Payment): number {
    return rowid(
      this.stPayment.run(nowNs(), wallMs(), p.direction, p.counterparty, p.amount, p.asset, p.network, p.tx, p.meta === undefined ? null : JSON.stringify(p.meta)),
    );
  }

  insertConfigChange(row: ConfigChangeRow): number {
    return rowid(this.stConfigChange.run(nowNs(), wallMs(), row.actor, row.path, row.before_hash, row.after_hash, row.diff));
  }

  insertDashboardAudit(row: DashboardAuditRow): number {
    return rowid(this.stDashboardAudit.run(nowNs(), wallMs(), row.session, row.role, row.action, row.status, row.ua, row.detail));
  }

  // ---- batched ------------------------------------------------------------

  event(kind: string, json: string | null = null): void {
    this.queue.push({ table: 0, tsNs: nowNs(), tsWall: wallMs(), a: kind, b: json });
  }

  positionsSnap(json: string): void {
    this.queue.push({ table: 1, tsNs: nowNs(), tsWall: wallMs(), a: json, b: null });
  }

  flush(): number {
    if (this.queue.length === 0 || this.closed) return 0;
    const batch = this.queue.splice(0, this.queue.length);
    this.flushTx(batch);
    return batch.length;
  }

  // ---- reads --------------------------------------------------------------

  pnlByEngine(sinceTs: number): PnlByEngineRow[] {
    return this.db
      .query<PnlByEngineRow, [number]>(
        `SELECT engine, SUM(realized) AS realized, SUM(fees) AS fees, COUNT(*) AS trades, SUM(realized > 0) AS wins
         FROM trades WHERE ts_wall >= ? GROUP BY engine ORDER BY engine`,
      )
      .all(sinceTs);
  }

  engineStats(engine: EngineId, days: number): EngineStats {
    const rows = this.db
      .query<{ realized: number; ret_bps: number }, [EngineId, number]>(
        "SELECT realized, ret_bps FROM trades WHERE engine = ? AND ts_wall >= ? ORDER BY closed_ns, id",
      )
      .all(engine, wallMs() - days * 86_400_000);
    const n = rows.length;
    if (n === 0) return { trades: 0, hitRate: 0, avgRetBps: 0, sharpe: 0, maxDdBps: 0 };
    let wins = 0;
    let sum = 0;
    for (const r of rows) {
      if (r.realized > 0) wins++;
      sum += r.ret_bps;
    }
    const mean = sum / n;
    let sharpe = 0;
    if (n >= 2) {
      let ss = 0;
      for (const r of rows) {
        const d = r.ret_bps - mean;
        ss += d * d;
      }
      const std = Math.sqrt(ss / (n - 1));
      sharpe = std === 0 ? 0 : mean / std;
    }
    // Max drawdown of the cumulative ret_bps curve (peak-to-trough, in bps).
    let cum = 0;
    let peak = 0;
    let maxDd = 0;
    for (const r of rows) {
      cum += r.ret_bps;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDd) maxDd = dd;
    }
    return { trades: n, hitRate: wins / n, avgRetBps: mean, sharpe, maxDdBps: maxDd };
  }

  latencyStats(sinceTs: number): LatencyStats {
    const rows = this.db
      .query<{ latency_ms: number }, [number]>("SELECT latency_ms FROM orders WHERE ts_wall >= ? AND latency_ms IS NOT NULL")
      .all(sinceTs);
    const v: number[] = [];
    for (const r of rows) v.push(r.latency_ms);
    v.sort((a, b) => a - b);
    return { count: v.length, p50: percentile(v, 0.5), p95: percentile(v, 0.95) };
  }

  recentVetoes(n: number): VetoRow[] {
    return this.db
      .query<{ id: number; ts_ns: number; ts_wall: number; intent_id: string; rule: number; detail: string }, [number]>(
        "SELECT id, ts_ns, ts_wall, intent_id, rule, detail FROM vetoes ORDER BY id DESC LIMIT ?",
      )
      .all(n)
      .map((r) => ({ id: r.id, tsNs: r.ts_ns, tsWall: r.ts_wall, intentId: r.intent_id, rule: r.rule, detail: r.detail }));
  }

  openOrders(): Order[] {
    const rows = this.db
      .query<
        {
          id: number;
          intent_id: number;
          venue: Venue;
          client_id: string;
          ext_id: string | null;
          status: OrderStatus;
          t_sent_ns: number;
          t_ack_ns: number | null;
          latency_ms: number | null;
          json: string | null;
        },
        []
      >("SELECT id, intent_id, venue, client_id, ext_id, status, t_sent_ns, t_ack_ns, latency_ms, json FROM orders WHERE status IN ('PENDING','NEW','PARTIALLY_FILLED') ORDER BY id")
      .all();
    const out: Order[] = [];
    for (const r of rows) {
      const extra = OrderJson.parse(r.json === null ? {} : JSON.parse(r.json));
      const o: Order = {
        id: r.id,
        intentId: r.intent_id,
        venue: r.venue,
        symbol: extra.symbol,
        side: extra.side,
        qty: extra.qty,
        clientId: r.client_id,
        status: r.status,
        tSentNs: r.t_sent_ns,
      };
      if (extra.price !== null) o.price = extra.price;
      if (r.ext_id !== null) o.extId = r.ext_id;
      if (r.t_ack_ns !== null) o.tAckNs = r.t_ack_ns;
      if (r.latency_ms !== null) o.latencyMs = r.latency_ms;
      out.push(o);
    }
    return out;
  }

  llmCostToday(): number {
    return this.db.query<{ c: number }, [number]>("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM llm_calls WHERE ts_wall >= ?").get(utcDayStartMs())?.c ?? 0;
  }

  /** Outbound x402 payments since 00:00 UTC. */
  dataSpendToday(): number {
    return (
      this.db.query<{ c: number }, [number]>("SELECT COALESCE(SUM(amount), 0) AS c FROM payments WHERE direction = 'out' AND ts_wall >= ?").get(utcDayStartMs())
        ?.c ?? 0
    );
  }

  abMetrics(agent: AgentName, days: number): Record<string, AbModelMetrics> {
    const rows = this.db
      .query<
        { model: string; latency_ms: number; cost_usd: number; schema_valid: number; tool_rejections: number; agreement_pct: number | null; pnl_1h_usd: number | null },
        [AgentName, number]
      >("SELECT model, latency_ms, cost_usd, schema_valid, tool_rejections, agreement_pct, pnl_1h_usd FROM agent_runs WHERE agent = ? AND ts_wall >= ?")
      .all(agent, wallMs() - days * 86_400_000);
    const acc = new Map<
      string,
      { runs: number; cost: number; lat: number[]; valid: number; rejected: number; agreeSum: number; agreeN: number; pnlSum: number; pnlN: number }
    >();
    for (const r of rows) {
      let a = acc.get(r.model);
      if (a === undefined) {
        a = { runs: 0, cost: 0, lat: [], valid: 0, rejected: 0, agreeSum: 0, agreeN: 0, pnlSum: 0, pnlN: 0 };
        acc.set(r.model, a);
      }
      a.runs++;
      a.cost += r.cost_usd;
      a.lat.push(r.latency_ms);
      if (r.schema_valid) a.valid++;
      if (r.tool_rejections > 0) a.rejected++;
      if (r.agreement_pct !== null) {
        a.agreeSum += r.agreement_pct;
        a.agreeN++;
      }
      if (r.pnl_1h_usd !== null) {
        a.pnlSum += r.pnl_1h_usd;
        a.pnlN++;
      }
    }
    const out: Record<string, AbModelMetrics> = {};
    for (const [model, a] of acc) {
      a.lat.sort((x, y) => x - y);
      out[model] = {
        runs: a.runs,
        costUsd: a.cost,
        p50LatencyMs: percentile(a.lat, 0.5),
        schemaValidRate: a.valid / a.runs,
        toolRejectRate: a.rejected / a.runs,
        agreementPct: a.agreeN === 0 ? null : a.agreeSum / a.agreeN,
        pnl1hUsd: a.pnlN === 0 ? null : a.pnlSum,
      };
    }
    return out;
  }

  /** Highest numeric trade_id recorded for (venue, symbol); null when none. */
  lastTradeId(venue: Venue, symbol: string): number | null {
    const r = this.db
      .query<{ t: number | null }, [Venue, string]>("SELECT MAX(CAST(trade_id AS INTEGER)) AS t FROM fills WHERE venue = ? AND symbol = ?")
      .get(venue, symbol);
    return r === null || r.t === null ? null : r.t;
  }


  /**
   * S05: Idempotent migration — ensures fills.UNIQUE is on (venue, symbol, trade_id).
   * Old databases have UNIQUE(venue, trade_id). We detect this by checking the index list,
   * then rebuild: copy fills, drop table, recreate, reinsert. Safe because fills are append-only
   * and duplicates are resolved by INSERT OR IGNORE.
   */
  private migrateFilledUniqueIndex(): void {
    // Check if a unique index already exists on (venue, symbol, trade_id).
    const idxRows = this.db.query<{ name: string; sql: string | null }, []>(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='fills'",
    ).all();
    // If any index covers all three columns, we're done.
    const hasNew = idxRows.some((r) => r.sql !== null && /venue.*symbol.*trade_id|trade_id.*symbol.*venue/i.test(r.sql));
    if (hasNew) return;
    // Rebuild: rename, recreate, reinsert, drop old.
    this.db.exec(`
      BEGIN;
      ALTER TABLE fills RENAME TO fills_old;
      CREATE TABLE fills (id INTEGER PRIMARY KEY, ts_ns INTEGER NOT NULL, ts_wall INTEGER NOT NULL,
        order_id INTEGER NOT NULL, venue TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
        trade_id TEXT NOT NULL, price REAL NOT NULL, qty REAL NOT NULL, fee REAL NOT NULL,
        fee_asset TEXT NOT NULL, UNIQUE(venue, symbol, trade_id));
      CREATE INDEX IF NOT EXISTS ix_fills_venue_symbol ON fills(venue, symbol);
      INSERT OR IGNORE INTO fills SELECT * FROM fills_old;
      DROP TABLE fills_old;
      COMMIT;
    `);
  }

  /** `orders` row by venue + symbol + exchange order id (`ext_id`); null when unknown. S05: symbol-scoped. */
  orderBySymbolExtId(venue: Venue, symbol: string, extId: string): number | null {
    const r = this.db
      .query<{ id: number }, [Venue, string, Venue, string]>(
        "SELECT id FROM orders WHERE venue = ? AND ext_id = ? AND id IN (SELECT DISTINCT order_id FROM fills WHERE venue = ? AND symbol = ?) ORDER BY id DESC LIMIT 1",
      )
      .get(venue, extId, venue, symbol);
    if (r !== null) return r.id;
    // Orders with no fills yet: symbol lives in the json column.
    const r2 = this.db
      .query<{ id: number }, [Venue, string, string]>("SELECT id FROM orders WHERE venue = ? AND ext_id = ? AND json_extract(json, '$.symbol') = ? ORDER BY id DESC LIMIT 1")
      .get(venue, extId, symbol);
    return r2 === null ? null : r2.id;
  }
  // ---- lifecycle ----------------------------------------------------------

  close(): void {
    if (this.closed) return;
    clearInterval(this.timer);
    this.flush();
    this.closed = true;
    this.db.close();
  }
}

// ---- read-only view -------------------------------------------------------

/**
 * Subset of Ledger that only reads; implemented directly over a Database so the dashboard/CLI
 * can use a read-only SQLite connection without coupling to Ledger's write machinery or
 * relying on prototype tricks.
 */
export interface LedgerReader {
  readonly db: Database;
  pnlByEngine(sinceTs: number): PnlByEngineRow[];
  engineStats(engine: EngineId, days: number): EngineStats;
  latencyStats(sinceTs: number): LatencyStats;
  recentVetoes(n: number): VetoRow[];
  openOrders(): Order[];
  llmCostToday(): number;
  dataSpendToday(): number;
  abMetrics(agent: AgentName, days: number): Record<string, AbModelMetrics>;
  dashboardAudit(limit: number, sinceMs?: number): DashboardAuditRead[];
}

/**
 * Build a `LedgerReader` over `db` without opening a new file-based Ledger.
 * Caller is responsible for closing `db`; pass `ledger.db` to piggyback on the writer connection.
 * The `:memory:` test case passes ledger.db to avoid a second open.
 */
export function createLedgerReader(db: Database): LedgerReader {
  return {
    db,
    pnlByEngine(sinceTs) {
      return db.query<PnlByEngineRow, [number]>(
        "SELECT engine, SUM(realized) AS realized, SUM(fees) AS fees, COUNT(*) AS trades, SUM(realized > 0) AS wins FROM trades WHERE ts_wall >= ? GROUP BY engine ORDER BY engine",
      ).all(sinceTs);
    },
    engineStats(engine, days) {
      const rows = db.query<{ realized: number; ret_bps: number }, [EngineId, number]>(
        "SELECT realized, ret_bps FROM trades WHERE engine = ? AND ts_wall >= ? ORDER BY closed_ns, id",
      ).all(engine, wallMs() - days * 86_400_000);
      const n = rows.length;
      if (n === 0) return { trades: 0, hitRate: 0, avgRetBps: 0, sharpe: 0, maxDdBps: 0 };
      let wins = 0; let sum = 0;
      for (const r of rows) { if (r.realized > 0) wins++; sum += r.ret_bps; }
      const mean = sum / n;
      let sharpe = 0;
      if (n >= 2) {
        let ss = 0;
        for (const r of rows) { const d = r.ret_bps - mean; ss += d * d; }
        const std = Math.sqrt(ss / (n - 1));
        sharpe = std === 0 ? 0 : mean / std;
      }
      let cum = 0; let peak = 0; let maxDd = 0;
      for (const r of rows) { cum += r.ret_bps; if (cum > peak) peak = cum; const dd = peak - cum; if (dd > maxDd) maxDd = dd; }
      return { trades: n, hitRate: wins / n, avgRetBps: mean, sharpe, maxDdBps: maxDd };
    },
    latencyStats(sinceTs) {
      const rows = db.query<{ latency_ms: number }, [number]>(
        "SELECT latency_ms FROM orders WHERE ts_wall >= ? AND latency_ms IS NOT NULL",
      ).all(sinceTs);
      const v = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
      return { count: v.length, p50: percentile(v, 0.5), p95: percentile(v, 0.95) };
    },
    recentVetoes(n) {
      return db.query<{ id: number; ts_ns: number; ts_wall: number; intent_id: string; rule: number; detail: string }, [number]>(
        "SELECT id, ts_ns, ts_wall, intent_id, rule, detail FROM vetoes ORDER BY id DESC LIMIT ?",
      ).all(n).map((r) => ({ id: r.id, tsNs: r.ts_ns, tsWall: r.ts_wall, intentId: r.intent_id, rule: r.rule, detail: r.detail }));
    },
    openOrders() {
      const rows = db.query<
        { id: number; intent_id: number; venue: Venue; client_id: string; ext_id: string | null; status: OrderStatus; t_sent_ns: number; t_ack_ns: number | null; latency_ms: number | null; json: string | null },
        []
      >("SELECT id, intent_id, venue, client_id, ext_id, status, t_sent_ns, t_ack_ns, latency_ms, json FROM orders WHERE status IN ('PENDING','NEW','PARTIALLY_FILLED') ORDER BY id").all();
      const out: Order[] = [];
      for (const r of rows) {
        const extra = OrderJson.parse(r.json === null ? {} : JSON.parse(r.json));
        const o: Order = { id: r.id, intentId: r.intent_id, venue: r.venue, symbol: extra.symbol, side: extra.side, qty: extra.qty, clientId: r.client_id, status: r.status, tSentNs: r.t_sent_ns };
        if (extra.price !== null) o.price = extra.price;
        if (r.ext_id !== null) o.extId = r.ext_id;
        if (r.t_ack_ns !== null) o.tAckNs = r.t_ack_ns;
        if (r.latency_ms !== null) o.latencyMs = r.latency_ms;
        out.push(o);
      }
      return out;
    },
    llmCostToday() {
      return db.query<{ c: number }, [number]>("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM llm_calls WHERE ts_wall >= ?").get(utcDayStartMs())?.c ?? 0;
    },
    dataSpendToday() {
      return db.query<{ c: number }, [number]>("SELECT COALESCE(SUM(amount), 0) AS c FROM payments WHERE direction = 'out' AND ts_wall >= ?").get(utcDayStartMs())?.c ?? 0;
    },
    abMetrics(agent, days) {
      const rows = db.query<
        { model: string; latency_ms: number; cost_usd: number; schema_valid: number; tool_rejections: number; agreement_pct: number | null; pnl_1h_usd: number | null },
        [AgentName, number]
      >("SELECT model, latency_ms, cost_usd, schema_valid, tool_rejections, agreement_pct, pnl_1h_usd FROM agent_runs WHERE agent = ? AND ts_wall >= ?")
      .all(agent, wallMs() - days * 86_400_000);
      const acc = new Map<string, { runs: number; cost: number; lat: number[]; valid: number; rejected: number; agreeSum: number; agreeN: number; pnlSum: number; pnlN: number }>();
      for (const r of rows) {
        let a = acc.get(r.model);
        if (a === undefined) { a = { runs: 0, cost: 0, lat: [], valid: 0, rejected: 0, agreeSum: 0, agreeN: 0, pnlSum: 0, pnlN: 0 }; acc.set(r.model, a); }
        a.runs++; a.cost += r.cost_usd; a.lat.push(r.latency_ms);
        if (r.schema_valid) a.valid++;
        if (r.tool_rejections > 0) a.rejected++;
        if (r.agreement_pct !== null) { a.agreeSum += r.agreement_pct; a.agreeN++; }
        if (r.pnl_1h_usd !== null) { a.pnlSum += r.pnl_1h_usd; a.pnlN++; }
      }
      const out: Record<string, AbModelMetrics> = {};
      for (const [model, a] of acc) {
        a.lat.sort((x, y) => x - y);
        out[model] = { runs: a.runs, costUsd: a.cost, p50LatencyMs: percentile(a.lat, 0.5), schemaValidRate: a.valid / a.runs, toolRejectRate: a.rejected / a.runs, agreementPct: a.agreeN === 0 ? null : a.agreeSum / a.agreeN, pnl1hUsd: a.pnlN === 0 ? null : a.pnlSum };
      }
      return out;
    },
    dashboardAudit(limit, sinceMs) {
      type Row = { id: number; ts_wall: number; session: string; role: string; action: string; status: number; ua: string; detail: string | null };
      const rows = sinceMs === undefined
        ? db.query<Row, [number]>("SELECT id, ts_wall, session, role, action, status, ua, detail FROM dashboard_audit ORDER BY id DESC LIMIT ?").all(limit)
        : db.query<Row, [number, number]>("SELECT id, ts_wall, session, role, action, status, ua, detail FROM dashboard_audit WHERE ts_wall >= ? ORDER BY id DESC LIMIT ?").all(sinceMs, limit);
      return rows.map((r) => ({ id: r.id, tsWall: r.ts_wall, session: r.session, role: r.role, action: r.action, status: r.status, ua: r.ua, detail: r.detail }));
    },
  };
}

export function openLedger(path: string): Ledger {
  return new Ledger(path);
}

/** Second, read-only connection (dashboard / CLI). Caller closes it. */
export function openReadOnly(path: string): Database {
  const db = new Database(path, { readonly: true, strict: true });
  db.exec("PRAGMA busy_timeout=2000");
  return db;
}
