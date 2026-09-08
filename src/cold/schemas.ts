// Strict-compatible (OpenAI/OpenRouter `json_schema.strict:true`) agent output schemas.
// Rules: every property required (`nullable` instead of optional), `additionalProperties:false`
// on every object, no `$ref`, no `z.record`. Per-engine params are explicit objects generated
// from the engine bound table so Commander/Coach can only propose values inside bounds.

import { z } from "zod";
import { ENGINE_IDS, type EngineId } from "../core/types.ts";
import { ENGINE_PARAM_BOUNDS, type ParamBound } from "../hot/engines/engine.ts";

export type { ParamBound };
export type ParamBounds = Record<EngineId, Record<string, ParamBound>>;
/** Canonical per-engine param bounds; re-exported so callers need not import the hot lane directly. */
export { ENGINE_PARAM_BOUNDS as FALLBACK_BOUNDS };

/** Boolean engine params (not in the numeric bound table). */
const BOOL_PARAMS: Partial<Record<EngineId, readonly string[]>> = { liqfade: ["allowMarket"] };

export const REGIMES = ["LOW_VOL", "NORMAL", "HIGH_VOL", "ILLIQUID"] as const;

// ---- builders ---------------------------------------------------------------

function engineParamsSchema(engine: EngineId, bounds: ParamBounds): z.ZodObject<Record<string, z.ZodNullable<z.ZodNumber | z.ZodBoolean>>> {
  const shape: Record<string, z.ZodNullable<z.ZodNumber | z.ZodBoolean>> = {};
  for (const [name, b] of Object.entries(bounds[engine])) {
    shape[name] = z.number().min(b.min).max(b.max).nullable();
  }
  for (const name of BOOL_PARAMS[engine] ?? []) shape[name] = z.boolean().nullable();
  return z.object(shape).strict();
}

function symbolsSchema(allowedSymbols: readonly string[]) {
  // OpenAI strict mode rejects an empty enum; with no whitelist the agent can only propose `null`.
  return allowedSymbols.length === 0
    ? z.array(z.never()).nullable()
    : z.array(z.enum(allowedSymbols as [string, ...string[]])).nullable();
}

/** Union of per-engine patch variants; each engine's params object is explicit and bounded. */
export interface EnginePatch {
  engine: EngineId;
  enabled: boolean | null;
  paper: boolean | null;
  symbols: string[] | null;
  sizeUsd: number | null;
  params: Record<string, number | boolean | null> | null;
  rationale: string;
}
export type EnginePatchSchema = z.ZodType<EnginePatch>;

export function makeEnginePatch(allowedSymbols: readonly string[], bounds: ParamBounds = ENGINE_PARAM_BOUNDS): EnginePatchSchema {
  const symbols = symbolsSchema(allowedSymbols);
  const variants = ENGINE_IDS.map((engine) =>
    z
      .object({
        engine: z.literal(engine),
        enabled: z.boolean().nullable(),
        paper: z.boolean().nullable(),
        symbols,
        sizeUsd: z.number().min(0).nullable(),
        params: engineParamsSchema(engine, bounds).nullable(),
        rationale: z.string().max(300),
      })
      .strict(),
  );
  return z.union(variants as unknown as [(typeof variants)[number], (typeof variants)[number], ...(typeof variants)[number][]]) as unknown as EnginePatchSchema;
}

export type Regime = (typeof REGIMES)[number];

export interface CommanderOut {
  regime: Regime;
  patches: EnginePatch[];
  notes: string;
}
export type CommanderOutSchema = z.ZodType<CommanderOut>;

export function makeCommanderOut(allowedSymbols: readonly string[], bounds: ParamBounds = ENGINE_PARAM_BOUNDS): CommanderOutSchema {
  return z
    .object({
      regime: z.enum(REGIMES),
      patches: z.array(makeEnginePatch(allowedSymbols, bounds)).max(8),
      notes: z.string().max(500),
    })
    .strict();
}

function perEngine<T extends z.ZodTypeAny>(value: T) {
  const shape = {} as Record<EngineId, T>;
  for (const id of ENGINE_IDS) shape[id] = value;
  return z.object(shape).strict();
}

const ENGINE_ID_ENUM = z.enum(ENGINE_IDS as [EngineId, ...EngineId[]]);

/** Mirrors `Limits` (src/core/types.ts) with every key nullable; `expires_in_min` maps to `expires_at`. */
export const SupervisorOut = z
  .object({
    action: z.enum(["tighten", "kill", "none"]),
    overlay: z
      .object({
        nav_usd_cap: z.number().min(0).nullable(),
        max_net_delta_pct: z.number().min(0).max(100).nullable(),
        max_leverage: z.number().min(1).max(125).nullable(),
        min_liq_distance_pct: z.number().min(0).max(100).nullable(),
        max_orders_per_sec: z.number().min(0).nullable(),
        daily_drawdown_kill_pct: z.number().min(0).max(100).nullable(),
        per_engine_max_notional_usd: perEngine(z.number().min(0).nullable()),
        onchain_max_notional_usd: z.number().min(0).nullable(),
        engines_paused: z.array(ENGINE_ID_ENUM).nullable(),
        expires_in_min: z.number().min(1).max(1440).nullable(),
      })
      .strict(),
    kill_reason: z.string().max(300).nullable(),
    rationale: z.string().max(500),
  })
  .strict();
export type SupervisorOut = z.infer<typeof SupervisorOut>;

export const TreasurerOut = z
  .object({
    budgets: perEngine(z.number().min(0).nullable()),
    llm_daily_budget_usd: z.number().min(0).nullable(),
    data_daily_budget_usd: z.number().min(0).nullable(),
    purchases: z.array(z.object({ url: z.string().max(500), max_usd: z.number().min(0) }).strict()).max(20),
    transfer_requests: z.array(z.string().max(300)).max(20),
    notes: z.string().max(500),
  })
  .strict();
export type TreasurerOut = z.infer<typeof TreasurerOut>;

export interface CoachOut {
  postmortem: string;
  patches: EnginePatch[];
  demote: EngineId[];
}
export type CoachOutSchema = z.ZodType<CoachOut>;

export function makeCoachOut(allowedSymbols: readonly string[], bounds: ParamBounds = ENGINE_PARAM_BOUNDS): CoachOutSchema {
  return z
    .object({
      postmortem: z.string().max(4000),
      patches: z.array(makeEnginePatch(allowedSymbols, bounds)).max(8),
      demote: z.array(ENGINE_ID_ENUM).max(ENGINE_IDS.length),
    })
    .strict();
}

export const SalesOut = z
  .object({
    summary: z.string().max(2000),
    prices: z.array(z.object({ route: z.string().max(100), price_usd: z.number().min(0) }).strict()).max(20),
    square_draft: z.string().max(2000),
  })
  .strict();
export type SalesOut = z.infer<typeof SalesOut>;

// ---- JSON Schema ---------------------------------------------------------------

type Json = Record<string, unknown>;

/**
 * zod → JSON Schema with the strict transform: every object gets `required` = all property
 * keys and `additionalProperties:false`; `$schema`/`$defs` removed (reused schemas inlined).
 */
export function toStrictJsonSchema(schema: z.ZodType): Json {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", reused: "inline", unrepresentable: "any" }) as Json;
  delete json.$schema;
  strictify(json);
  return json;
}

function strictify(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) strictify(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Json;
  const props = obj.properties;
  if (obj.type === "object" || (props !== null && typeof props === "object")) {
    const p = (props ?? {}) as Json;
    if (props === undefined) obj.properties = p;
    obj.required = Object.keys(p);
    obj.additionalProperties = false;
  }
  for (const key of Object.keys(obj)) {
    if (key === "enum" || key === "const" || key === "default") continue;
    strictify(obj[key]);
  }
}

/** Throws listing every strict-mode violation (missing required, open objects, `$ref`). */
export function assertStrict(json: unknown): void {
  const violations: string[] = [];
  walk(json, "$", violations);
  if (violations.length > 0) throw new Error(`schema not strict-compatible:\n  ${violations.join("\n  ")}`);
}

function walk(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${path}[${i}]`, out));
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Json;
  if ("$ref" in obj) out.push(`${path}: $ref not allowed`);
  const props = obj.properties;
  if (obj.type === "object" || (props !== null && typeof props === "object")) {
    const keys = Object.keys((props ?? {}) as Json);
    const required = Array.isArray(obj.required) ? (obj.required as string[]) : [];
    const missing = keys.filter((k) => !required.includes(k));
    if (missing.length > 0) out.push(`${path}: not required: ${missing.join(",")}`);
    if (obj.additionalProperties !== false) out.push(`${path}: additionalProperties must be false`);
  }
  for (const key of Object.keys(obj)) {
    if (key === "enum" || key === "const" || key === "default") continue;
    walk(obj[key], `${path}.${key}`, out);
  }
}
