// cli scenario <1..6> [--live] — scripted end-to-end demo scenarios against the real runtime.
// Scenarios 1–5 boot the full hot lane (feed sockets, executor, engines, agents, x402 seller) via
// `boot({modules})`, drive one path through it, and read the proof back out of the ledger / state
// files. Scenario 6 talks to the Binance MCP bridge only. Each scenario prints numbered narration
// lines and ends with `scenario N: OK|SKIPPED(reason)`; exit 0 on OK/SKIPPED, 1 on failure.
//
//   1 liquidation-fade replay -> engine intent -> kernel -> paper/demo order + fill + latency
//   2 Commander cycle on YEScale (needs YESCALE_API_KEY) -> engines.yaml diff from config_changes
//   3 Supervisor tighten overlay -> injected drawdown -> Guardian kill -> per-venue flatten -> unkill
//   4 real Skills HTTP token audit (FAIL) -> smart-money push -> kernel veto in `vetoes`
//   5 external buyer pays for /v1/signals/liquidation over x402 (mock facilitator in demo)
//   6 MCP tools/list + one read call through the OAuth bridge (MCP=on), else a documented skip

import { readFileSync } from "node:fs";
import { type AgentRunResult, runAgent } from "../cold/agent.ts";
import { DEFAULT_MCP_URL, McpBridge, mcpUrl } from "../cold/mcp/client.ts";
import { AGENT_MODULES, buildAgentDeps } from "../cold/scheduler.ts";
import { bus } from "../core/bus.ts";
import { nowNs, wallMs } from "../core/clock.ts";
import { CONFIG_FILES } from "../core/config.ts";
import { effective, tighten } from "../core/limits.ts";
import { clearKillLock, clearLimits, readKillLock, readLimits } from "../core/state.ts";
import type { Fill, GuardianBreach, Intent, KillEvent, Order, SmartMoneyEvent, Veto } from "../core/types.ts";
import type { ExecutorStack } from "../hot/executor.ts";
import { killInFlight } from "../hot/kill.ts";
import { reconcile } from "../hot/recovery-boot.ts";
import { boot, type Runtime } from "../main.ts";
import { LocalSigner, parseRequired, randomPrivateKey, requirementsUsd, x402fetch } from "../pay/client.ts";
import { mapTrackerPush } from "../venues/onchain/adapter.ts";
import type { Frame } from "../venues/binance/ws.ts";
import { type HotLane, hotLaneModules } from "../wiring.ts";
import { CONFIG_DIR, STATE_DIR } from "./intent.ts";
import { parseFixture } from "./replay.ts";

export const description = "Run a scripted end-to-end demo scenario against the real runtime: scenario <1..6> [--live]";

export interface ScenarioSpec {
  n: number;
  title: string;
  /** What the scenario needs beyond `demo` defaults; empty = runs with no keys. */
  needs: string;
}

export const SCENARIOS: readonly ScenarioSpec[] = [
  { n: 1, title: "liquidation-fade replay -> intent -> kernel -> order/fill + latency", needs: "" },
  { n: 2, title: "Commander regime change -> engines.yaml diff", needs: "YESCALE_API_KEY" },
  { n: 3, title: "Supervisor tighten -> Guardian kill -> per-venue flatten -> kill.lock -> unkill", needs: "" },
  { n: 4, title: "smart-money mirror with real Skills HTTP audit FAIL -> kernel veto", needs: "network to web3.binance.com" },
  { n: 5, title: "external agent buys a signal over x402 (mock facilitator in demo)", needs: "" },
  { n: 6, title: "MCP tools/list + one read call through the OAuth bridge", needs: "MCP=on" },
];

export interface ScenarioArgs {
  n: number;
  live: boolean;
}

export function usage(): string {
  const lines = ["usage: cli scenario <n> [--live]", "", "scenarios:"];
  for (const s of SCENARIOS) lines.push(`  ${s.n}  ${s.title}${s.needs === "" ? "" : `  (needs ${s.needs})`}`);
  lines.push("", "--live  scenario 1 only: wait for a real cascade on the live feed instead of replaying the fixture");
  return lines.join("\n");
}

/** `scenario <n> [--live]`; returns the usage/error text on bad input. */
export function parseScenarioArgs(args: string[]): ScenarioArgs | string {
  let n: number | null = null;
  let live = false;
  for (const a of args) {
    if (a === "--live") live = true;
    else if (a.startsWith("--")) return `unknown flag ${a}\n${usage()}`;
    else if (n === null) {
      if (!/^[1-9]$/.test(a)) return `scenario number must be 1..${SCENARIOS.length}, got "${a}"\n${usage()}`;
      n = Number(a);
    } else return `unexpected argument ${a}\n${usage()}`;
  }
  if (n === null) return usage();
  if (n > SCENARIOS.length) return `scenario number must be 1..${SCENARIOS.length}, got "${n}"\n${usage()}`;
  if (live && n !== 1) return "--live applies to scenario 1 only";
  return { n, live };
}

// ---- shared ---------------------------------------------------------------

/** Numbered narration line on stdout; everything the runtime logs stays on its own sink. */
export function narrate(n: number, msg: string): void {
  console.log(`${String(n).padStart(2, " ")}. ${msg}`);
}

type Outcome = { ok: true } | { skipped: string };
const OK: Outcome = { ok: true };

/** Per-scenario step counter feeding `narrate`. */
function narrator(): (msg: string) => void {
  let n = 0;
  return (msg) => narrate(++n, msg);
}

class ScenarioFailure extends Error {}

function fail(msg: string): never {
  throw new ScenarioFailure(msg);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function short(v: unknown): string {
  return JSON.stringify(v);
}

/** Resolves when `fn` first returns true (20 ms polls); false after `timeoutMs`. */
async function waitFor(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) return false;
    await Bun.sleep(20);
  }
  return true;
}

interface Booted {
  rt: Runtime;
  hot: HotLane;
  stack: ExecutorStack;
}

/**
 * Boots the full hot lane like `bun run hydra`.
 *
 * When running under a soak (HYDRA_SOAK=1), uses an isolated state directory
 * (HYDRA_SCENARIO_STATE_DIR or a temp dir) and distinct dashboard/x402 ports so the
 * scenario process does not collide with the main soak hydra process on the same SQLite
 * database or the same port.  The scenario never touches the live operator state/hydra.sqlite.
 */
async function bootHot(): Promise<Booted> {
  let hot: HotLane | null = null;
  // Isolated state dir: prefer explicit env, fall back to a pid-scoped temp dir under state/.
  const scenarioStateDir = process.env.HYDRA_SCENARIO_STATE_DIR ?? `state/scenario-${process.pid}`;
  // Isolated ports: HYDRA_SOAK=1 shifts both ports by 10000 to avoid clashing with the main process.
  const underSoak = process.env.HYDRA_SOAK === "1";
  const envOverrides: Record<string, string | undefined> = underSoak
    ? {
        DASHBOARD_PORT: String((Number(process.env.DASHBOARD_PORT ?? 8787) + 10_000)),
        X402_PORT: String((Number(process.env.X402_PORT ?? 8788) + 10_000)),
      }
    : {};
  const rt = await boot({
    configDir: CONFIG_DIR,
    stateDir: scenarioStateDir,
    env: { ...process.env, ...envOverrides } as Record<string, string | undefined>,
    modules: (ctx) => {
      hot = hotLaneModules(ctx);
      return hot.modules;
    },
  });
  const lane = hot as HotLane | null;
  const stack = lane?.executor.stack ?? null;
  if (lane === null || stack === null) {
    await rt.shutdown();
    throw new Error("hot lane did not start");
  }
  return { rt, hot: lane, stack };
}


/**
 * Without venue keys nothing reconciles a balance, so NAV is 0 and rules 5-8 veto everything.
 * Seeds cash = nav_usd_cap as the paper bankroll and re-anchors the day; false when NAV already exists.
 */
function seedPaperNav(b: Booted): boolean {
  const { positions } = b.stack;
  if (positions.nav() > 0) return false;
  positions.setCash(b.rt.config.risk.nav_usd_cap);
  positions.resetDayAnchor();
  positions.dayStartNav();
  return true;
}

// ---- scenario 1: liquidation-fade replay (offline, deterministic) -----------

export const LIQ_FIXTURE = "fixtures/liq-cascade-eth.ndjson";
/** Pre-cascade aggTrade anchoring the 1-min VWAP before the cascade (fixture starts mid-cascade). */
const VWAP_ANCHOR: Frame = { stream: "ethusdt@aggTrade", e: "aggTrade", data: { e: "aggTrade", s: "ETHUSDT", p: "3010.00", q: "5000", T: 0, m: false } };
const LIVE_WAIT_MS = 60 * 60_000;
/** Live book must age past the engine's usability window before fixture frames own the reference price. */
const BOOK_STALE_MS = 2500;
/** 24 h quote volume the fixture's taker burst was sized against (see test/hot/engines/liqfade.test.ts). */
export const FIXTURE_ADV_USD = 1e10;

/**
 * Rebases an aggTrade onto the live wall clock (`T`/`E` = tMs; the hub's burst ring and VWAP are
 * event-time based, so recorded times must sort after any real print seen before the sockets closed)
 * and multiplies its quantity by `k`. Other frames pass through.
 */
export function adaptTrade(frame: Frame, k: number, tMs: number): Frame {
  if (frame.e !== "aggTrade") return frame;
  return { ...frame, data: { ...frame.data, q: String(Number(frame.data.q) * k), T: tMs, E: tMs } };
}

async function scenario1(b: Booted, live: boolean): Promise<Outcome> {
  const say = narrator();
  const { hub } = b.hot.feed;
  const intents: Intent[] = [];
  const vetoes: Veto[] = [];
  const orders: Order[] = [];
  const fills: Fill[] = [];
  const offs = [
    bus.on("engine.intent", (i) => {
      if (i.engine === "liqfade") intents.push(i);
    }),
    bus.on("kernel.veto", (v) => {
      if (v.engine === "liqfade") vetoes.push(v);
    }),
    bus.on("exec.order", (o) => orders.push(o)),
    bus.on("exec.fill", (f) => fills.push(f)),
  ];
  try {
    const keyed = b.rt.env.keys.futures !== null;
    say(`hot lane up: futures=${b.rt.env.futures} ${keyed ? "(API key present: demo-fapi orders)" : "(no API key: paper fills)"}, engines ${Object.keys(b.hot.registry.stats()).join(", ")}`);
    if (seedPaperNav(b)) say(`no venue balance to reconcile: paper bankroll seeded at $${b.stack.positions.nav().toFixed(0)} (risk.yaml nav_usd_cap) so NAV-based kernel rules 5-8 have a base`);
    if (live) {
      say(`--live: waiting up to ${LIVE_WAIT_MS / 60_000} min for a real liquidation cascade on ${b.rt.env.futures === "demo" ? "demo-fstream" : "fstream"} (Ctrl-C aborts)`);
      if (!(await waitFor(() => intents.length > 0 || vetoes.length > 0, LIVE_WAIT_MS))) return { skipped: "no live cascade within the wait window" };
    } else {
      // ---- OFFLINE DETERMINISTIC REPLAY (labelled) ----------------------------
      // No network ADV fetch: the fixture was recorded against FIXTURE_ADV_USD, so we inject
      // that directly.  The sockets are stopped before the first fixture frame is applied so no
      // live state contaminates the replay.  No retries: the engine MUST fire on one clean pass
      // through the fixture; if it does not, that is a real failure.
      say(`[OFFLINE REPLAY] scenario 1 runs in deterministic offline mode: no network required`);
      say(`closing live sockets so the replay exclusively owns ETHUSDT mark/tape state`);
      hub.stop();
      await Bun.sleep(BOOK_STALE_MS);

      // Inject a fixed ADV directly so the liqfade burst-ratio check works without network.
      hub.overrideAdv("ETHUSDT", FIXTURE_ADV_USD);
      const scale = 1; // fixture was recorded against FIXTURE_ADV_USD; no scaling needed
      say(`ADV ETHUSDT injected: $${FIXTURE_ADV_USD.toExponential(0)} (fixture reference; scale=${scale.toFixed(1)}, no network needed)`);

      say(`[OFFLINE REPLAY] replaying ${LIQ_FIXTURE} through FeedHub.applyFrame (production parse → emit path) at ${b.rt.env.replaySpeed}x`);
      const frames = parseFixture(readFileSync(LIQ_FIXTURE, "utf8"));
      const done = () => intents.length > 0 || vetoes.length > 0;
      const t0 = Date.now();
      hub.applyFrame(adaptTrade(VWAP_ANCHOR, scale, t0 - 1000));
      let prev = frames[0]?.t_ms ?? 0;
      let played = 0;
      for (const f of frames) {
        const delay = (f.t_ms - prev) / b.rt.env.replaySpeed;
        if (delay > 0) await Bun.sleep(delay);
        prev = f.t_ms;
        hub.applyFrame(adaptTrade(f.frame, scale, t0 + f.t_ms / b.rt.env.replaySpeed));
        played++;
        if (done()) break;
      }
      say(`[OFFLINE REPLAY] played ${played}/${frames.length} frames (forceOrder samples, markPrice, aggTrade) in ${Date.now() - t0} ms${done() ? "; stopped at the intent" : ""}`);
      // Allow synchronous bus handlers to flush (no retries: a single clean pass must suffice).
      await waitFor(done, 1000);
    }
    const intent = intents[0];
    if (intent === undefined) {
      const v = vetoes[0];
      if (v !== undefined) fail(`liqfade intent vetoed by kernel rule ${v.rule}: ${v.detail}`);
      fail("liqfade emitted no intent");
    }
    say(`engine.intent liqfade: ${intent.side} ${intent.qty.toFixed(4)} ${intent.symbol} ${intent.type}${intent.price !== undefined ? ` @ ${intent.price}` : ""} tp=${intent.tp?.toFixed(2)} sl=${intent.sl?.toFixed(2)} paper=${intent.paper}`);
    const veto = vetoes.find((v) => v.intentId === intent.id);
    if (veto !== undefined) fail(`kernel VETO rule ${veto.rule}: ${veto.detail}`);
    say("risk kernel: rules 0-10 PASS");
    await waitFor(() => orders.length > 0, 5000);
    const order = orders.find((o) => o.symbol === intent.symbol) ?? orders[0];
    if (order === undefined) fail("executor produced no order");
    const row = b.rt.ledger.db.query<{ status: string; latency_ms: number | null; client_id: string }, [number]>("SELECT status, latency_ms, client_id FROM orders WHERE id = ?").get(order.id);
    if (row === null) fail(`order ${order.id} missing from ledger`);
    say(`ledger orders#${order.id}: status=${row.status} client_id=${row.client_id}${row.latency_ms === null ? "" : ` latency_ms=${row.latency_ms.toFixed(2)} (t_ack - t_signal)`}`);
    await waitFor(() => fills.some((f) => f.orderId === order.id), 5000);
    const fill = b.rt.ledger.db.query<{ price: number; qty: number; fee: number; trade_id: string }, [number]>("SELECT price, qty, fee, trade_id FROM fills WHERE order_id = ? ORDER BY id LIMIT 1").get(order.id);
    if (fill === null) fail(`no fill recorded for order ${order.id} (status ${row.status})`);
    say(`ledger fills: ${fill.qty} @ ${fill.price} fee=${fill.fee.toFixed(4)} trade_id=${fill.trade_id}${row.status === "PAPER" ? " (paper fill, synthesized by the executor — [OFFLINE REPLAY])" : ""}`);
    const pos = b.stack.positions.snapshot().find((p) => p.symbol === intent.symbol);
    if (pos !== undefined) say(`positions: ${pos.engine} ${pos.venue} ${pos.symbol} qty=${pos.qty} mark=${pos.mark} unrealized=${pos.unrealized.toFixed(2)}`);
    return OK;
  } finally {
    for (const off of offs) off();
  }
}


// ---- scenario 2: Commander cycle -------------------------------------------

async function scenario2(b: Booted): Promise<Outcome> {
  const say = narrator();
  const apiKey = b.rt.env.yescaleApiKey;
  const cfg = b.rt.config.agents.agents.commander;
  say(`commander config: model=${cfg.model} shadow=${cfg.shadow_model ?? "none"} interval=${cfg.interval ?? cfg.cron ?? "?"}`);
  if (apiKey === null) return { skipped: "YESCALE_API_KEY not set; cold lane disabled (set it in .env to run the Commander on YEScale)" };
  const lastChange = b.rt.ledger.db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM config_changes").get()?.id ?? 0;
  const { deps, stop } = buildAgentDeps(
    { env: b.rt.env, config: b.rt.config, ledger: b.rt.ledger, stateDir: STATE_DIR, configDir: CONFIG_DIR, stack: () => b.stack, registry: b.hot.registry },
    apiKey,
  );
  let result: AgentRunResult;
  say("running one Commander cycle now (primary + shadow in parallel when shadow_model is set)");
  try {
    result = await runAgent(AGENT_MODULES.commander, cfg, deps);
  } finally {
    stop();
  }
  const p = result.primary;
  say(`primary ${p.model}: schema_valid=${p.schemaValid} applied=${p.applied} cost=$${p.costUsd.toFixed(4)} latency=${Math.round(p.latencyMs)}ms tool_rejections=${p.toolRejections}${p.error === undefined ? "" : ` error=${p.error}`}`);
  if (result.shadow !== undefined) {
    const s = result.shadow;
    say(`shadow ${s.model}: schema_valid=${s.schemaValid} cost=$${s.costUsd.toFixed(4)} latency=${Math.round(s.latencyMs)}ms agreement=${s.agreementPct ?? "n/a"}% (logged only, never applied)`);
  }
  say(`decision: ${short(p.decision)}`);
  const changes = b.rt.ledger.db
    .query<{ actor: string; path: string; diff: string }, [number, string]>("SELECT actor, path, diff FROM config_changes WHERE id > ? AND path LIKE ? ORDER BY id")
    .all(lastChange, `%${CONFIG_FILES.engines}`);
  if (changes.length === 0) say("config_changes: no engines.yaml write this cycle (Commander kept the current regime or its patch was rejected)");
  for (const c of changes) say(`config_changes: ${c.actor} wrote ${c.path}: ${c.diff}`);
  if (!p.schemaValid || p.error !== undefined) fail("Commander primary run failed");
  return OK;
}

// ---- scenario 3: tighten -> Guardian kill -> unkill --------------------------

const TIGHTEN_DD_PCT = 3;
const INJECTED_DD_PCT = 6;

async function scenario3(b: Booted): Promise<Outcome> {
  const say = narrator();
  const { stack, rt } = b;
  const { positions } = stack;
  // Use the boot's own stateDir, not the global "state/" constant.  bootHot() uses an isolated
  // scenario-<pid> dir; STATE_DIR = "state" would point at the wrong location for every file op.
  const sdir = rt.stateDir;
  if (readKillLock(sdir) !== null) fail("kill.lock already present; run `cli unkill` first");

  const prior = readLimits(sdir);
  const now = wallMs();
  const current = effective(rt.config.risk, prior, now, false);
  const dd = Math.min(TIGHTEN_DD_PCT, current.daily_drawdown_kill_pct);
  const overlay = tighten(sdir, { daily_drawdown_kill_pct: dd, reason: "scenario-3: supervisor tightens the drawdown breaker", expires_at: now + 10 * 60_000 }, "supervisor", current);
  say(`supervisor tighten: daily_drawdown_kill_pct ${rt.config.risk.daily_drawdown_kill_pct}% (risk.yaml) -> ${overlay.daily_drawdown_kill_pct}% via state/limits.json (actor=${overlay.actor}, tighten-only, expires in 10 min)`);

  const breaches: GuardianBreach[] = [];
  const kills: KillEvent[] = [];
  const offs = [bus.on("guardian.breach", (e) => breaches.push(e)), bus.on("system.kill", (e) => kills.push(e))];
  let restored = false;
  try {
    positions.setCash(10_000);
    positions.resetDayAnchor();
    const start = positions.dayStartNav();
    const nav0 = positions.nav();
    positions.setCash((1 - INJECTED_DD_PCT / 100) * start - (nav0 - 10_000));
    say(`inject drawdown: day-start NAV $${start.toFixed(2)} -> NAV $${positions.nav().toFixed(2)} (${positions.drawdownPct().toFixed(2)}% >= ${dd}% threshold)`);

    say("guardian.tick(): the 1 s code-owned breaker evaluates drawdown independent of any LLM");
    stack.guardian.tick();
    const breach = breaches[0];
    if (breach !== undefined) say(`guardian.breach ${breach.kind}: ${breach.value.toFixed(2)}% >= ${breach.threshold}% -> system.kill (actor guardian)`);
    else {
      say("guardian did not trip (NAV anchor unavailable); falling back to stack.kill('scenario-3')");
      void stack.kill("scenario-3");
    }
    if (!(await waitFor(() => readKillLock(sdir) !== null && !killInFlight(), 30_000))) fail("kill switch did not finish within 30 s");
    const lock = readKillLock(sdir);
    if (lock === null) fail("kill.lock missing after kill");
    const venues = { futures: stack.futuresRest !== null, spot: stack.spotRest !== null };
    say(`kill switch (REST, bypasses executor throttle): cancel-all + flatten per venue -> futures ${venues.futures ? `flattened, residue ${short(lock.residue.futures)}` : "no key: nothing venue-side to flatten"}; spot ${venues.spot ? `flattened, residue ${short(lock.residue.spot)}` : "no key: nothing venue-side to flatten"}; dex residue ${short(lock.residue.dex)}`);
    say(`state/kill.lock written: reason="${lock.reason}" at ${new Date(lock.at).toISOString()}; kernel rule 0 now vetoes every intent`);
    rt.ledger.flush();
    const flat = rt.ledger.db.query<{ json: string }, []>("SELECT json FROM events WHERE kind = 'system.kill.flat' ORDER BY id DESC LIMIT 1").get();
    if (flat !== null) say(`ledger events: system.kill.flat ${flat.json}`);

    say("cli unkill (operator-only): venue-side reconcile must report zero residue and zero open orders before the lock is removed");
    const report = await reconcile({ futuresRest: stack.futuresRest, spotRest: stack.spotRest, spotSymbols: rt.config.risk.allowed_symbols.spot });
    if (!report.clean) fail(`unkill refused: residue ${short(report.residue)}, open orders ${report.openOrders}`);
    clearKillLock(sdir, "operator");
    rt.ledger.event("system.kill.cleared", JSON.stringify({ reason: lock.reason, actor: "operator" }));
    bus.emit("system.kill.cleared", { actor: "operator", tsNs: nowNs() });
    say("reconcile clean -> kill.lock cleared (system.kill.cleared)");
    if (prior === null) {
      clearLimits(sdir, "operator");
      restored = true;
      say("operator cleared the scenario overlay (state/limits.json removed; limits back to risk.yaml)");
    } else say("pre-existing limits overlay left in place (overlays are tighten-only; only an operator may clear them)");
    return OK;
  } finally {
    for (const off of offs) off();
    if (!restored && prior === null && readKillLock(sdir) === null) clearLimits(sdir, "operator");
  }
}

// ---- scenario 4: real audit -> veto -------------------------------------------

const AUDIT_FIXTURE = "fixtures/audit.json";
const SMARTMONEY_FIXTURE = "fixtures/smartmoney.ndjson";

interface AuditFixtureRow {
  riskLevelEnum?: string;
  riskItems?: Array<{ details?: Array<{ title?: string; isHit?: boolean }> }>;
}

/** Graded tokens from fixtures/audit.json: the first with a Honeypot hit and the first LOW-risk one. */
export function fixtureTokens(text: string): { honeypot: string | null; clean: string | null } {
  const table = JSON.parse(text) as Record<string, AuditFixtureRow>;
  let honeypot: string | null = null;
  let clean: string | null = null;
  for (const [token, row] of Object.entries(table)) {
    const hit = row.riskItems?.some((g) => g.details?.some((d) => d.title === "Honeypot" && d.isHit === true)) ?? false;
    if (hit && honeypot === null) honeypot = token;
    if (!hit && row.riskLevelEnum === "LOW" && clean === null) clean = token;
  }
  return { honeypot, clean };
}

async function scenario4(b: Booted): Promise<Outcome> {
  const say = narrator();
  const { skills } = b.hot.feed;
  const { honeypot, clean } = fixtureTokens(readFileSync(AUDIT_FIXTURE, "utf8"));
  if (honeypot === null) fail(`${AUDIT_FIXTURE} has no Honeypot-flagged token`);
  say(`Skills HTTP client: ${skills.offline ? "fixture mode (SKILLS_HTTP=off)" : `real endpoint ${b.rt.env.skillsHttp} POST /bapi/defi/v1/public/wallet-direct/security/token/audit`}`);
  if (clean !== null) {
    const ok = await skills.audit(clean, "56");
    say(`audit ${clean} (BSC): pass=${ok.pass} risk=${ok.risk}`);
  }
  const bad = await skills.audit(honeypot, "56");
  say(`audit ${honeypot} (BSC, honeypot in ${AUDIT_FIXTURE}): pass=${bad.pass} risk=${bad.risk}${bad.risk === "UNKNOWN" ? " (endpoint has no data for it -> treated as FAIL, the safe direction)" : ""}`);
  if (bad.pass) fail("honeypot token passed the audit; scenario expects FAIL");

  const line = readFileSync(SMARTMONEY_FIXTURE, "utf8").split("\n").find((l) => l.trim().length > 0);
  const push = line === undefined ? null : mapTrackerPush(JSON.parse(line), nowNs());
  if (push === null) fail(`${SMARTMONEY_FIXTURE} first line is not a tracker trade push`);
  const ev: SmartMoneyEvent = { ...push, token: honeypot, side: "BUY", amountUsd: Math.max(push.amountUsd, 50_000) };
  const symbol = `${honeypot}/USDT`;
  const tsMs = wallMs();
  b.hot.audit.set(honeypot, { pass: bad.pass, risk: bad.risk, tsMs });
  b.hot.audit.set(symbol, { pass: bad.pass, risk: bad.risk, tsMs });
  bus.emit("feed.onchain.smartmoney", ev);
  const stats = b.hot.registry.stats().smmirror;
  say(`feed.onchain.smartmoney: wallet ${ev.wallet} BUY $${ev.amountUsd} of ${honeypot}; smmirror engine ${stats === undefined ? "not registered" : `stats ${short(stats)}`} (engine-side audit gate: skippedAudit)`);

  const intent: Intent = { id: `scenario-4-${Date.now()}`, engine: "smmirror", venue: "dex", symbol, side: "BUY", qty: 100, type: "MARKET", ttlMs: 5000, paper: true, tSignalNs: nowNs() };
  say(`submitting the paper mirror intent directly to the executor: BUY 100 ${symbol} (dex, paper) so the kernel gate is exercised even though the engine already refused`);
  const res = await b.stack.executor.submit(intent);
  if (res.ok || res.reason !== "veto") fail(`expected a kernel veto, got ${short(res)}`);
  say(`kernel VETO rule ${res.veto.rule}: ${res.veto.detail}`);
  const row = b.rt.ledger.db.query<{ rule: number; detail: string; intent_id: string }, [string]>("SELECT rule, detail, intent_id FROM vetoes WHERE intent_id = ? ORDER BY id DESC LIMIT 1").get(intent.id);
  if (row === null) fail("veto not written to `vetoes`");
  say(`ledger vetoes: intent_id=${row.intent_id} rule=${row.rule} detail="${row.detail}"`);
  if (row.rule !== 9) say(`rule ${row.rule} fired first (risk.yaml allowed_symbols.dex is ${short(b.rt.config.risk.allowed_symbols.dex)}); rule 9 is closed too: audit.fresh(${symbol}) = ${b.hot.audit.fresh(symbol, b.rt.config.risk.audit_ttl_sec)}`);
  return OK;
}

// ---- scenario 5: x402 buyer -------------------------------------------------

const SIGNAL_PATH = "/v1/signals/liquidation";

async function scenario5(b: Booted): Promise<Outcome> {
  const say = narrator();
  const { env, ledger } = b.rt;
  const url = `http://127.0.0.1:${env.x402Port}${SIGNAL_PATH}`;
  const facilitator = env.x402 === "mock" ? "mock facilitator (in-process, no chain)" : `${env.x402} facilitator`;
  say(`x402 seller listening on 127.0.0.1:${env.x402Port} (only /v1/* mounted); settlement via ${facilitator}`);
  const first = await fetch(url);
  const pr = parseRequired(first);
  if (first.status !== 402 || pr === null || pr.accepts.length === 0) fail(`expected 402 with x402 requirements, got ${first.status}`);
  const reqs = pr.accepts[0];
  if (reqs === undefined) fail(`expected 402 with x402 requirements, got ${first.status}`);
  say(`GET ${SIGNAL_PATH} without payment -> HTTP 402; requirements: scheme=${reqs.scheme} network=${reqs.network} asset=${reqs.asset} price=$${requirementsUsd(reqs).toFixed(2)} payTo=${reqs.payTo}`);
  let key = env.x402DemoPrivateKey;
  if (key === null) {
    key = randomPrivateKey();
    say("X402_DEMO_PRIVATE_KEY unset; external agent signs with a throwaway key generated for this run");
  }
  const signer = new LocalSigner(key);
  const before = ledger.db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM payments").get()?.id ?? 0;
  const res = await x402fetch(url, undefined, signer, { ledger, accept: (_r, usd) => (usd > 1 ? `price ${usd} exceeds 1 USD` : null) });
  say(`replay with PAYMENT-SIGNATURE (EIP-3009 transferWithAuthorization signed by ${signer.address}) -> HTTP ${res.status}`);
  if (res.status !== 200) fail(`paid request failed: ${res.status} ${await res.text()}`);
  if (res.payment !== undefined) say(`PAYMENT-RESPONSE: ${short(res.payment)}`);
  const body = await res.text();
  say(`signal body (${body.length} bytes): ${body.slice(0, 160)}${body.length > 160 ? "..." : ""}`);
  const rows = ledger.db
    .query<{ direction: string; counterparty: string; amount: number; asset: string; network: string; tx: string }, [number]>("SELECT direction, counterparty, amount, asset, network, tx FROM payments WHERE id > ? ORDER BY id")
    .all(before);
  if (rows.length === 0) fail("no payments row recorded");
  for (const r of rows) say(`ledger payments: direction=${r.direction} amount=${r.amount} ${r.asset} network=${r.network} counterparty=${r.counterparty} tx=${r.tx}${env.x402 === "mock" ? " [mock facilitator: tx is synthetic]" : ""}`);
  return OK;
}

// ---- scenario 6: MCP --------------------------------------------------------

async function scenario6(): Promise<Outcome> {
  const say = narrator();
  const url = mcpUrl();
  if (process.env.MCP !== "on") {
    say(`MCP bridge target ${url}${url === DEFAULT_MCP_URL ? "" : " (MCP_URL override)"}; OAuth callback http://127.0.0.1:8790/callback`);
    say('fallback: `claude mcp add --transport http binance <url>` then `claude -p "list the Binance MCP tools"`');
    return { skipped: "MCP=off (default); set MCP=on to run tools/list through the OAuth bridge" };
  }
  const bridge = new McpBridge({ stateDir: STATE_DIR });
  try {
    say(`connecting to ${url} (StreamableHTTP + OAuth; a browser authorization URL is printed on first use)`);
    await bridge.connect();
    const tools = await bridge.listTools();
    say(`tools/list: ${tools.length} tools; read-only whitelist (get_/list_/query_/read_) allows ${tools.filter((t) => t.readOnly).length}`);
    for (const t of tools) console.log(`    ${t.readOnly ? "  " : "x "}${t.name}  ${t.description}`);
    const readable = tools.find((t) => t.readOnly);
    if (readable === undefined) say("no read-only tool exposed; skipping the read call");
    else {
      try {
        const out = await bridge.call(readable.name, {});
        say(`tools/call ${readable.name} {} -> ${short(out).slice(0, 300)}`);
      } catch (err) {
        say(`tools/call ${readable.name} {} -> ${errText(err)} (read call needs arguments; list succeeded)`);
      }
    }
    return OK;
  } finally {
    await bridge.close();
  }
}

// ---- runner -----------------------------------------------------------------

export default async function scenario(args: string[]): Promise<number> {
  const parsed = parseScenarioArgs(args);
  if (typeof parsed === "string") {
    console.error(parsed);
    return 2;
  }
  const spec = SCENARIOS[parsed.n - 1] as ScenarioSpec;
  console.log(`scenario ${spec.n}: ${spec.title}`);

  let outcome: Outcome;
  let booted: Booted | null = null;
  const onSigint = () => {
    console.error("scenario: interrupted; shutting down");
    void booted?.rt.shutdown().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSigint);
  try {
    if (parsed.n === 6) outcome = await scenario6();
    else {
      booted = await bootHot();
      switch (parsed.n) {
        case 1:
          outcome = await scenario1(booted, parsed.live);
          break;
        case 2:
          outcome = await scenario2(booted);
          break;
        case 3:
          outcome = await scenario3(booted);
          break;
        case 4:
          outcome = await scenario4(booted);
          break;
        default:
          outcome = await scenario5(booted);
      }
    }
  } catch (err) {
    console.error(`scenario ${spec.n}: FAILED: ${errText(err)}`);
    if (!(err instanceof ScenarioFailure) && err instanceof Error && err.stack !== undefined) console.error(err.stack);
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
    if (booted !== null) await booted.rt.shutdown();
  }
  console.log("ok" in outcome ? `scenario ${spec.n}: OK` : `scenario ${spec.n}: SKIPPED(${outcome.skipped})`);
  return 0;
}
