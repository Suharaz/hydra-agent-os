// Cold-lane scheduler: interval / 5-field cron per agent, per-agent mutex, daily LLM budget gates
// (shadow off at 70%, coach/sales off at 80%, treasurer off at 90%, commander off at 100%,
// supervisor never gated), agents.yaml hot-reload, hourly pnl_1h back-fill, and a full pause until
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
import { type AgentDeps, type AgentModule, type AgentRunResult, runAgent } from "./agent.ts";
import { coach } from "./agents/coach.ts";
import { commander } from "./agents/commander.ts";
import { sales } from "./agents/sales.ts";
import { supervisor } from "./agents/supervisor.ts";
import { treasurer } from "./agents/treasurer.ts";

const log = logger("cold.scheduler");

export const TICK_MS = 5_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Budget fraction (spent / daily cap) at which each gate closes. */
export const BUDGET_GATES = { shadow: 0.7, coach: 0.8, sales: 0.8, treasurer: 0.9, commander: 1.0 } as const;

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
  private readonly running: Partial<Record<AgentName, Promise<AgentRunResult>>> = {};
  private timer: Timer | null = null;
  private unwatch: (() => void) | null = null;
  private agentsCfg: AgentsConfig;
  private lastBackfill = 0;
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

  /** True when the daily budget gate lets `name` run at `fraction` spent. */
  static allowed(name: AgentName, fraction: number): boolean {
    if (name === "supervisor") return true;
    return fraction < BUDGET_GATES[name];
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

  /** Agents whose schedule fires at `nowMs` and whom the budget / pause / mutex gates let run. */
  due(nowMs: number = this.now()): AgentName[] {
    if (this.pausedUntil > nowMs) return [];
    if (this.pausedUntil !== 0) this.pausedUntil = 0;
    const fraction = this.budgetFraction();
    const out: AgentName[] = [];
    for (const name of AGENT_NAMES) {
      if (this.deps.modules[name] === undefined) continue;
      const cfg = this.agentsCfg.agents[name];
      if (cfg === undefined || this.running[name] !== undefined) continue;
      if (!Scheduler.allowed(name, fraction)) continue;
      if (this.scheduled(name, cfg, nowMs)) out.push(name);
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

  /** Runs `name` now (ignores schedule and budget gates; honours the per-agent mutex by joining an in-flight run). */
  runNow(name: AgentName): Promise<AgentRunResult> {
    const inflight = this.running[name];
    if (inflight !== undefined) return inflight;
    const mod = this.deps.modules[name];
    if (mod === undefined) return Promise.reject(new Error(`unknown agent ${name}`));
    const cfg = this.configFor(name);
    this.lastRun[name] = this.now();
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
    log.error("openrouter credits exhausted: cold lane paused until next UTC day", { until: new Date(until).toISOString() });
    this.deps.ledger.event("agent.paused", JSON.stringify({ reason: "credits", until }));
  }

  tick(nowMs: number = this.now()): void {
    for (const name of this.due(nowMs)) {
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
      const apiKey = ctx.env.openrouterApiKey;
      if (apiKey === null) {
        log.warn("OPENROUTER_API_KEY not set: cold lane (LLM agents) disabled");
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
