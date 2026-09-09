// Cold-lane scheduler: interval / 5-field cron per agent, per-agent mutex, daily LLM budget gates
// (shadow off at 70%, coach/sales off at 80%, treasurer off at 90%, commander/supervisor off at 100%),
// agents.yaml hot-reload, hourly pnl_1h back-fill, and a full pause until
// the next UTC day when OpenRouter reports no credits. `createAgentsModule` wires it into boot.

import { bus as defaultBus, type Bus } from "../core/bus.ts";
import { utcDayStartMs } from "../core/clock.ts";
import { type AgentConfig, type AgentsConfig, applyModelOverrides, type Config, type EnginesConfig, loadConfig, watchAgents, watchEngines } from "../core/config.ts";
import { anyVenueLive, type Env } from "../core/env.ts";
import type { Ledger } from "../core/ledger.ts";
import { effective } from "../core/limits.ts";
import { logger } from "../core/log.ts";
import { readKillLock, readLimits } from "../core/state.ts";
import { AGENT_NAMES, type AgentName } from "../core/types.ts";
import type { EngineRegistry } from "../hot/engines/registry.ts";
import type { ExecutorStack } from "../hot/executor.ts";
import type { Module } from "../main.ts";
import type { Catalog } from "../pay/catalog.ts";
import type { Signer } from "../pay/client.ts";
import { backfillPnl1h } from "./ab.ts";
import {
  type AgentDeps,
  type AgentModule,
  type AgentNoveltySnapshot,
  type AgentRunResult,
  checkNoveltyGate,
  extractNoveltySnapshot,
  type NoveltyGateResult,
  runAgent,
} from "./agent.ts";
import { coach } from "./agents/coach.ts";
import { commander } from "./agents/commander.ts";
import { sales } from "./agents/sales.ts";
import { supervisor } from "./agents/supervisor.ts";
import { treasurer } from "./agents/treasurer.ts";

const log = logger("cold.scheduler");

export const TICK_MS = 5_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
export const STARVATION_MS = 30 * 60_000;

/** Budget fraction (spent / daily cap) at which each gate closes. */
export const BUDGET_GATES = { shadow: 0.7, coach: 0.8, sales: 0.8, treasurer: 0.9, commander: 1.0, supervisor: 1.0 } as const;

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous module map keyed by agent name
export const AGENT_MODULES: Record<AgentName, AgentModule<any>> = { commander, supervisor, treasurer, coach, sales };

// ---- schedule parsing ---------------------------------------------------------

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: HOUR_MS, d: DAY_MS };

/** `30s` / `5m` / `1h` / `250ms` / `1d` -> ms. Throws on anything else. */
export function parseInterval(s: string): number {
  const m = /^([1-9]\d*)(ms|s|m|h|d)$/.exec(s.trim());
  if (m === null) throw new Error(`bad interval ${JSON.stringify(s)}`);
  return Number(m[1]) * (UNIT_MS[m[2] as string] as number);
}

export interface Cron {
  minute: boolean[];
  hour: boolean[];
  dom: boolean[];
  month: boolean[];
  dow: boolean[];
}

function cronField(spec: string, min: number, max: number, name: string): boolean[] {
  const out: boolean[] = new Array(max + 1).fill(false);
  for (const part of spec.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (m === null) throw new Error(`bad cron ${name} field ${JSON.stringify(part)}`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (!(step >= 1)) throw new Error(`bad cron step in ${JSON.stringify(part)}`);
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const [a, b] = (m[1] as string).split("-").map(Number);
      lo = a as number;
      hi = b === undefined ? (m[2] === undefined ? (a as number) : max) : b;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron ${name} out of range: ${JSON.stringify(part)}`);
    for (let v = lo; v <= hi; v += step) out[v] = true;
  }
  return out;
}

/** 5-field cron (min hour dom month dow), UTC, minute resolution. */
export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron needs 5 fields: ${JSON.stringify(expr)}`);
  const dow = cronField(f[4] as string, 0, 7, "dow");
  if (dow[7]) dow[0] = true;
  return { minute: cronField(f[0] as string, 0, 59, "minute"), hour: cronField(f[1] as string, 0, 23, "hour"), dom: cronField(f[2] as string, 1, 31, "dom"), month: cronField(f[3] as string, 1, 12, "month"), dow };
}

export function cronMatches(c: Cron, ms: number): boolean {
  const d = new Date(ms);
  return c.minute[d.getUTCMinutes()] === true && c.hour[d.getUTCHours()] === true && c.dom[d.getUTCDate()] === true && c.month[d.getUTCMonth() + 1] === true && c.dow[d.getUTCDay()] === true;
}

// ---- scheduler ------------------------------------------------------------------

export interface SchedulerDeps extends AgentDeps {
  agents: () => AgentsConfig;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous module map keyed by agent name
  modules: Record<AgentName, AgentModule<any>>;
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private readonly lastRun: Partial<Record<AgentName, number>> = {};
  private readonly lastActualRun: Partial<Record<AgentName, number>> = {};
  private readonly running: Partial<Record<AgentName, Promise<AgentRunResult>>> = {};
  private timer: Timer | null = null;
  private unwatch: (() => void) | null = null;
  private agentsCfg: AgentsConfig;
  private lastBackfill = 0;
  private readonly lastSnapshots: Partial<Record<AgentName, AgentNoveltySnapshot>> = {};
  private commanderBootstrapped = false;
  /** Wall ms until which every agent is paused (402 from OpenRouter); 0 = not paused. */
  pausedUntil = 0;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.agentsCfg = deps.agents();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Spent fraction of today's LLM budget; a zero budget counts as fully spent. */
  budgetFraction(): number {
    const cap = this.deps.risk.llm_daily_budget_usd;
    if (!(cap > 0)) return 1;
    return this.deps.ledger.llmCostToday() / cap;
  }

  /** Operator "start again": clear the credits pause so agents resume before the UTC-day boundary. */
  resume(): void {
    this.pausedUntil = 0;
  }

  /** Cold-lane health for the operator dashboard (OpenRouter pause + daily-budget usage). */
  coldLaneStatus(): { enabled: boolean; paused: boolean; pausedUntil: number; budgetPct: number } {
    return { enabled: true, paused: this.pausedUntil > this.now(), pausedUntil: this.pausedUntil, budgetPct: Math.min(1, this.budgetFraction()) };
  }

  /** True when the daily budget gate lets `name` run at `fraction` spent. */
  static allowed(name: AgentName, fraction: number): boolean {
    if (fraction >= 1.0) return false;
    return fraction < (BUDGET_GATES[name] ?? 1.0);
  }

  private scheduled(name: AgentName, cfg: AgentConfig, nowMs: number): boolean {
    const last = this.lastRun[name];
    if (cfg.interval !== undefined) return last === undefined || nowMs - last >= parseInterval(cfg.interval);
    if (cfg.cron !== undefined) {
      if (!cronMatches(parseCron(cfg.cron), nowMs)) return false;
      return last === undefined || Math.floor(last / 60_000) !== Math.floor(nowMs / 60_000);
    }
    return false;
  }

  /** Evaluates whether an agent has meaningful work to do before an automatic scheduled invocation. */
  hasMeaningfulWork(name: AgentName, nowMs: number = this.now()): NoveltyGateResult {
    const current = extractNoveltySnapshot(this.deps);
    const last = this.lastSnapshots[name];
    const meta = {
      bootstrapped: this.commanderBootstrapped,
      lastRunMs: this.lastActualRun[name],
      nowMs,
      starvationMs: STARVATION_MS,
    };
    return checkNoveltyGate(name, current, last, meta);
  }

  /** Records the current material state baseline after an agent runs. */
  recordNoveltyBaseline(name: AgentName, snap?: AgentNoveltySnapshot): void {
    const s = snap ?? extractNoveltySnapshot(this.deps);
    this.lastSnapshots[name] = s;
    this.lastActualRun[name] = (this.deps.now ?? Date.now)();
    if (name === "commander") {
      this.commanderBootstrapped = true;
    }
  }

  /** Runtime service status for dashboard bridge. Active means scheduled service is enabled (not thinking). */
  runtimeStatus(): Record<AgentName, { active: boolean }> {
    const isPaused = this.pausedUntil > this.now();
    const out = {} as Record<AgentName, { active: boolean }>;
    for (const name of AGENT_NAMES) {
      const cfg = this.agentsCfg.agents[name];
      const hasModule = this.deps.modules[name] !== undefined;
      const isConfigured = cfg !== undefined && (cfg.interval !== undefined || cfg.cron !== undefined);
      out[name] = {
        active: this.timer !== null && hasModule && isConfigured && !isPaused && Scheduler.allowed(name, this.budgetFraction()),
      };
    }
    return out;
  }

  /** Agents whose schedule fires at `nowMs` and whom the budget / pause / mutex gates let run. */
  due(nowMs: number = this.now(), opts?: { filterNovelty?: boolean }): AgentName[] {
    if (this.pausedUntil > nowMs) return [];
    if (this.pausedUntil !== 0) this.pausedUntil = 0;
    const fraction = this.budgetFraction();
    const out: AgentName[] = [];
    for (const name of AGENT_NAMES) {
      if (this.deps.modules[name] === undefined) continue;
      const cfg = this.agentsCfg.agents[name];
      if (cfg === undefined || this.running[name] !== undefined) continue;
      if (!Scheduler.allowed(name, fraction)) continue;
      if (this.scheduled(name, cfg, nowMs)) {
        if (opts?.filterNovelty && !this.hasMeaningfulWork(name, nowMs).hasWork) {
          continue;
        }
        out.push(name);
      }
    }
    return out;
  }

  /** Effective config for a run: shadow dropped at >= 70% budget. */
  private configFor(name: AgentName): AgentConfig {
    const cfg = this.agentsCfg.agents[name];
    if (cfg.shadow_model !== undefined && this.budgetFraction() >= BUDGET_GATES.shadow) {
      const { shadow_model: _drop, ...rest } = cfg;
      return rest;
    }
    return cfg;
  }

  /** Manual runs bypass schedule/novelty, never the daily cap or credit pause. */
  runNow(name: AgentName): Promise<AgentRunResult> {
    const inflight = this.running[name];
    if (inflight !== undefined) return inflight;
    if (this.pausedUntil > this.now()) {
      return Promise.reject(new Error("cold lane paused: yescale credits exhausted"));
    }
    if (this.budgetFraction() >= 1.0) {
      return Promise.reject(new Error("daily LLM budget cap exceeded"));
    }
    const mod = this.deps.modules[name];
    if (mod === undefined) return Promise.reject(new Error(`unknown agent ${name}`));
    const cfg = this.configFor(name);
    this.lastRun[name] = this.now();
    this.recordNoveltyBaseline(name);
    const p = runAgent(mod, cfg, this.deps)
      .then((r) => {
        if (r.primary.errorCode === "credits" || r.shadow?.errorCode === "credits") this.pauseForCredits();
        return r;
      })
      .finally(() => {
        delete this.running[name];
      });
    this.running[name] = p;
    return p;
  }

  private pauseForCredits(): void {
    const until = utcDayStartMs(this.now()) + DAY_MS;
    if (this.pausedUntil >= until) return;
    this.pausedUntil = until;
    log.error("yescale credits exhausted: cold lane paused until next UTC day", { until: new Date(until).toISOString() });
    this.deps.ledger.event("agent.paused", JSON.stringify({ reason: "credits", until }));
  }

  tick(nowMs: number = this.now()): void {
    for (const name of this.due(nowMs)) {
      const novelty = this.hasMeaningfulWork(name, nowMs);
      if (!novelty.hasWork) {
        this.lastRun[name] = nowMs;
        this.lastSnapshots[name] ??= extractNoveltySnapshot(this.deps);
        log.info("scheduled agent run skipped: no meaningful work", { agent: name, reason: novelty.reason });
        continue;
      }
      this.runNow(name).catch((err) => log.error("agent run failed", { agent: name, error: err instanceof Error ? err.message : String(err) }));
    }
    if (nowMs - this.lastBackfill >= HOUR_MS) {
      this.lastBackfill = nowMs;
      try {
        const n = backfillPnl1h(this.deps.ledger, nowMs);
        if (n > 0) log.info("pnl_1h back-fill", { rows: n });
      } catch (err) {
        log.error("pnl_1h back-fill failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** Swap the agents config (hot-reload path); applies HYDRA_MODEL_* overrides. */
  reload(cfg: AgentsConfig): void {
    this.agentsCfg = applyModelOverrides(cfg, this.deps.env.modelOverrides);
    log.info("agents.yaml reloaded", Object.fromEntries(AGENT_NAMES.map((n) => [n, `${this.agentsCfg.agents[n].model}${this.agentsCfg.agents[n].shadow_model === undefined ? "" : ` / ${this.agentsCfg.agents[n].shadow_model}`}`])));
  }

  start(): void {
    if (this.timer !== null) return;
    this.lastBackfill = this.now() - HOUR_MS; // first tick back-fills
    this.unwatch = watchAgents(this.deps.configDir, (cfg) => this.reload(cfg));
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    log.info("scheduler started", Object.fromEntries(AGENT_NAMES.map((n) => [n, this.agentsCfg.agents[n].interval ?? this.agentsCfg.agents[n].cron ?? ""])));
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unwatch?.();
    this.unwatch = null;
  }
}

// ---- wiring ---------------------------------------------------------------------

export interface AgentsModuleContext {
  env: Env;
  config: Config;
  ledger: Ledger;
  stateDir: string;
  configDir: string;
  /** Executor stack, or a getter when the stack is populated after this module is built. */
  stack: ExecutorStack | null | (() => ExecutorStack | null);
  registry?: EngineRegistry | null;
  bus?: Bus;
  /** x402 buyer identity for Treasurer `pay.buy`. */
  signer?: Signer;
  /** Sold-route price list for Sales `pricing.set`. */
  catalog?: Catalog;
}

/** Builds AgentDeps from the runtime; `engines()` follows engines.yaml via the returned `stop()` watcher.
 * ToolDeps.mode reflects actual real-money status (live when ANY venue flag is live regardless of top-level mode).
 * risk is read fresh from disk at most once every 5 s so budget edits from the dashboard reach the scheduler. */
export function buildAgentDeps(ctx: AgentsModuleContext, apiKey: string): { deps: AgentDeps; stop(): void } {
  const { env, config, ledger, stateDir, configDir } = ctx;
  const bus = ctx.bus ?? defaultBus;
  const stackOf = typeof ctx.stack === "function" ? ctx.stack : () => ctx.stack as ExecutorStack | null;
  let engines: EnginesConfig = config.engines;
  const unwatch = watchEngines(configDir, (cfg) => {
    engines = cfg;
  });
  const killLocked = () => readKillLock(stateDir) !== null;

  // Derived mode: any live venue flag → treat as live for promotion/safety checks regardless of env.mode.
  const effectiveMode = anyVenueLive(env) ? "live" : env.mode;

  // Live risk: re-read risk.yaml at most every 5 s so dashboard budget edits reach the scheduler/Treasurer.
  let liveRisk = config.risk;
  let riskReadAt = 0;
  const freshRisk = () => {
    const now = Date.now();
    if (now - riskReadAt >= 5_000) {
      try { liveRisk = loadConfig(configDir).risk; } catch { /* keep last good */ }
      riskReadAt = now;
    }
    return liveRisk;
  };

  const deps: AgentDeps = {
    env,
    config,
    ledger,
    stateDir,
    configDir,
    get risk() { return freshRisk(); },
    apiKey,
    bus,
    registry: ctx.registry ?? null,
    get positions() {
      return stackOf()?.positions ?? null;
    },
    toolDeps: {
      ledger,
      configDir,
      stateDir,
      get risk() { return freshRisk(); },
      mode: effectiveMode,
      engines: () => engines,
      limits: () => effective(freshRisk(), readLimits(stateDir), Date.now(), killLocked()),
      killLocked,
      kill: (reason) => {
        const stack = stackOf();
        return stack === null ? Promise.reject(new Error("executor not started; kill unavailable")) : stack.kill(reason);
      },
      nav: () => stackOf()?.positions.nav() ?? 0,
      signer: ctx.signer,
      catalog: ctx.catalog,
    },
  };
  return { deps, stop: unwatch };
}

export function createAgentsModule(ctx: AgentsModuleContext): Module & { scheduler: Scheduler | null } {
  let scheduler: Scheduler | null = null;
  let stopDeps: (() => void) | null = null;
  return {
    name: "agents",
    order: "agents",
    get scheduler() {
      return scheduler;
    },
    start() {
      const apiKey = ctx.env.yescaleApiKey;
      if (apiKey === null) {
        log.warn("YESCALE_API_KEY not set: cold lane (LLM agents) disabled");
        return;
      }
      const built = buildAgentDeps(ctx, apiKey);
      stopDeps = built.stop;
      scheduler = new Scheduler({ ...built.deps, agents: () => ctx.config.agents, modules: AGENT_MODULES });
      scheduler.start();
    },
    stop() {
      scheduler?.stop();
      scheduler = null;
      stopDeps?.();
      stopDeps = null;
    },
  };
}
