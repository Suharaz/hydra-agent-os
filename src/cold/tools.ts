// Tool registry for cold-lane agents: ledger reads plus code-guarded writes. Every write tool
// validates against bounds / whitelists / effective limits before touching disk; `mode: 'record'`
// (shadow runs) performs the same validation but never writes, so shadow rejections are comparable.
// Tools are addressed by agent: a tool outside the agent's write scope is rejected, not hidden.

import { z } from "zod";
import { type EnginesConfig, type RiskConfig, writeEngines } from "../core/config.ts";
import type { Ledger } from "../core/ledger.ts";
import { type EffectiveLimits, type TightenPatch, tighten, TightenError } from "../core/limits.ts";
import { logger } from "../core/log.ts";
import { writeBudgets } from "../core/state.ts";
import { type AgentName, type Budgets, ENGINE_IDS, type EngineId, type Mode, type Venue } from "../core/types.ts";
import { ENGINE_PARAM_BOUNDS } from "../hot/engines/engine.ts";
import { writePricing, type Catalog } from "../pay/catalog.ts";
import { PaymentRejected, parseRequired, requirementsUsd, type Signer, x402fetch } from "../pay/client.ts";
import type { PaymentRequirements } from "../pay/facilitator.ts";

export interface ToolDeps {
  ledger: Ledger;
  configDir: string;
  stateDir: string;
  risk: RiskConfig;
  mode: Mode;
  engines: () => EnginesConfig;
  limits: () => EffectiveLimits;
  killLocked: () => boolean;
  kill: (reason: string) => Promise<unknown>;
  nav: () => number;
  /** x402 buyer identity (Treasurer `pay.buy`); absent = purchases refused. */
  signer?: Signer;
  /** Sold-route price list (Sales `pricing.set`); absent = repricing refused. */
  catalog?: Catalog;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ToolMode = "apply" | "record";

export interface ToolResult {
  ok: boolean;
  result?: unknown;
  rejected?: string;
}

export interface ToolSet {
  defs: ToolDef[];
  call(name: string, args: unknown): Promise<ToolResult>;
  readonly rejections: number;
  recorded: { name: string; args: unknown }[];
}

/** Venues an engine trades on; a symbol is admissible when any of them whitelists it. */
export const ENGINE_VENUES: Record<EngineId, readonly Venue[]> = {
  liqfade: ["futures", "spot"],
  basis: ["futures", "spot"],
  convert: ["spot"],
  smmirror: ["spot", "dex"],
  cexdex: ["spot", "dex"],
  tokstock: ["spot", "dex"],
  swing: ["futures", "spot"],
};

export const WRITE_SCOPE: Record<string, readonly AgentName[]> = {
  "engines.patch": ["commander", "coach"],
  "limits.tighten": ["supervisor"],
  "budget.set": ["treasurer"],
  "kill.now": ["supervisor"],
  "pay.buy": ["treasurer"],
  "pricing.set": ["sales"],
};

const log = logger("tools");

const engineId = z.enum(ENGINE_IDS as [EngineId, ...EngineId[]]);
const num = z.number().finite();

const PayBuyArgs = z.object({ url: z.string().url(), max_usd: num.nonnegative() }).strict();
const PricingSetArgs = z.object({ route: z.string().startsWith("/"), price_usd: num.nonnegative() }).strict();

export const EnginePatchArg = z
  .object({
    engine: engineId,
    enabled: z.boolean().nullable().optional(),
    paper: z.boolean().nullable().optional(),
    symbols: z.array(z.string().min(1)).nullable().optional(),
    sizeUsd: num.min(0).nullable().optional(),
    params: z.record(z.string(), z.union([num, z.boolean(), z.null()])).nullable().optional(),
    rationale: z.string().max(300).nullable().optional(),
  })
  .strict();
export type EnginePatchArg = z.infer<typeof EnginePatchArg>;

const EnginesPatchArgs = z.object({ patches: z.array(EnginePatchArg).min(1).max(8) }).strict();

const LimitsTightenArgs = z
  .object({
    patch: z
      .object({
        nav_usd_cap: num.nullable().optional(),
        max_net_delta_pct: num.nullable().optional(),
        max_leverage: num.nullable().optional(),
        min_liq_distance_pct: num.nullable().optional(),
        max_orders_per_sec: num.nullable().optional(),
        daily_drawdown_kill_pct: num.nullable().optional(),
        onchain_max_notional_usd: num.nullable().optional(),
        per_engine_max_notional_usd: z.record(z.string(), num.nullable()).nullable().optional(),
        engines_paused: z.union([z.array(engineId), z.literal("all")]).nullable().optional(),
        reason: z.string().max(300).nullable().optional(),
        expires_at: num.nullable().optional(),
      })
      .strict(),
  })
  .strict();

const BudgetSetArgs = z.object({ budgets: z.record(z.string(), num.nullable()) }).strict();
const KillArgs = z.object({ reason: z.string().min(1).max(200) }).strict();
const SinceArgs = z.object({ hours: z.number().min(1).max(24 * 30).optional() }).strict();
const EngineStatsArgs = z.object({ engine: engineId, days: z.number().min(1).max(90).optional() }).strict();
const VetoArgs = z.object({ n: z.number().int().min(1).max(200).optional() }).strict();

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
}

function isStrippedNull<T>(v: T | null | undefined): v is null | undefined {
  return v === null || v === undefined;
}

/** Validates one engine patch; returns the config-level patch fragment or a rejection reason. */
export function validateEnginePatch(p: EnginePatchArg, deps: ToolDeps): { ok: true; patch: Record<string, unknown> } | { ok: false; reason: string } {
  const out: Record<string, unknown> = {};
  const cap = deps.limits().per_engine_max_notional_usd[p.engine];
  if (!isStrippedNull(p.enabled)) out.enabled = p.enabled;
  if (!isStrippedNull(p.paper)) {
    if (p.paper === false && deps.mode === "live") return { ok: false, reason: `${p.engine}: promotion paper->live is human-only in live mode (cli promote)` };
    out.paper = p.paper;
  }
  if (!isStrippedNull(p.symbols)) {
    const allowed = new Set<string>();
    for (const v of ENGINE_VENUES[p.engine]) for (const s of deps.risk.allowed_symbols[v]) allowed.add(s);
    const bad = p.symbols.filter((s) => !allowed.has(s));
    if (bad.length > 0) return { ok: false, reason: `${p.engine}: symbols outside allowed_symbols: ${bad.join(",")}` };
    if (p.symbols.length === 0) return { ok: false, reason: `${p.engine}: symbols must not be empty` };
    out.symbols = p.symbols;
  }
  if (!isStrippedNull(p.sizeUsd)) {
    if (p.sizeUsd > cap) return { ok: false, reason: `${p.engine}: sizeUsd ${p.sizeUsd} exceeds per-engine cap ${cap}` };
    out.sizeUsd = p.sizeUsd;
  }
  if (!isStrippedNull(p.params)) {
    const bounds = ENGINE_PARAM_BOUNDS[p.engine];
    const current = deps.engines().engines[p.engine].params;
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p.params)) {
      if (v === null) continue;
      const b = bounds[k];
      if (b !== undefined) {
        if (typeof v !== "number") return { ok: false, reason: `${p.engine}.${k}: expected number` };
        if (v < b.min || v > b.max) return { ok: false, reason: `${p.engine}.${k}=${v} outside [${b.min}, ${b.max}]` };
        params[k] = v;
      } else if (typeof current[k] === "boolean" && typeof v === "boolean") {
        params[k] = v;
      } else {
        return { ok: false, reason: `${p.engine}.${k}: unknown param` };
      }
    }
    if (Object.keys(params).length > 0) out.params = params;
  }
  if (Object.keys(out).length === 0) return { ok: false, reason: `${p.engine}: empty patch` };
  return { ok: true, patch: out };
}

function tightenPatchOf(raw: z.infer<typeof LimitsTightenArgs>["patch"]): TightenPatch {
  const patch: TightenPatch = {};
  for (const k of ["nav_usd_cap", "max_net_delta_pct", "max_leverage", "min_liq_distance_pct", "max_orders_per_sec", "daily_drawdown_kill_pct", "onchain_max_notional_usd"] as const) {
    const v = raw[k];
    if (!isStrippedNull(v)) patch[k] = v;
  }
  if (!isStrippedNull(raw.per_engine_max_notional_usd)) {
    const per: Partial<Record<EngineId, number>> = {};
    for (const [e, v] of Object.entries(raw.per_engine_max_notional_usd)) {
      if (v === null) continue;
      if (!(ENGINE_IDS as readonly string[]).includes(e)) throw new TightenError([`unknown engine ${e}`]);
      per[e as EngineId] = v;
    }
    if (Object.keys(per).length > 0) patch.per_engine_max_notional_usd = per;
  }
  if (!isStrippedNull(raw.engines_paused)) patch.engines_paused = raw.engines_paused;
  if (!isStrippedNull(raw.reason)) patch.reason = raw.reason;
  if (raw.expires_at !== undefined) patch.expires_at = raw.expires_at;
  return patch;
}

/** Validates budgets: each <= per-engine cap, sum <= NAV. */
export function validateBudgets(raw: Record<string, number | null>, deps: ToolDeps): { ok: true; budgets: Budgets } | { ok: false; reason: string } {
  const lim = deps.limits();
  const caps = lim.per_engine_max_notional_usd;
  const budgets: Budgets = {};
  let sum = 0;
  for (const [e, v] of Object.entries(raw)) {
    if (v === null) continue;
    if (!(ENGINE_IDS as readonly string[]).includes(e)) return { ok: false, reason: `unknown engine ${e}` };
    if (v < 0) return { ok: false, reason: `${e}: negative budget` };
    const cap = caps[e as EngineId];
    if (v > cap) return { ok: false, reason: `${e}: budget ${v} exceeds per-engine cap ${cap}` };
    budgets[e as EngineId] = v;
    sum += v;
  }
  const nav = deps.nav();
  const maxNotionalCap = nav * Math.max(1, lim.max_leverage ?? 1);
  if (sum > maxNotionalCap) return { ok: false, reason: `budget sum ${sum} exceeds max notional capacity ${maxNotionalCap} (NAV ${nav} * max_leverage ${lim.max_leverage})` };
  return { ok: true, budgets };
}

export function buildTools(deps: ToolDeps, agent: AgentName, mode: ToolMode): ToolSet {
  let rejections = 0;
  const recorded: { name: string; args: unknown }[] = [];
  const reject = (reason: string): ToolResult => {
    rejections++;
    log.warn("tool rejected", { agent, mode, reason });
    return { ok: false, rejected: reason };
  };

  const defs: ToolDef[] = [
    { name: "ledger.pnlByEngine", description: "Realized PnL, fees, trade count and wins per engine over the last N hours (default 24).", parameters: jsonSchema(SinceArgs) },
    { name: "ledger.engineStats", description: "Hit rate, avg return bps, Sharpe and max drawdown bps for one engine over N days (default 7).", parameters: jsonSchema(EngineStatsArgs) },
    { name: "ledger.latencyStats", description: "Order ack latency p50/p95 ms over the last N hours (default 24).", parameters: jsonSchema(SinceArgs) },
    { name: "ledger.recentVetoes", description: "Most recent kernel vetoes (default 20).", parameters: jsonSchema(VetoArgs) },
    { name: "ledger.openOrders", description: "Currently open orders.", parameters: jsonSchema(z.object({}).strict()) },
    { name: "ledger.llmCostToday", description: "LLM spend today in USD versus the daily budget.", parameters: jsonSchema(z.object({}).strict()) },
    { name: "engines.get", description: "Current engines.yaml plus per-param bounds and allowed symbols.", parameters: jsonSchema(z.object({}).strict()) },
    {
      name: "engines.patch",
      description: "Patch engine config (enabled/paper/symbols/sizeUsd/params). Bounds, symbol whitelist and promotion rule are enforced; all-or-nothing.",
      parameters: jsonSchema(EnginesPatchArgs),
    },
    { name: "limits.tighten", description: "Tighten risk limits (values must be <= current effective; paused set may only grow).", parameters: jsonSchema(LimitsTightenArgs) },
    { name: "budget.set", description: "Set per-engine budgets in USD (each <= engine cap, sum <= NAV).", parameters: jsonSchema(BudgetSetArgs) },
    { name: "kill.now", description: "Flatten everything and lock the system. Supervisor only; irreversible without an operator.", parameters: jsonSchema(KillArgs) },
    { name: "pay.buy", description: "Buy an x402-priced resource (GET url); refused when the price exceeds max_usd or today's data budget.", parameters: jsonSchema(PayBuyArgs) },
    { name: "pricing.set", description: "Set a sold route's price in USD; must stay inside the route's [min, max] band.", parameters: jsonSchema(PricingSetArgs) },
  ];

  const hoursAgo = (h: number | undefined, dflt: number) => Date.now() - (h ?? dflt) * 3_600_000;

  const write = (name: string, args: unknown, fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> | ToolResult => {
    recorded.push({ name, args });
    const scope = WRITE_SCOPE[name];
    if (scope !== undefined && !scope.includes(agent)) return reject(`${name}: outside ${agent} write scope`);
    return fn();
  };

  async function call(name: string, args: unknown): Promise<ToolResult> {
    const parse = <T>(schema: z.ZodType<T>): T | null => {
      const r = schema.safeParse(args ?? {});
      if (r.success) return r.data;
      return null;
    };
    try {
      switch (name) {
        case "ledger.pnlByEngine": {
          const a = parse(SinceArgs);
          if (a === null) return reject(`${name}: bad args`);
          return { ok: true, result: deps.ledger.pnlByEngine(hoursAgo(a.hours, 24)) };
        }
        case "ledger.engineStats": {
          const a = parse(EngineStatsArgs);
          if (a === null) return reject(`${name}: bad args`);
          return { ok: true, result: deps.ledger.engineStats(a.engine, a.days ?? 7) };
        }
        case "ledger.latencyStats": {
          const a = parse(SinceArgs);
          if (a === null) return reject(`${name}: bad args`);
          return { ok: true, result: deps.ledger.latencyStats(hoursAgo(a.hours, 24)) };
        }
        case "ledger.recentVetoes": {
          const a = parse(VetoArgs);
          if (a === null) return reject(`${name}: bad args`);
          return { ok: true, result: deps.ledger.recentVetoes(a.n ?? 20) };
        }
        case "ledger.openOrders":
          return { ok: true, result: deps.ledger.openOrders() };
        case "ledger.llmCostToday":
          return { ok: true, result: { costUsd: deps.ledger.llmCostToday(), budgetUsd: deps.risk.llm_daily_budget_usd } };
        case "engines.get":
          return {
            ok: true,
            result: { engines: deps.engines().engines, bounds: ENGINE_PARAM_BOUNDS, allowed_symbols: deps.risk.allowed_symbols, caps: deps.limits().per_engine_max_notional_usd },
          };
        case "engines.patch":
          return write(name, args, async () => {
            const a = parse(EnginesPatchArgs);
            if (a === null) return reject(`${name}: bad args`);
            const merged: Record<string, Record<string, unknown>> = {};
            for (const p of a.patches) {
              const v = validateEnginePatch(p, deps);
              if (!v.ok) return reject(`${name}: ${v.reason}`);
              const prev = merged[p.engine] ?? {};
              const prevParams = (prev.params as Record<string, unknown> | undefined) ?? {};
              merged[p.engine] = { ...prev, ...v.patch, ...(v.patch.params === undefined ? {} : { params: { ...prevParams, ...(v.patch.params as Record<string, unknown>) } }) };
            }
            if (mode === "record") return { ok: true, result: { recorded: true, patch: merged } };
            const r = await writeEngines(deps.configDir, { engines: merged }, agent as "commander" | "coach", deps.ledger);
            return { ok: true, result: { written: true, changed: r } };
          });
        case "limits.tighten":
          return write(name, args, () => {
            const a = parse(LimitsTightenArgs);
            if (a === null) return reject(`${name}: bad args`);
            let patch: TightenPatch;
            try {
              patch = tightenPatchOf(a.patch);
            } catch (err) {
              return reject(`${name}: ${err instanceof Error ? err.message : String(err)}`);
            }
            const current = deps.limits();
            if (mode === "record") {
              const problem = tightenProblem(patch, current);
              return problem === null ? { ok: true, result: { recorded: true, patch } } : reject(`${name}: ${problem}`);
            }
            try {
              return { ok: true, result: tighten(deps.stateDir, patch, "supervisor", current) };
            } catch (err) {
              if (err instanceof TightenError) return reject(`${name}: ${err.message}`);
              throw err;
            }
          });
        case "budget.set":
          return write(name, args, () => {
            const a = parse(BudgetSetArgs);
            if (a === null) return reject(`${name}: bad args`);
            const v = validateBudgets(a.budgets, deps);
            if (!v.ok) return reject(`${name}: ${v.reason}`);
            if (mode === "record") return { ok: true, result: { recorded: true, budgets: v.budgets } };
            return { ok: true, result: writeBudgets(deps.stateDir, v.budgets, "treasurer") };
          });
        case "kill.now":
          return write(name, args, async () => {
            const a = parse(KillArgs);
            if (a === null) return reject(`${name}: bad args`);
            if (deps.killLocked()) return reject(`${name}: kill lock already present`);
            if (mode === "record") return { ok: true, result: { recorded: true, reason: a.reason } };
            return { ok: true, result: await deps.kill(`supervisor: ${a.reason}`) };
          });
        case "pay.buy":
          return write(name, args, async () => {
            const a = parse(PayBuyArgs);
            if (a === null) return reject(`${name}: bad args`);
            const budget = deps.risk.data_daily_budget_usd;
            const spent = deps.ledger.dataSpendToday();
            const accept = (_reqs: PaymentRequirements, usd: number): string | null => {
              if (usd > a.max_usd) return `price ${usd} exceeds max_usd ${a.max_usd}`;
              if (spent + usd > budget) return `data budget: spent ${spent} + ${usd} > ${budget}`;
              return null;
            };
            if (mode === "record") {
              const pr = parseRequired(await fetch(a.url));
              if (pr === null || pr.accepts.length === 0) return { ok: true, result: { recorded: true, url: a.url, paid: false } };
              const reqs = pr.accepts[0];
              if (reqs === undefined) return { ok: true, result: { recorded: true, url: a.url, paid: false } };
              const usd = requirementsUsd(reqs);
              const problem = accept(reqs, usd);
              return problem === null ? { ok: true, result: { recorded: true, url: a.url, usd } } : reject(`${name}: ${problem}`);
            }
            if (deps.signer === undefined) return reject(`${name}: no x402 signer configured`);
            try {
              const res = await x402fetch(a.url, undefined, deps.signer, { ledger: deps.ledger, accept });
              const body: unknown = await res.json().catch(() => null);
              return { ok: true, result: { status: res.status, payment: res.payment ?? null, body } };
            } catch (err) {
              if (err instanceof PaymentRejected) return reject(`${name}: ${err.message}`);
              throw err;
            }
          });
        case "pricing.set":
          return write(name, args, () => {
            const a = parse(PricingSetArgs);
            if (a === null) return reject(`${name}: bad args`);
            if (deps.catalog === undefined) return reject(`${name}: no catalog configured`);
            const problem = deps.catalog.check(a.route, a.price_usd);
            if (problem !== null) return reject(`${name}: ${problem}`);
            if (mode === "record") return { ok: true, result: { recorded: true, route: a.route, price_usd: a.price_usd } };
            deps.catalog.set(a.route, a.price_usd);
            const r = writePricing(deps.configDir, { routes: { [a.route]: { price_usd: a.price_usd } } }, "sales");
            return { ok: true, result: { written: true, changed: r.changed, route: a.route, price_usd: a.price_usd } };
          });
        default:
          return reject(`unknown tool ${name}`);
      }
    } catch (err) {
      return reject(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    defs,
    call,
    get rejections() {
      return rejections;
    },
    recorded,
  };
}

/** Dry-run mirror of `tighten()`'s checks for record mode. Returns a rejection reason or null.
 *
 * Semantic split:
 *  - Caps (nav_usd_cap, max_net_delta_pct, max_leverage, max_orders_per_sec,
 *    daily_drawdown_kill_pct, onchain_max_notional_usd, per_engine_max_notional_usd):
 *    tighter = lower value; reject if v > current (would loosen).
 *  - Floors (min_liq_distance_pct): tighter = higher value (must stay ≥ current distance);
 *    reject if v < current (would loosen).
 */
export function tightenProblem(patch: TightenPatch, current: EffectiveLimits): string | null {
  for (const k of ["nav_usd_cap", "max_net_delta_pct", "max_leverage", "max_orders_per_sec", "daily_drawdown_kill_pct", "onchain_max_notional_usd"] as const) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v > current[k]) return `${k}=${v} looser than effective ${current[k]}`;
  }
  const floor = patch.min_liq_distance_pct;
  if (floor !== undefined && floor < current.min_liq_distance_pct) {
    return `min_liq_distance_pct=${floor} looser than effective ${current.min_liq_distance_pct}`;
  }
  if (patch.per_engine_max_notional_usd !== undefined) {
    for (const [e, v] of Object.entries(patch.per_engine_max_notional_usd)) {
      if (v === undefined) continue;
      const cur = current.per_engine_max_notional_usd[e as EngineId];
      if (v > cur) return `per_engine_max_notional_usd.${e}=${v} looser than effective ${cur}`;
    }
  }
  if (patch.engines_paused !== undefined && current.engines_paused === "all" && patch.engines_paused !== "all") return "engines_paused may not shrink";
  if (patch.engines_paused !== undefined && patch.engines_paused !== "all" && current.engines_paused !== "all") {
    for (const e of current.engines_paused) if (!patch.engines_paused.includes(e)) return `engines_paused must keep ${e}`;
  }
  return null;
}
