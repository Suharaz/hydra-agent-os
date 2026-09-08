// config/{agents,engines,risk,pricing}.yaml -> zod-validated Config.
//
// Ownership: agents.yaml and the two budget keys of risk.yaml are operator-only; engines.yaml may
// be written by operator/commander/coach; everything else in risk.yaml is file-only (restart).
// Writes go through one promise-chain queue with a content-hash CAS (one rebase retry), land
// atomically (<file>.tmp + rename), preserve YAML comments (parseDocument + setIn), and record a
// config_changes row when a ledger is supplied. Watchers: fs.watch on the directory, 100 ms
// debounce, sha256 gate; in-process writes also notify watchers directly so hot-reload does not
// depend on platform fs.watch fidelity.

import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
import { z } from "zod";
import { bus } from "./bus.ts";
import type { Ledger } from "./ledger.ts";
import { atomicWriteSync, OwnerError, sha256 } from "./state.ts";
import { AGENT_NAMES, ENGINE_IDS, type AgentName, type EngineConfig, type EngineId } from "./types.ts";

export { OwnerError };

export class ConfigError extends Error {
  constructor(
    public readonly file: string,
    public readonly problems: string[],
  ) {
    super(`invalid ${file}:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

// ---- schemas --------------------------------------------------------------

export const MODEL_ID = /^[a-z0-9-]+\/[a-z0-9._:-]+$/;
/** `5m`, `30s`, `1h`, `250ms`, `1d`. */
export const DURATION = /^[1-9]\d*(ms|s|m|h|d)$/;
const CRON = /^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s*$/;

const modelId = z.string().regex(MODEL_ID, "expected OpenRouter model id provider/model[:variant]");

export const ProviderSchema = z.looseObject({
  order: z.array(z.string()).optional(),
  allow_fallbacks: z.boolean().optional(),
  require_parameters: z.boolean().optional(),
  data_collection: z.enum(["allow", "deny"]).optional(),
  ignore: z.array(z.string()).optional(),
  quantizations: z.array(z.string()).optional(),
  sort: z.string().optional(),
});

export const AgentSchema = z
  .object({
    model: modelId,
    shadow_model: modelId.optional(),
    fallback_models: z.array(modelId).optional(),
    temperature: z.number().min(0).max(2),
    interval: z.string().regex(DURATION, "expected duration like 5m, 30s, 1h").optional(),
    cron: z.string().regex(CRON, "expected 5-field cron expression").optional(),
    provider: ProviderSchema.optional(),
  })
  .strict()
  .refine((a) => (a.interval === undefined) !== (a.cron === undefined), { message: "exactly one of interval or cron is required" });

export const AgentsSchema = z
  .object({
    agents: z.object(Object.fromEntries(AGENT_NAMES.map((n) => [n, AgentSchema]))).strict(),
  })
  .strict();

export const EngineSchema = z
  .object({
    enabled: z.boolean(),
    paper: z.boolean(),
    symbols: z.array(z.string().min(1)),
    sizeUsd: z.number().min(0),
    params: z.record(z.string(), z.unknown()),
  })
  .strict();

export const EnginesSchema = z
  .object({
    engines: z.object(Object.fromEntries(ENGINE_IDS.map((e) => [e, EngineSchema]))).strict(),
  })
  .strict();

const nonneg = z.number().min(0);
const pct = z.number().min(0).max(100);

export const RiskSchema = z
  .object({
    nav_usd_cap: z.number().positive(),
    max_net_delta_pct: pct,
    max_leverage: z.number().min(1),
    min_liq_distance_pct: pct,
    max_orders_per_sec: z.number().int().positive(),
    daily_drawdown_kill_pct: pct,
    nav_jump_alert_pct: pct,
    per_engine_max_notional_usd: z.object(Object.fromEntries(ENGINE_IDS.map((e) => [e, nonneg]))).strict(),
    onchain_max_notional_usd: nonneg,
    audit_ttl_sec: z.number().int().positive(),
    allowed_symbols: z
      .object({
        futures: z.array(z.string().min(1)),
        spot: z.array(z.string().min(1)),
        dex: z.array(z.string().min(1)),
      })
      .strict(),
    llm_daily_budget_usd: nonneg,
    data_daily_budget_usd: nonneg,
    transfer_max_usd_per_day: nonneg,
    kill_verify_attempts_before_alert: z.number().int().positive(),
  })
  .strict();

export const RouteSchema = z
  .object({ price_usd: nonneg, min: nonneg, max: nonneg })
  .strict()
  .refine((r) => r.min <= r.price_usd && r.price_usd <= r.max, { message: "expected min <= price_usd <= max" });

export const PricingSchema = z
  .object({
    network: z.string().regex(/^[a-z0-9]+:[A-Za-z0-9]+$/, "expected CAIP-2 network id like eip155:56"),
    asset: z.string().min(1),
    routes: z.record(z.string().startsWith("/"), RouteSchema),
  })
  .strict();

export type AgentConfig = z.infer<typeof AgentSchema>;
export type AgentsConfig = { agents: Record<AgentName, AgentConfig> };
export type EnginesConfig = { engines: Record<EngineId, EngineConfig> };
export type RiskConfig = z.infer<typeof RiskSchema>;
export type PricingConfig = z.infer<typeof PricingSchema>;

export interface Config {
  agents: AgentsConfig;
  engines: EnginesConfig;
  risk: RiskConfig;
  pricing: PricingConfig;
}

export type ConfigFile = "agents" | "engines" | "risk" | "pricing";
export const CONFIG_FILES: Record<ConfigFile, string> = {
  agents: "agents.yaml",
  engines: "engines.yaml",
  risk: "risk.yaml",
  pricing: "pricing.yaml",
};

const SCHEMAS: Record<ConfigFile, z.ZodType> = {
  agents: AgentsSchema,
  engines: EnginesSchema,
  risk: RiskSchema,
  pricing: PricingSchema,
};

export const BUDGET_KEYS = ["llm_daily_budget_usd", "data_daily_budget_usd"] as const;
export type BudgetPatch = Partial<Record<(typeof BUDGET_KEYS)[number], number>>;

export type EngineWriter = "operator" | "commander" | "coach";
const ENGINE_WRITERS: readonly EngineWriter[] = ["operator", "commander", "coach"];
/** `operator` (CLI) or `operator:<session8>` (dashboard, joins to `dashboard_audit.session`). */
export type OperatorActor = "operator" | `operator:${string}`;
const OPERATOR_ONLY = ["operator", "operator:<session>"] as const;
function isOperatorActor(actor: string): actor is OperatorActor {
  return actor === "operator" || (actor.startsWith("operator:") && actor.length > 9);
}

// ---- load -----------------------------------------------------------------

function issueList(issues: readonly z.core.$ZodIssue[]): string[] {
  const out: string[] = [];
  for (const i of issues) out.push(`${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
  return out;
}

function parseFile<T>(dir: string, file: ConfigFile, schema: z.ZodType<T>): { data?: T; problems: string[] } {
  const path = join(dir, CONFIG_FILES[file]);
  if (!existsSync(path)) return { problems: [`${path}: file not found`] };
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    return { problems: [`${path}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) return { problems: issueList(parsed.error.issues).map((p) => `${CONFIG_FILES[file]}: ${p}`) };
  return { data: parsed.data, problems: [] };
}

/** Loads and validates all four files; throws one ConfigError listing every issue. */
export function loadConfig(dir: string): Config {
  const agents = parseFile(dir, "agents", AgentsSchema);
  const engines = parseFile(dir, "engines", EnginesSchema);
  const risk = parseFile(dir, "risk", RiskSchema);
  const pricing = parseFile(dir, "pricing", PricingSchema);
  const problems = [...agents.problems, ...engines.problems, ...risk.problems, ...pricing.problems];
  if (problems.length > 0 || !agents.data || !engines.data || !risk.data || !pricing.data) throw new ConfigError(resolve(dir), problems);
  return { agents: agents.data as AgentsConfig, engines: engines.data as EnginesConfig, risk: risk.data, pricing: pricing.data };
}

/** Returns a copy of `agents` with HYDRA_MODEL_<AGENT> overrides applied to `model`. */
export function applyModelOverrides(agents: AgentsConfig, overrides: Partial<Record<AgentName, string>>): AgentsConfig {
  const out: Record<AgentName, AgentConfig> = { ...agents.agents };
  for (const name of AGENT_NAMES) {
    const model = overrides[name];
    if (model !== undefined) out[name] = { ...out[name], model };
  }
  return { agents: out };
}

// ---- write queue ----------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

type Patch = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Leaf paths of `patch` (objects recurse; arrays/scalars are leaves that replace wholesale). */
function leaves(patch: Patch, prefix: string[], out: Array<[string[], unknown]>): void {
  for (const key of Object.keys(patch)) {
    const v = patch[key];
    const path = [...prefix, key];
    if (isPlainObject(v)) leaves(v, path, out);
    else out.push([path, v]);
  }
}

function getPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const k of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

export interface WriteResult {
  hash: string;
  changed: boolean;
}

async function writeYaml(dir: string, file: ConfigFile, patch: Patch, actor: string, ledger: Ledger | undefined): Promise<WriteResult> {
  const path = join(dir, CONFIG_FILES[file]);
  const schema = SCHEMAS[file];
  const edits: Array<[string[], unknown]> = [];
  leaves(patch, [], edits);
  let expected = sha256(readFileSync(path, "utf8"));

  return enqueue(() => {
    for (let attempt = 0; ; attempt++) {
      const before = readFileSync(path, "utf8");
      const beforeHash = sha256(before);
      if (beforeHash !== expected && attempt === 0) {
        expected = beforeHash; // rebase once onto the concurrent write
        continue;
      }
      const doc = parseDocument(before);
      const prev = doc.toJS() as unknown;
      for (const [p, v] of edits) {
        if (v === undefined) doc.deleteIn(p);
        else doc.setIn(p, v);
      }
      const next = doc.toJS() as unknown;
      const parsed = schema.safeParse(next);
      if (!parsed.success) throw new ConfigError(CONFIG_FILES[file], issueList(parsed.error.issues));

      const diff: Record<string, { from: unknown; to: unknown }> = {};
      for (const [p, v] of edits) {
        const from = getPath(prev, p);
        if (JSON.stringify(from) !== JSON.stringify(v)) diff[p.join(".")] = { from, to: v };
      }
      const changed = Object.keys(diff).length > 0;
      const content = doc.toString();
      const afterHash = sha256(content);
      if (changed) {
        atomicWriteSync(path, content);
        ledger?.insertConfigChange({ actor, path, before_hash: beforeHash, after_hash: afterHash, diff: JSON.stringify(diff) });
        notifyWatchers(dir, file);
      }
      return { hash: afterHash, changed };
    }
  });
}

/** Deep patch of engines.yaml (`{engines: {liqfade: {enabled: true}}}` or `{liqfade: {...}}`). */
export function writeEngines(dir: string, patch: Patch, actor: EngineWriter, ledger?: Ledger): Promise<WriteResult> {
  if (!ENGINE_WRITERS.includes(actor)) throw new OwnerError(actor, CONFIG_FILES.engines, ENGINE_WRITERS);
  return writeYaml(dir, "engines", "engines" in patch ? patch : { engines: patch }, actor, ledger);
}

/** Deep patch of agents.yaml (`{agents: {commander: {model: 'x/y'}}}` or `{commander: {...}}`). */
export function writeAgents(dir: string, patch: Patch, actor: OperatorActor, ledger?: Ledger): Promise<WriteResult> {
  if (!isOperatorActor(actor)) throw new OwnerError(actor, CONFIG_FILES.agents, OPERATOR_ONLY);
  return writeYaml(dir, "agents", "agents" in patch ? patch : { agents: patch }, actor, ledger);
}

/** Operator-only; touches nothing but the two budget keys of risk.yaml. */
export function writeBudgets(dir: string, patch: BudgetPatch, actor: OperatorActor, ledger?: Ledger): Promise<WriteResult> {
  if (!isOperatorActor(actor)) throw new OwnerError(actor, CONFIG_FILES.risk, OPERATOR_ONLY);
  const problems: string[] = [];
  const clean: Patch = {};
  for (const key of Object.keys(patch)) {
    const v = (patch as Record<string, unknown>)[key];
    if (!(BUDGET_KEYS as readonly string[]).includes(key)) problems.push(`${key}: not an operator-writable key (allowed: ${BUDGET_KEYS.join(", ")})`);
    else if (typeof v !== "number" || !Number.isFinite(v) || v < 0) problems.push(`${key}: expected non-negative number`);
    else clean[key] = v;
  }
  if (problems.length > 0) throw new ConfigError(CONFIG_FILES.risk, problems);
  return writeYaml(dir, "risk", clean, actor, ledger);
}

// ---- watchers -------------------------------------------------------------

type ReloadCb<T> = (cfg: T, hash: string) => void;

interface Watcher {
  dir: string;
  file: "engines" | "agents";
  lastHash: string;
  timer: Timer | undefined;
  fs: FSWatcher | null;
  cb: ReloadCb<unknown>;
}

const watchers: Watcher[] = [];

function check(w: Watcher): void {
  const path = join(w.dir, CONFIG_FILES[w.file]);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return; // mid-rename; the next event re-checks
  }
  const hash = sha256(raw);
  if (hash === w.lastHash) return;
  const parsed = SCHEMAS[w.file].safeParse(parseYaml(raw) ?? {});
  if (!parsed.success) return; // invalid on-disk edit: keep the last good config
  w.lastHash = hash;
  bus.emit("config.reload", { file: w.file, hash });
  w.cb(parsed.data, hash);
}

function schedule(w: Watcher): void {
  clearTimeout(w.timer);
  w.timer = setTimeout(() => {
    w.timer = undefined;
    check(w);
  }, 100);
}

function notifyWatchers(dir: string, file: ConfigFile): void {
  const abs = resolve(dir);
  for (const w of watchers) if (w.file === file && w.dir === abs) check(w);
}

function watchFile<T>(dir: string, file: "engines" | "agents", cb: ReloadCb<T>): () => void {
  const abs = resolve(dir);
  const w: Watcher = { dir: abs, file, lastHash: "", timer: undefined, fs: null, cb: cb as ReloadCb<unknown> };
  const path = join(abs, CONFIG_FILES[file]);
  if (existsSync(path)) w.lastHash = sha256(readFileSync(path, "utf8"));
  // Watch the directory: atomic rename replaces the inode, which a per-file watch may lose.
  w.fs = watch(abs, { persistent: false }, (_event, filename) => {
    if (filename !== null && filename !== undefined && !String(filename).startsWith(CONFIG_FILES[file])) return;
    schedule(w);
  });
  w.fs.on("error", () => undefined);
  watchers.push(w);
  return () => {
    const i = watchers.indexOf(w);
    if (i >= 0) watchers.splice(i, 1);
    clearTimeout(w.timer);
    w.fs?.close();
    w.fs = null;
  };
}

export function watchEngines(dir: string, cb: ReloadCb<EnginesConfig>): () => void {
  return watchFile(dir, "engines", cb);
}

export function watchAgents(dir: string, cb: ReloadCb<AgentsConfig>): () => void {
  return watchFile(dir, "agents", cb);
}
