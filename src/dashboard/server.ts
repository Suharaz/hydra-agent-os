// Local-only operator dashboard: loopback bind enforced in code, HttpOnly cookie sessions (or a
// bearer token for curl/tests) on every /api/* route, single-use tickets for /ws, Origin pinned to
// localhost. Two roles: viewer (GET + live stream, no logs) and operator (config writes, kill,
// dream run, session revocation). Failed auth is throttled globally; every mutation lands in the
// `dashboard_audit` ledger table. Reads go through a second read-only sqlite connection.
// Snapshots are built only while a WebSocket client is connected (250 ms) and dropped for a
// client whose send buffer is above 1 MB. Static UI: public/index.html (/classic) and the
// repo-root hydra-demo.html (/), each served with a CSP pinned to the hash of its one inline script.

import { spawn as spawnDetached } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { alert } from "../core/alert.ts";
import { type Bus, bus as globalBus, type EventName, type HydraEvents } from "../core/bus.ts";
import {
  AgentSchema,
  type AgentsConfig,
  BUDGET_KEYS,
  type BudgetPatch,
  type Config,
  ConfigError,
  type EnginesConfig,
  loadConfig,
  type OperatorActor,
  type RiskConfig,
  watchAgents,
  watchEngines,
  writeAgents,
  writeBudgets,
} from "../core/config.ts";
import { type Env, venueMatrix } from "../core/env.ts";
import { createLedgerReader, type Ledger, type LedgerReader, openReadOnly } from "../core/ledger.ts";
import { logger, recent } from "../core/log.ts";
import { readBudgets, readKillLock, readLimits } from "../core/state.ts";
import { AGENT_NAMES, ENGINE_IDS, type AgentName, type EngineId } from "../core/types.ts";
import type { EngineRegistry } from "../hot/engines/registry.ts";
import type { ExecutorStack } from "../hot/executor.ts";
import type { FeedHub } from "../hot/feed-hub.ts";
import type { Module } from "../main.ts";
import { executeDreamCycle, loadDreamMemory } from "../cold/dream.ts";
import { MIN_PASSPHRASE, mergeSecrets, passphraseEquals, SECRET_KEYS, SecretsError, secretsExist, secretsPresent, verifyPassphrase, type SecretKey, type SecretMap } from "../core/secrets.ts";
import { DEFAULT_LOCKOUT, Lockout } from "./lockout.ts";
import { cookie, DEFAULT_ABSOLUTE_MS, DEFAULT_IDLE_MS, DEFAULT_MAX_SESSIONS, DEFAULT_TICKET_MS, type Role, SESSION_COOKIE, SessionStore } from "./session.ts";

const log = logger("dashboard");

export const SNAPSHOT_MS = 250;
export const WS_MAX_BUFFERED = 1024 * 1024;
export const WS_MAX_CLIENTS = 8;
export const BODY_LIMIT_BYTES = 64 * 1024;
export const MODELS_URL = "https://openrouter.ai/api/v1/models";
const MODELS_TTL_MS = 60_000;
const TAPE_SIZE = 200;
const LOG_LINES = 100;
const DAY_MS = 86_400_000;
const AGENT_KEYS = Object.keys(AgentSchema.shape);
const LOCAL_HOSTS: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true, "::1": true };
const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/g;
/** Bus events mirrored into the live tape (panel 2/4/6). */
const TAPE_EVENTS: readonly EventName[] = [
  "feed.liq",
  "engine.intent",
  "kernel.veto",
  "exec.order",
  "exec.fill",
  "exec.rollback",
  "guardian.breach",
  "system.kill",
  "system.kill.failed",
  "system.kill.cleared",
  "system.throttle",
  "system.llm_credits",
  "agent.decision",
  "config.reload",
  "limits.reload",
  "budgets.reload",
  "dream.cycle",
];

/** The slice of the hot lane the snapshot reads; `HotLane` satisfies it, tests pass stubs. */
export interface DashboardHot {
  feed: { hub: Pick<FeedHub, "book" | "mark" | "burst" | "gapBps" | "spotTopOfBook"> };
  registry: Pick<EngineRegistry, "contracts" | "stats">;
  executor: { stack: ExecutorStack | null };
}

export interface DashboardDeps {
  env: Env;
  config: Config;
  ledger: Ledger;
  stateDir: string;
  configDir: string;
  hot: DashboardHot;
  port?: number;
  /** Loopback only; anything else throws DashboardBindError unless `allowNonLoopbackForTests`. */
  hostname?: string;
  allowNonLoopbackForTests?: boolean;
  bus?: Bus;
  /** Model catalogue fetch (tests stub it). */
  fetchModels?: () => Promise<string[]>;
  /** Injectable clock for session/lockout tests. */
  now?: () => number;
}

export class DashboardBindError extends Error {
  constructor(hostname: string) {
    super(`dashboard must bind a loopback address, got "${hostname}"; remote access is an SSH tunnel (see README, Security model)`);
    this.name = "DashboardBindError";
  }
}

/** Who is calling: resolved once per request by the auth middleware. */
interface Auth {
  role: Role;
  /** First 8 chars of the session id, or "bearer". */
  session: string;
  sessionId: string | null;
  ua: string;
}

type AuditAction = "login" | "logout" | "revoke_all" | "lockout" | "auth_fail" | "agents_put" | "budgets_put" | "promote_shadow" | "kill" | "dream_run" | "secrets_save" | "secrets_unlock";

type Vars = { Variables: { auth: Auth; auditDetail: Record<string, unknown> | undefined } };

export interface Dashboard {
  app: Hono<Vars>;
  start(): { port: number };
  stop(): void;
  module: Module;
}

interface TapeEntry {
  ts: number;
  name: EventName;
  payload: unknown;
}

/** Interface the dashboard consumes from the ledger; satisfied by both Ledger and LedgerReader. */
type LedgerReads = LedgerReader;

interface AgentRunRecord {
  id: number;
  ts: number;
  runId: string;
  agent: AgentName;
  role: string;
  model: string;
  decision: unknown;
  applied: boolean;
  toolRejections: number;
  costUsd: number;
  latencyMs: number;
  schemaValid: boolean;
  agreementPct: number | null;
  pnl1hUsd: number | null;
}

/** Open a read-only view over the ledger's file, or reuse the writer db for in-memory ledgers. */
function ledgerReads(ledger: Ledger): { reads: LedgerReads; close: () => void } {
  const file = ledger.db.filename;
  if (file === "" || file === ":memory:") return { reads: createLedgerReader(ledger.db), close: () => {} };
  const db = openReadOnly(file);
  return { reads: createLedgerReader(db), close: () => db.close() };
}

/** True when the Origin header is from the dashboard's own bound address. Non-browser clients
 * (curl, tests) omit Origin and are allowed through (token still required). */
function originAllowed(origin: string | undefined, allowedPorts: ReadonlySet<number>): boolean {
  if (origin === undefined) return true;
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (LOCAL_HOSTS[u.hostname] !== true) return false;
  const port = u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port);
  return allowedPorts.has(port);
}

/** Constant-time token comparison: hashes both sides so length cannot be inferred from timing. */
function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const h = (s: string): Buffer => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(presented), h(expected));
}

function bearer(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith("Bearer ")) return null;
  return header.slice(7).trim();
}

/** Audit action for a mutating route, or null for routes that are not audited by the middleware. */
function actionOf(method: string, path: string): AuditAction | null {
  if (method === "PUT") {
    if (path === "/api/config/agents") return "agents_put";
    if (path === "/api/config/budgets") return "budgets_put";
    return null;
  }
  if (method !== "POST") return null;
  if (path === "/api/kill") return "kill";
  if (path === "/api/dream/run") return "dream_run";
  if (path === "/api/sessions/revoke-all") return "revoke_all";
  if (path === "/api/logout") return "logout";
  if (path.startsWith("/api/config/agents/") && path.endsWith("/promote-shadow")) return "promote_shadow";
  if (path === "/api/secrets/save") return "secrets_save";
  if (path === "/api/secrets/unlock") return "secrets_unlock";
  return null;
}

/** Inline-script CSP hash for one HTML file; the file must contain exactly one `<script>` block. */
function scriptHash(html: string, name: string): string {
  const matches = [...html.matchAll(INLINE_SCRIPT)];
  if (matches.length !== 1) throw new Error(`${name}: expected exactly one inline <script>, found ${matches.length} (CSP hash cannot cover more)`);
  return `'sha256-${createHash("sha256").update(matches[0]?.[1] ?? "").digest("base64")}'`;
}

function cspFor(script: string | null): string {
  const scriptSrc = script === null ? "'none'" : script;
  return `default-src 'none'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
}

/** Pages set their own hash-pinned CSP; everything else gets the no-script policy. */
function securityHeaders(headers: Headers, csp: string): void {
  if (!headers.has("content-security-policy")) headers.set("content-security-policy", csp);
  headers.set("x-frame-options", "DENY");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
}

function sessionCookie(id: string | null, secure: boolean): string {
  const base = `${SESSION_COOKIE}=${id ?? ""}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  return id === null ? `${base}; Max-Age=0` : base;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Per-agent patch validation. Unknown agent/key → problems; values → AgentSchema field schemas.
 * shadow_model: null is accepted and produces undefined (signals deletion of the key in YAML). */
function validateAgentsPatch(body: unknown): { patch: Record<string, Record<string, unknown>>; problems: string[] } {
  const problems: string[] = [];
  const patch: Record<string, Record<string, unknown>> = {};
  const root = isPlainObject(body) && "agents" in body ? body.agents : body;
  if (!isPlainObject(root)) return { patch, problems: ["body: expected { <agent>: { <key>: value } }"] };
  for (const [agent, fields] of Object.entries(root)) {
    if (!(AGENT_NAMES as readonly string[]).includes(agent)) {
      problems.push(`${agent}: unknown agent (allowed: ${AGENT_NAMES.join(", ")})`);
      continue;
    }
    if (!isPlainObject(fields)) {
      problems.push(`${agent}: expected an object`);
      continue;
    }
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!AGENT_KEYS.includes(key)) {
        problems.push(`${agent}.${key}: not an agent setting (allowed: ${AGENT_KEYS.join(", ")})`);
        continue;
      }
      // shadow_model: null means "remove shadow"; signal deletion via undefined so writeYaml
      // calls doc.setIn(path, undefined) which the yaml library treats as key deletion.
      if (key === "shadow_model" && value === null) {
        clean[key] = undefined; // explicit deletion marker
        continue;
      }
      const field = AgentSchema.shape[key as keyof typeof AgentSchema.shape];
      const parsed = field.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) problems.push(`${agent}.${key}${issue.path.length > 0 ? `.${issue.path.join(".")}` : ""}: ${issue.message}`);
        continue;
      }
      clean[key] = parsed.data;
    }
    if (Object.keys(clean).length > 0) patch[agent] = clean;
  }
  if (problems.length === 0 && Object.keys(patch).length === 0) problems.push("body: empty patch");
  return { patch, problems };
}

export interface Capability {
  name: string;
  on: boolean;
  /** What is running now, or what is missing. */
  detail: string;
}

/** One line per external surface: what runs now and which variable unlocks the rest. */
export function capabilities(env: Env): Capability[] {
  const cex = (venue: "spot" | "futures"): Capability => {
    const key = env.keys[venue];
    const flag = env[venue];
    if (key === null) return { name: `${venue} orders`, on: false, detail: `paper fills only — set BINANCE_${venue.toUpperCase()}_API_KEY/_SECRET (${flag})` };
    return { name: `${venue} orders`, on: true, detail: flag === "live" ? "REAL MONEY" : `${flag} venue` };
  };
  return [
    { name: "market data", on: true, detail: `${env.futures === "live" ? "fstream" : "demo-fstream"} + spot ${env.spot}` },
    cex("futures"),
    cex("spot"),
    env.openrouterApiKey === null
      ? { name: "LLM agents (cold lane)", on: false, detail: "off — set OPENROUTER_API_KEY" }
      : { name: "LLM agents (cold lane)", on: true, detail: "OpenRouter" },
    env.onchain === "live"
      ? { name: "on-chain (baw)", on: true, detail: `live via ${env.bawBin}` }
      : { name: "on-chain (baw)", on: false, detail: "paper adapter — set ONCHAIN=live + BAW_BIN (Linux/WSL)" },
    { name: "Skills Hub HTTP", on: env.skillsHttp !== "off", detail: env.skillsHttp === "off" ? "fixtures" : "real public endpoints" },
    env.x402 === "mock"
      ? { name: "x402 settlement", on: false, detail: "mock facilitator (synthetic tx) — set X402=b402|cdp + credentials" }
      : { name: "x402 settlement", on: true, detail: `${env.x402} facilitator` },
    env.mcp === "on" ? { name: "Binance MCP", on: true, detail: "OAuth bridge" } : { name: "Binance MCP", on: false, detail: "off — set MCP=on" },
    env.telegramBotToken !== null || env.alertWebhook !== null
      ? { name: "alerts", on: true, detail: env.telegramBotToken !== null ? "Telegram" : "webhook" }
      : { name: "alerts", on: false, detail: "log only — set TELEGRAM_BOT_TOKEN/CHAT_ID" },
  ];
}

async function fetchOpenRouterModels(): Promise<string[]> {
  const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`openrouter ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  const ids: string[] = [];
  for (const m of body.data ?? []) if (typeof m.id === "string") ids.push(m.id);
  return ids.sort();
}

export function createDashboard(deps: DashboardDeps): Dashboard {
  const hostname = deps.hostname ?? "127.0.0.1";
  if (LOCAL_HOSTS[hostname] !== true && deps.allowNonLoopbackForTests !== true) throw new DashboardBindError(hostname);
  const bus = deps.bus ?? globalBus;
  const token = deps.env.dashboardToken;
  const viewerToken = deps.env.dashboardViewerToken;
  const dashboardUser = deps.env.dashboardUser;
  const dashboardPassword = deps.env.dashboardPassword;
  const fetchModels = deps.fetchModels ?? fetchOpenRouterModels;
  const now = deps.now ?? Date.now;
  const sessions = new SessionStore({ idleMs: DEFAULT_IDLE_MS, absoluteMs: DEFAULT_ABSOLUTE_MS, max: DEFAULT_MAX_SESSIONS, now });
  const lockout = new Lockout({ ...DEFAULT_LOCKOUT, now });
  const app = new Hono<Vars>();
  let server: Server<unknown> | null = null;
  let ledger: { reads: LedgerReads; close: () => void } | null = null;
  // Populated in start() with the actual bound port; used by originAllowed.
  let allowedPorts: ReadonlySet<number> = new Set([deps.port ?? deps.env.dashboardPort]);

  // ---- static files: fail fast if a page cannot be covered by one CSP hash ---------
  const indexPath = join(import.meta.dir, "public", "index.html");
  const demoPath = join(import.meta.dir, "..", "..", "hydra-demo.html");
  scriptHash(readFileSync(indexPath, "utf8"), "index.html");
  scriptHash(readFileSync(demoPath, "utf8"), "hydra-demo.html");

  // ---- live config copies (hot-reload aware) --------------------------------
  let engines: EnginesConfig = deps.config.engines;
  let agents: AgentsConfig = deps.config.agents;
  let risk: RiskConfig = deps.config.risk;
  let riskReadAt = Date.now();
  const unwatch: Array<() => void> = [];
  const refreshRisk = (): RiskConfig => {
    if (Date.now() - riskReadAt > 5000) {
      try {
        risk = loadConfig(deps.configDir).risk;
      } catch (err) {
        log.warn("risk.yaml reload failed", { error: errText(err) });
      }
      riskReadAt = Date.now();
    }
    return risk;
  };
  const reads = (): LedgerReads => {
    if (ledger === null) ledger = ledgerReads(deps.ledger);
    return ledger.reads;
  };

  // ---- event tape -----------------------------------------------------------
  const tape: TapeEntry[] = [];
  const busOffs: Array<() => void> = [];
  const record = (name: EventName) => (payload: unknown) => {
    tape.push({ ts: Date.now(), name, payload });
    if (tape.length > TAPE_SIZE) tape.splice(0, tape.length - TAPE_SIZE);
  };

  // ---- snapshot ---------------------------------------------------------------
  const engineRows = (now: number) => {
    const contracts = new Map(deps.hot.registry.contracts().map((c) => [c.engine, c]));
    const pnl = new Map(reads().pnlByEngine(now - DAY_MS).map((r) => [r.engine, r]));
    const stats = deps.hot.registry.stats();
    const budgets = readBudgets(deps.stateDir);
    return ENGINE_IDS.map((id) => {
      const cfg = engines.engines[id];
      const p = pnl.get(id);
      return {
        id,
        enabled: cfg.enabled,
        paper: cfg.paper,
        symbols: cfg.symbols,
        sizeUsd: cfg.sizeUsd,
        params: cfg.params,
        budgetUsd: budgets[id] ?? null,
        maxNotionalUsd: risk.per_engine_max_notional_usd[id],
        contract: contracts.get(id) ?? null,
        pnl24h: p === undefined ? 0 : p.realized - p.fees,
        trades24h: p?.trades ?? 0,
        hitRate: p === undefined || p.trades === 0 ? null : p.wins / p.trades,
        stats: stats[id] ?? {},
      };
    });
  };

  const snapshot = (role: Role) => {
    const now = Date.now();
    const hub = deps.hot.feed.hub;
    const stack = deps.hot.executor.stack;
    const r = refreshRisk();
    const books = r.allowed_symbols.futures.map((symbol) => {
      const b = hub.book(symbol);
      const m = hub.mark(symbol);
      const burst = hub.burst(symbol);
      return {
        symbol,
        synced: b?.synced ?? false,
        ageMs: b === null || !Number.isFinite(b.ageMs) ? null : b.ageMs,
        bid: b?.bestBid ?? null,
        ask: b?.bestAsk ?? null,
        mid: b?.mid ?? null,
        spreadBps: b?.spreadBps ?? null,
        imbalance: b?.imbalance ?? null,
        mark: m?.mark ?? null,
        index: m?.index ?? null,
        fundingRate: m?.fundingRate ?? null,
        gapBps: hub.gapBps(symbol),
        buyUsd1s: burst.buyUsd1s,
        sellUsd1s: burst.sellUsd1s,
      };
    });
    const spot = r.allowed_symbols.spot.map((symbol) => ({ symbol, top: hub.spotTopOfBook(symbol) }));
    const limits = readLimits(deps.stateDir);
    const kill = readKillLock(deps.stateDir);
    const db = reads();
    const payments = db.db
      .query<{ id: number; ts_wall: number; direction: string; counterparty: string; amount: number; asset: string; network: string; tx: string }, []>(
        "SELECT id, ts_wall, direction, counterparty, amount, asset, network, tx FROM payments ORDER BY id DESC LIMIT 30",
      )
      .all();
    return {
      ts: now,
      role,
      mode: deps.env.mode,
      venues: venueMatrix(deps.env).map(([venue, flag, realMoney]) => ({ venue, flag, realMoney })),
      capabilities: capabilities(deps.env),
      latency: db.latencyStats(now - DAY_MS),
      books,
      spot,
      tape,
      executor: {
        started: stack !== null,
        paused: stack?.executor.paused ?? false,
        nav: stack?.positions.nav() ?? null,
        drawdownPct: stack?.positions.drawdownPct() ?? null,
        positions: stack === null ? [] : stack.positions.snapshot(),
      },
      openOrders: db.openOrders(),
      kill,
      limits,
      engines: engineRows(now),
      agents:
        role === "operator"
          ? { config: agents.agents, overrides: deps.env.modelOverrides }
          : {
              config: Object.fromEntries(
                Object.entries(agents.agents).map(([k, c]) => [k, { ...c, model: "hidden", shadow_model: c.shadow_model === undefined ? undefined : "hidden", fallback_models: [] }]),
              ),
              overrides: {},
            },
      spend: {
        llmTodayUsd: db.llmCostToday(),
        llmBudgetUsd: r.llm_daily_budget_usd,
        dataTodayUsd: db.dataSpendToday(),
        dataBudgetUsd: r.data_daily_budget_usd,
      },
      payments,
      vetoes: db.recentVetoes(20),
      // Log lines can echo config diffs, wallet labels and error bodies: operator only.
      ...(role === "operator" ? { logs: recent(LOG_LINES) } : {}),
    };
  };

  const agentRuns = (limit: number, agent: string | undefined): AgentRunRecord[] => {
    const db = reads().db;
    const sql = `SELECT id, ts_wall, run_id, agent, role, model, decision_json, applied, tool_rejections, cost_usd, latency_ms, schema_valid, agreement_pct, pnl_1h_usd
                 FROM agent_runs ${agent === undefined ? "" : "WHERE agent = ? "}ORDER BY id DESC LIMIT ?`;
    type Row = {
      id: number;
      ts_wall: number;
      run_id: string;
      agent: AgentName;
      role: string;
      model: string;
      decision_json: string;
      applied: number;
      tool_rejections: number;
      cost_usd: number;
      latency_ms: number;
      schema_valid: number;
      agreement_pct: number | null;
      pnl_1h_usd: number | null;
    };
    const rows = agent === undefined ? db.query<Row, [number]>(sql).all(limit) : db.query<Row, [string, number]>(sql).all(agent, limit);
    return rows.map((r) => {
      let decision: unknown = null;
      try {
        decision = JSON.parse(r.decision_json);
      } catch {
        decision = r.decision_json;
      }
      return {
        id: r.id,
        ts: r.ts_wall,
        runId: r.run_id,
        agent: r.agent,
        role: r.role,
        model: r.model,
        decision,
        applied: r.applied === 1,
        toolRejections: r.tool_rejections,
        costUsd: r.cost_usd,
        latencyMs: r.latency_ms,
        schemaValid: r.schema_valid === 1,
        agreementPct: r.agreement_pct,
        pnl1hUsd: r.pnl_1h_usd,
      };
    });
  };

  // ---- auth -------------------------------------------------------------------
  const audit = (auth: Auth | null, action: AuditAction, status: number, detail: Record<string, unknown> | null): void => {
    deps.ledger.insertDashboardAudit({
      session: auth?.session ?? "-",
      role: auth?.role ?? "-",
      action,
      status,
      ua: auth?.ua ?? "",
      detail: detail === null ? null : JSON.stringify(detail),
    });
  };
  const resolveRole = (presented: string | null): Role | null => {
    if (tokenMatches(presented, token)) return "operator";
    if (viewerToken !== null && tokenMatches(presented, viewerToken)) return "viewer";
    return null;
  };
  const locked = (): Response | null => {
    const ms = lockout.locked();
    if (ms === 0) return null;
    return Response.json({ error: `locked out after repeated failures; retry in ${Math.ceil(ms / 1000)} s`, retryAfterMs: ms }, { status: 429, headers: { "retry-after": String(Math.ceil(ms / 1000)) } });
  };
  /** Counts one credential failure; engages the lock (alert + audit) on the fifth. */
  const failed = (ua: string, what: string): Response => {
    if (lockout.fail()) {
      log.warn("dashboard auth lockout engaged", { what });
      audit({ role: "viewer", session: "-", sessionId: null, ua }, "lockout", 429, { what });
      void alert("warn", `dashboard auth lockout: ${DEFAULT_LOCKOUT.max} failures in ${DEFAULT_LOCKOUT.windowMs / 1000} s`);
      return locked() ?? new Response("unauthorized", { status: 401 });
    }
    return Response.json({ error: "unauthorized" }, { status: 401 });
  };
  /**
   * Bearer (curl/tests) or cookie session (browsers). Cookie misses are not counted as failures:
   * a stale cookie after a restart is not a brute force, and session ids are 256-bit.
   */
  const authorize = (req: Request): Auth | Response => {
    const denied = locked();
    if (denied !== null) return denied;
    const ua = req.headers.get("user-agent") ?? "";
    const origin = req.headers.get("origin") ?? undefined;
    const presented = bearer(req.headers.get("authorization") ?? undefined);
    if (presented !== null) {
      const role = resolveRole(presented);
      if (role === null) return failed(ua, "bearer");
      if (!originAllowed(origin, allowedPorts)) return Response.json({ error: "forbidden origin" }, { status: 403 });
      lockout.succeed();
      return { role, session: "bearer", sessionId: null, ua };
    }
    const id = cookie(req.headers.get("cookie") ?? undefined, SESSION_COOKIE);
    const session = id === null ? null : sessions.get(id);
    if (session === null) {
      // No credential: treat as an anonymous read-only viewer so the public landing shows the live
      // system without a login. Mutations stay operator-only (enforced by the middleware below); the
      // ws-ticket handshake is allowed so the live tape streams for anonymous viewers too.
      if (req.method === "GET") return { role: "viewer", session: "anon", sessionId: null, ua };
      if (new URL(req.url).pathname === "/api/ws-ticket") {
        if (origin === undefined || !originAllowed(origin, allowedPorts)) return Response.json({ error: "forbidden origin" }, { status: 403 });
        return { role: "viewer", session: "anon", sessionId: null, ua };
      }
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    // Browsers always send Origin on non-GET; a cookie-bearing write without it is not a browser we trust.
    if (req.method !== "GET" && origin === undefined) return Response.json({ error: "forbidden origin" }, { status: 403 });
    if (!originAllowed(origin, allowedPorts)) return Response.json({ error: "forbidden origin" }, { status: 403 });
    return { role: session.role, session: session.id.slice(0, 8), sessionId: session.id, ua };
  };

  // Security headers on every response, including static pages and errors.
  app.use("*", async (c, next) => {
    await next();
    securityHeaders(c.res.headers, cspFor(null));
    if (c.req.path.startsWith("/api/")) c.res.headers.set("cache-control", "no-store");
  });

  app.use("/api/*", bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: (c) => c.json({ error: `body exceeds ${BODY_LIMIT_BYTES} bytes` }, 413) }));

  // Login is the only /api route without a credential; it still honours the lock and the Origin pin.
  app.post("/api/login", async (c) => {
    const denied = locked();
    if (denied !== null) return denied;
    const ua = c.req.header("user-agent") ?? "";
    if (!originAllowed(c.req.header("origin"), allowedPorts)) return c.json({ error: "forbidden origin" }, 403);
    const body = await jsonBody(c);
    const presented = isPlainObject(body) && typeof body.token === "string" ? body.token : null;
    const username = isPlainObject(body) && typeof body.username === "string" ? body.username : null;
    const password = isPlainObject(body) && typeof body.password === "string" ? body.password : null;
    let role: Role | null = presented !== null ? resolveRole(presented) : null;
    if (role === null && username !== null && password !== null && dashboardPassword !== null) {
      if (tokenMatches(username, dashboardUser) && tokenMatches(password, dashboardPassword)) role = "operator";
    }
    if (role === null) {
      audit({ role: "viewer", session: "-", sessionId: null, ua }, "auth_fail", 401, { what: "login" });
      return failed(ua, "login");
    }
    lockout.succeed();
    const s = sessions.create(role, ua);
    audit({ role, session: s.id.slice(0, 8), sessionId: s.id, ua }, "login", 200, null);
    c.header("set-cookie", sessionCookie(s.id, new URL(c.req.url).protocol === "https:"));
    return c.json({ role });
  });

  // Auth + role policy: GET is open to both roles; every other method is operator-only unless it
  // is one of the session routes. Deny-by-default: a future write route is operator-only for free.
  const SESSION_ROUTES: Record<string, true> = { "/api/logout": true, "/api/ws-ticket": true };
  app.use("/api/*", async (c, next) => {
    const auth = authorize(c.req.raw);
    if (auth instanceof Response) return auth;
    c.set("auth", auth);
    c.set("auditDetail", undefined);
    const method = c.req.method;
    if (method !== "GET" && auth.role !== "operator" && SESSION_ROUTES[c.req.path] !== true) {
      const action = actionOf(method, c.req.path);
      if (action !== null) audit(auth, action, 403, null);
      return c.json({ error: "operator role required" }, 403);
    }
    const action = actionOf(method, c.req.path);
    if (action === null) return next();
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } finally {
      audit(auth, action, status, c.get("auditDetail") ?? null);
    }
  });

  app.onError((err, c) => {
    if (err instanceof ConfigError) return c.json({ error: err.message, problems: err.problems }, 400);
    log.error("request failed", { path: c.req.path, error: errText(err) });
    return c.json({ error: errText(err) }, 500);
  });

  // ---- session routes ---------------------------------------------------------
  app.get("/api/session", (c) => c.json({ role: c.get("auth").role, mode: deps.env.mode }));

  app.post("/api/logout", (c) => {
    const auth = c.get("auth");
    if (auth.sessionId !== null) sessions.revoke(auth.sessionId);
    c.header("set-cookie", sessionCookie(null, new URL(c.req.url).protocol === "https:"));
    return c.body(null, 204);
  });

  app.post("/api/sessions/revoke-all", (c) => {
    const revoked = sessions.revokeAll();
    c.set("auditDetail", { revoked });
    c.header("set-cookie", sessionCookie(null, new URL(c.req.url).protocol === "https:"));
    return c.json({ ok: true, revoked });
  });

  app.post("/api/ws-ticket", (c) => {
    const auth = c.get("auth");
    // Bearer callers have no session to bind a ticket to; they get a throwaway session of their role.
    const sessionId = auth.sessionId ?? sessions.create(auth.role, auth.ua).id;
    const ticket = sessions.issueTicket(sessionId);
    if (ticket === null) return c.json({ error: "unauthorized" }, 401);
    return c.json({ ticket, ttlMs: DEFAULT_TICKET_MS });
  });

  app.get("/api/audit", (c) => {
    if (c.get("auth").role !== "operator") return c.json({ error: "operator role required" }, 403);
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const sinceRaw = c.req.query("since");
    const since = sinceRaw === undefined ? undefined : Number(sinceRaw);
    if (since !== undefined && !Number.isFinite(since)) return c.json({ error: "since: expected epoch milliseconds" }, 400);
    const rows = reads().dashboardAudit(limit, since).map((r) => ({ id: r.id, ts: r.tsWall, session: r.session, role: r.role, action: r.action, status: r.status, ua: r.ua, detail: r.detail }));
    return c.json({ rows });
  });

  // ---- secrets (operator-only): UI-managed credentials, AES-256-GCM encrypted at rest ----------
  // Values apply on the NEXT process start (see main.ts): saving never mutates the live process,
  // matching the fail-fast env model. The launch env must carry HYDRA_MASTER_PASSPHRASE for a saved
  // store to be decryptable at boot; `passphraseSet` tells the UI whether that is the case.
  const bootPassphrase = process.env.HYDRA_MASTER_PASSPHRASE ?? "";
  const supervised = process.env.HYDRA_SUPERVISED === "1" || process.env.HYDRA_SUPERVISED === "true";
  // Wrong passphrases are throttled by the same global lockout as token failures: reaching these
  // routes needs an operator credential, but a hijacked session must not get unlimited scrypt guesses.
  const failPassphrase = (): Response => {
    const tripped = lockout.fail();
    if (tripped) log.warn("dashboard secrets passphrase lockout engaged");
    return (tripped ? locked() : null) ?? Response.json({ error: "wrong passphrase" }, { status: 401 });
  };
  // Apply saved keys on a fresh boot. Under a supervisor (HYDRA_SUPERVISED=1) a clean exit suffices;
  // standalone we self-respawn a detached copy so "Save & Restart" actually comes back up.
  const scheduleRestart = () => {
    if (!supervised) {
      try {
        // detached + new process group so the child outlives this process's exit (incl. on Windows);
        // stdio ignored so it is not tied to our console. HYDRA_RESPAWN makes the child wait for this
        // process to release its dashboard/x402 ports before it boots, so there is no bind race.
        const child = spawnDetached(process.execPath, process.argv.slice(1), { cwd: process.cwd(), env: { ...process.env, HYDRA_RESPAWN: "1" }, detached: true, stdio: "ignore", windowsHide: true });
        child.unref();
      } catch (err) {
        log.error("self-respawn failed; exiting for a supervisor to restart", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    setTimeout(() => process.exit(0), 300);
  };
  app.get("/api/secrets/status", (c) => {
    if (c.get("auth").role !== "operator") return c.json({ error: "operator role required" }, 403);
    return c.json({ keys: SECRET_KEYS, present: secretsPresent(deps.stateDir), exists: secretsExist(deps.stateDir), passphraseSet: bootPassphrase !== "", supervised });
  });

  app.post("/api/secrets/unlock", async (c) => {
    const body = await jsonBody(c);
    const passphrase = isPlainObject(body) && typeof body.passphrase === "string" ? body.passphrase : "";
    if (passphrase === "") return c.json({ error: "passphrase required" }, 400);
    if (!verifyPassphrase(deps.stateDir, passphrase)) return failPassphrase();
    lockout.succeed();
    return c.json({ ok: true, present: secretsPresent(deps.stateDir) });
  });

  app.post("/api/secrets/save", async (c) => {
    const body = await jsonBody(c);
    if (!isPlainObject(body)) return c.json({ error: "body: expected { passphrase, secrets, restart? }" }, 400);
    const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
    if (passphrase.length < MIN_PASSPHRASE) return c.json({ error: `passphrase must be at least ${MIN_PASSPHRASE} characters` }, 400);
    if (!isPlainObject(body.secrets)) return c.json({ error: "secrets: expected an object of { KEY: value }" }, 400);
    const updates: SecretMap = {};
    const unknown: string[] = [];
    for (const [k, v] of Object.entries(body.secrets)) {
      if (!(SECRET_KEYS as readonly string[]).includes(k)) {
        unknown.push(k);
        continue;
      }
      if (typeof v !== "string") return c.json({ error: `secrets.${k}: expected a string` }, 400);
      updates[k as SecretKey] = v;
    }
    if (unknown.length > 0) return c.json({ error: `unknown secret keys: ${unknown.join(", ")}` }, 400);
    if (bootPassphrase !== "" && !passphraseEquals(passphrase, bootPassphrase)) {
      return c.json({ error: "passphrase does not match HYDRA_MASTER_PASSPHRASE set at launch; use that passphrase (or unset it and restart)" }, 409);
    }
    let present: SecretKey[];
    try {
      present = mergeSecrets(deps.stateDir, passphrase, updates);
    } catch (err) {
      if (err instanceof SecretsError) return failPassphrase();
      throw err;
    }
    lockout.succeed();
    const restart = body.restart === true;
    c.set("auditDetail", { present, restart, supervised, passphraseSet: bootPassphrase !== "" });
    if (restart) scheduleRestart();
    return c.json({ ok: true, present, passphraseSet: bootPassphrase !== "", restarting: restart, supervised });
  });

  // ---- static -----------------------------------------------------------------
  // Read per request (no-store anyway) so the CSP hash always matches the bytes served.
  const page = (path: string, name: string) => (c: Context<Vars>) => {
    const html = readFileSync(path, "utf8");
    return c.body(html, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": cspFor(scriptHash(html, name)) });
  };
  const demoPage = page(demoPath, "hydra-demo.html");
  const indexPage = page(indexPath, "index.html");
  app.get("/", demoPage);
  app.get("/demo", demoPage);
  app.get("/leaderboard", demoPage);
  app.get("/engines", demoPage);
  app.get("/trades", demoPage);
  app.get("/dream", demoPage);
  app.get("/classic", indexPage);
  app.get("/public/index.html", indexPage);

  // ---- reads ------------------------------------------------------------------
  app.get("/api/state", (c) => c.json(snapshot(c.get("auth").role)));

  app.get("/api/ledger/pnl", (c) => {
    const days = Math.min(365, Math.max(1, Number(c.req.query("days") ?? 1) || 1));
    const since = Date.now() - days * DAY_MS;
    const rows = reads().pnlByEngine(since);
    let realized = 0;
    let fees = 0;
    for (const r of rows) {
      realized += r.realized;
      fees += r.fees;
    }
    return c.json({ days, since, engines: rows, total: { realized, fees, net: realized - fees } });
  });

  app.get("/api/agents/runs", (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const agent = c.req.query("agent");
    if (agent !== undefined && !(AGENT_NAMES as readonly string[]).includes(agent)) return c.json({ error: `unknown agent ${agent}` }, 400);
    const runs = agentRuns(limit, agent);
    // Viewer must not learn which model powers each agent; operators see the real model.
    return c.json({ runs: c.get("auth").role === "operator" ? runs : runs.map((r) => ({ ...r, model: "hidden" })) });
  });

  app.get("/api/agents/ab", (c) => {
    if (c.get("auth").role !== "operator") return c.json({ error: "operator role required" }, 403);
    const days = Number(c.req.query("days") ?? 1);
    if (days !== 1 && days !== 7 && days !== 30) return c.json({ error: "days must be 1, 7 or 30" }, 400);
    const db = reads();
    const out = AGENT_NAMES.map((agent) => {
      const cfg = agents.agents[agent];
      const primary = deps.env.modelOverrides[agent] ?? cfg.model;
      const shadow = cfg.shadow_model ?? null;
      const metrics = db.abMetrics(agent, days);
      return { agent, primary, shadow, metrics };
    });
    return c.json({ days, agents: out });
  });

  app.get("/api/config/engines", (c) => c.json(engines));
  app.get("/api/config/agents", (c) => {
    if (c.get("auth").role !== "operator") return c.json({ error: "operator role required" }, 403);
    return c.json({ ...agents, overrides: deps.env.modelOverrides });
  });
  app.get("/api/config/budgets", (c) => {
    const r = refreshRisk();
    return c.json({ llm_daily_budget_usd: r.llm_daily_budget_usd, data_daily_budget_usd: r.data_daily_budget_usd });
  });

  let modelsCache: { at: number; ids: string[] } | null = null;
  app.get("/api/models", async (c) => {
    if (modelsCache !== null && Date.now() - modelsCache.at < MODELS_TTL_MS) return c.json({ cached: true, models: modelsCache.ids });
    try {
      const ids = await fetchModels();
      modelsCache = { at: Date.now(), ids };
      return c.json({ cached: false, models: ids });
    } catch (err) {
      return c.json({ error: `model catalogue unavailable: ${errText(err)}` }, 502);
    }
  });

  app.get("/api/dream/memory", (c) => {
    return c.json(loadDreamMemory());
  });

  let dreamRunning = false;
  app.post("/api/dream/run", async (c) => {
    const body = await jsonBody(c);
    if (!isPlainObject(body) || body.confirm !== "DREAM") return c.json({ error: "body must be { confirm: 'DREAM' }" }, 400);
    if (dreamRunning) return c.json({ error: "dream cycle already running" }, 409);
    dreamRunning = true;
    try {
      const result = executeDreamCycle();
      c.set("auditDetail", { bodyDigest: c.get("auditDetail")?.bodyDigest });
      return c.json({ ok: true, result });
    } finally {
      dreamRunning = false;
    }
  });

  app.get("/api/dream/status", (c) => {
    const mem = loadDreamMemory();
    const now = Date.now();
    const tomorrow = new Date(now);
    tomorrow.setUTCHours(24, 0, 0, 0);
    const msUntilNext = tomorrow.getTime() - now;
    return c.json({
      auto: true,
      schedule: "00:00 UTC (24H)",
      nextRunUtc: tomorrow.getTime(),
      msUntilNext,
      totalCycles: mem.totalCycles,
      lessonsCount: mem.lessons.length,
      lastUpdatedAt: mem.updatedAt,
    });
  });

  // ---- writes -----------------------------------------------------------------
  /** Parsed JSON body (undefined when absent/invalid); records its digest for the audit row. */
  const jsonBody = async (c: Context<Vars>): Promise<unknown> => {
    try {
      const text = await c.req.text();
      c.set("auditDetail", { ...(c.get("auditDetail") ?? {}), bodyDigest: digest(text) });
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const actorOf = (c: Context<Vars>): OperatorActor => `operator:${c.get("auth").session}`;

  app.put("/api/config/agents", async (c) => {
    const body = await jsonBody(c);
    const { patch, problems } = validateAgentsPatch(body);
    if (problems.length > 0) return c.json({ error: "invalid agents patch", problems }, 400);
    const actor = actorOf(c);
    const result = await writeAgents(deps.configDir, patch, actor, deps.ledger);
    c.set("auditDetail", { ...(c.get("auditDetail") ?? {}), agents: Object.keys(patch), changed: result.changed });
    log.info("agents.yaml updated", { actor, via: "dashboard", agents: Object.keys(patch), changed: result.changed });
    return c.json({ ok: true, ...result, agents: loadConfig(deps.configDir).agents.agents });
  });

  app.put("/api/config/budgets", async (c) => {
    const body = await jsonBody(c);
    if (!isPlainObject(body)) return c.json({ error: "body: expected { llm_daily_budget_usd?, data_daily_budget_usd? }" }, 400);
    const problems: string[] = [];
    const patch: BudgetPatch = {};
    for (const [key, value] of Object.entries(body)) {
      if (!(BUDGET_KEYS as readonly string[]).includes(key)) problems.push(`${key}: not an operator-writable key (allowed: ${BUDGET_KEYS.join(", ")})`);
      else if (typeof value !== "number" || !Number.isFinite(value) || value < 0) problems.push(`${key}: expected non-negative number`);
      else patch[key as (typeof BUDGET_KEYS)[number]] = value;
    }
    if (problems.length === 0 && Object.keys(patch).length === 0) problems.push("body: empty patch");
    if (problems.length > 0) return c.json({ error: "invalid budgets patch", problems }, 400);
    const actor = actorOf(c);
    const result = await writeBudgets(deps.configDir, patch, actor, deps.ledger);
    risk = loadConfig(deps.configDir).risk;
    riskReadAt = Date.now();
    c.set("auditDetail", { ...(c.get("auditDetail") ?? {}), patch, changed: result.changed });
    log.info("budgets updated", { actor, via: "dashboard", patch, changed: result.changed });
    return c.json({ ok: true, ...result, llm_daily_budget_usd: risk.llm_daily_budget_usd, data_daily_budget_usd: risk.data_daily_budget_usd });
  });

  app.post("/api/config/agents/:agent/promote-shadow", async (c) => {
    const agent = c.req.param("agent");
    if (!(AGENT_NAMES as readonly string[]).includes(agent)) return c.json({ error: `unknown agent ${agent}` }, 400);
    const current = loadConfig(deps.configDir).agents.agents[agent as AgentName];
    const shadow = current.shadow_model;
    if (shadow === undefined) return c.json({ error: `${agent} has no shadow_model to promote` }, 400);
    // agents.yaml patches cannot delete keys, so the old primary becomes the new shadow (A/B keeps a challenger).
    const actor = actorOf(c);
    const result = await writeAgents(deps.configDir, { [agent]: { model: shadow, shadow_model: current.model } }, actor, deps.ledger);
    c.set("auditDetail", { agent, model: shadow, shadow_model: current.model, changed: result.changed });
    log.info("shadow promoted", { actor, via: "dashboard", agent, model: shadow, shadow_model: current.model });
    return c.json({ ok: true, ...result, agent, model: shadow, shadow_model: current.model });
  });

  app.post("/api/kill", async (c) => {
    const body = await jsonBody(c);
    if (!isPlainObject(body) || body.confirm !== "KILL") return c.json({ error: "body must be { confirm: 'KILL', reason? }" }, 400);
    const stack = deps.hot.executor.stack;
    if (stack === null) return c.json({ error: "executor not started; kill unavailable" }, 503);
    const reason = typeof body.reason === "string" && body.reason.trim() !== "" ? body.reason.trim() : "dashboard";
    const auth = c.get("auth");
    log.warn("kill requested via dashboard", { reason, session: auth.session, role: auth.role, ua: auth.ua });
    const result = await stack.kill(`dashboard: ${reason}`);
    const lock = readKillLock(deps.stateDir);
    c.set("auditDetail", { ...(c.get("auditDetail") ?? {}), reason, result, lock });
    return c.json({ ok: true, result, lock });
  });

  // ---- websocket --------------------------------------------------------------
  interface WsData {
    role: Role;
  }
  const clients = new Set<ServerWebSocket<WsData>>();
  let timer: Timer | null = null;
  const broadcast = (): void => {
    // One frame per role, built lazily so a viewer-only or operator-only audience costs one stringify.
    let operatorFrame: string | null = null;
    let viewerFrame: string | null = null;
    for (const ws of clients) {
      if (ws.getBufferedAmount() > WS_MAX_BUFFERED) continue;
      try {
        if (ws.data.role === "operator") {
          operatorFrame ??= JSON.stringify({ type: "snapshot", ...snapshot("operator") });
          ws.send(operatorFrame);
        } else {
          viewerFrame ??= JSON.stringify({ type: "snapshot", ...snapshot("viewer") });
          ws.send(viewerFrame);
        }
      } catch (err) {
        log.error("snapshot failed", { error: errText(err) });
        return;
      }
    }
  };
  const startTimer = (): void => {
    if (timer !== null) return;
    timer = setInterval(broadcast, SNAPSHOT_MS);
    timer.unref?.();
  };
  const stopTimer = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const start = (): { port: number } => {
    if (server !== null) return { port: server.port ?? 0 };
    for (const name of TAPE_EVENTS) busOffs.push(bus.on(name, record(name) as (payload: HydraEvents[typeof name]) => void));
    unwatch.push(
      watchEngines(deps.configDir, (cfg) => {
        engines = cfg;
      }),
      watchAgents(deps.configDir, (cfg) => {
        agents = cfg;
      }),
    );
    server = Bun.serve<WsData>({
      hostname,
      port: deps.port ?? deps.env.dashboardPort,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          const denied = locked();
          if (denied !== null) return denied;
          if (!originAllowed(req.headers.get("origin") ?? undefined, allowedPorts)) return Response.json({ error: "forbidden origin" }, { status: 403 });
          const ticket = url.searchParams.get("ticket");
          const session = ticket === null ? null : sessions.consumeTicket(ticket);
          if (session === null) return failed(req.headers.get("user-agent") ?? "", "ticket");
          if (clients.size >= WS_MAX_CLIENTS) return Response.json({ error: `at most ${WS_MAX_CLIENTS} live clients` }, { status: 503 });
          if (srv.upgrade(req, { data: { role: session.role } })) return undefined;
          return new Response("websocket upgrade failed", { status: 426 });
        }
        return app.fetch(req);
      },
      websocket: {
        open(ws) {
          clients.add(ws);
          startTimer();
          broadcast();
        },
        close(ws) {
          clients.delete(ws);
          if (clients.size === 0) stopTimer();
        },
        message() {},
      },
    });
    const port = server.port ?? 0;
    // Narrow origin check to the actual bound port (may differ from deps.port when 0 was requested).
    allowedPorts = new Set([port]);
    log.info("dashboard listening", { hostname, port, url: `http://${hostname}:${port}/` });
    return { port };
  };

  const stop = (): void => {
    stopTimer();
    for (const ws of clients) ws.close();
    clients.clear();
    for (const off of busOffs) off();
    busOffs.length = 0;
    for (const off of unwatch) off();
    unwatch.length = 0;
    server?.stop(true);
    server = null;
    ledger?.close();
    ledger = null;
  };

  return {
    app,
    start,
    stop,
    module: {
      name: "dashboard",
      order: "agents",
      start: () => {
        start();
      },
      stop,
    },
  };
}
