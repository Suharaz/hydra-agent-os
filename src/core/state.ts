// state/*.json helpers with owner enforcement. Each file has a closed set of actors that
// may write it; the check runs before any validation or I/O so a wrong actor never touches disk.
//
//   limits.json  — tighten-only overlay over risk.yaml caps; supervisor | guardian | operator
//   budgets.json — engine -> budget USD;                       treasurer  | operator
//   kill.lock    — written only by kill.ts (pseudo-actor "kill"); cleared only by operator

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { bus } from "./bus.ts";
import { ENGINE_IDS, VENUES, type Budgets, type KillActor, type KillLock, type Limits, type LimitsOverlay } from "./types.ts";

export class OwnerError extends Error {
  constructor(
    public readonly actor: string,
    public readonly target: string,
    public readonly allowed: readonly string[],
  ) {
    super(`actor "${actor}" may not write ${target} (allowed: ${allowed.join(" | ")})`);
    this.name = "OwnerError";
  }
}

export class StateError extends Error {
  constructor(
    public readonly target: string,
    public readonly problems: string[],
  ) {
    super(`invalid ${target}:\n  - ${problems.join("\n  - ")}`);
    this.name = "StateError";
  }
}

// ---- shared helpers (config.ts reuses these) ------------------------------

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Write `<path>.tmp` then rename over `path`; readers never observe a torn file. */
export function atomicWriteSync(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function assertActor(actor: string, target: string, allowed: readonly string[]): void {
  if (!allowed.includes(actor)) throw new OwnerError(actor, target, allowed);
}

function readJson<T>(path: string, schema: z.ZodType<T>, target: string): T | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return null;
  const parsed = schema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new StateError(target, parsed.error.issues.map(issueText));
  return parsed.data;
}

function issueText(i: z.core.$ZodIssue): string {
  return `${i.path.map(String).join(".") || "(root)"}: ${i.message}`;
}

function validate<T>(schema: z.ZodType<T>, value: unknown, target: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new StateError(target, parsed.error.issues.map(issueText));
  return parsed.data;
}

// ---- schemas --------------------------------------------------------------

const finite = z.number().finite();
const engineId = z.enum(ENGINE_IDS as [string, ...string[]]);

export const LimitsSchema = z
  .object({
    nav_usd_cap: finite.optional(),
    max_net_delta_pct: finite.optional(),
    max_leverage: finite.optional(),
    min_liq_distance_pct: finite.optional(),
    max_orders_per_sec: finite.optional(),
    daily_drawdown_kill_pct: finite.optional(),
    per_engine_max_notional_usd: z.object(Object.fromEntries(ENGINE_IDS.map((e) => [e, finite.optional()]))).strict().optional(),
    onchain_max_notional_usd: finite.optional(),
    engines_paused: z.union([z.literal("all"), z.array(engineId)]).optional(),
  })
  .strict();

export const LIMITS_KEYS: readonly (keyof Limits)[] = Object.keys(LimitsSchema.shape) as (keyof Limits)[];

const LIMITS_ACTORS = ["supervisor", "guardian", "operator"] as const;
export type LimitsActor = (typeof LIMITS_ACTORS)[number];

export const LimitsOverlaySchema = LimitsSchema.extend({
  actor: z.enum(LIMITS_ACTORS),
  reason: z.string().optional(),
  expires_at: z.number().finite().nullable(),
  updated_at: z.number().finite(),
}).strict();

export const BudgetsSchema = z.object(Object.fromEntries(ENGINE_IDS.map((e) => [e, z.number().finite().min(0).optional()]))).strict();

const BUDGETS_ACTORS = ["treasurer", "operator"] as const;
export type BudgetsActor = (typeof BUDGETS_ACTORS)[number];

const ResidueSchema = z.object({ symbol: z.string().min(1), qty: finite }).strict();
export const KillLockSchema = z
  .object({
    reason: z.string().min(1),
    at: z.number().finite(),
    residue: z.object(Object.fromEntries(VENUES.map((v) => [v, z.array(ResidueSchema)]))).strict(),
  })
  .strict();

const KILL_WRITE_ACTORS: readonly KillActor[] = ["kill"];
const KILL_CLEAR_ACTORS = ["operator"] as const;

// ---- paths ----------------------------------------------------------------

export const LIMITS_FILE = "limits.json";
export const BUDGETS_FILE = "budgets.json";
export const KILL_LOCK_FILE = "kill.lock";

// ---- limits.json ----------------------------------------------------------

/** Overlay body as written by callers; `actor` and `updated_at` are stamped by writeLimits. */
export type LimitsWrite = Limits & { reason?: string; expires_at: number | null };

export function readLimits(dir: string): LimitsOverlay | null {
  return readJson(join(dir, LIMITS_FILE), LimitsOverlaySchema, LIMITS_FILE) as LimitsOverlay | null;
}

export function writeLimits(dir: string, overlay: LimitsWrite, actor: LimitsActor): LimitsOverlay {
  assertActor(actor, LIMITS_FILE, LIMITS_ACTORS);
  const full = validate(LimitsOverlaySchema, { ...overlay, actor, updated_at: Date.now() }, LIMITS_FILE) as LimitsOverlay;
  const content = JSON.stringify(full, null, 2);
  atomicWriteSync(join(dir, LIMITS_FILE), content);
  bus.emit("limits.reload", { hash: sha256(content) });
  return full;
}

/** Operator-only removal of the overlay (limits revert to risk.yaml). */
export function clearLimits(dir: string, actor: "operator"): void {
  assertActor(actor, LIMITS_FILE, ["operator"]);
  rmSync(join(dir, LIMITS_FILE), { force: true });
  bus.emit("limits.reload", { hash: "" });
}

// ---- budgets.json ---------------------------------------------------------

export function readBudgets(dir: string): Budgets {
  return (readJson(join(dir, BUDGETS_FILE), BudgetsSchema, BUDGETS_FILE) as Budgets | null) ?? {};
}

export function writeBudgets(dir: string, budgets: Budgets, actor: BudgetsActor): Budgets {
  assertActor(actor, BUDGETS_FILE, BUDGETS_ACTORS);
  const clean = validate(BudgetsSchema, budgets, BUDGETS_FILE) as Budgets;
  const content = JSON.stringify(clean, null, 2);
  atomicWriteSync(join(dir, BUDGETS_FILE), content);
  bus.emit("budgets.reload", { hash: sha256(content) });
  return clean;
}

// ---- kill.lock ------------------------------------------------------------

export function readKillLock(dir: string): KillLock | null {
  return readJson(join(dir, KILL_LOCK_FILE), KillLockSchema, KILL_LOCK_FILE) as KillLock | null;
}

export function writeKillLock(dir: string, lock: KillLock, actor: KillActor): KillLock {
  assertActor(actor, KILL_LOCK_FILE, KILL_WRITE_ACTORS);
  const clean = validate(KillLockSchema, lock, KILL_LOCK_FILE) as KillLock;
  atomicWriteSync(join(dir, KILL_LOCK_FILE), JSON.stringify(clean, null, 2));
  return clean;
}

/** Returns true when a lock existed and was removed. */
export function clearKillLock(dir: string, actor: "operator"): boolean {
  assertActor(actor, KILL_LOCK_FILE, KILL_CLEAR_ACTORS);
  const path = join(dir, KILL_LOCK_FILE);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
