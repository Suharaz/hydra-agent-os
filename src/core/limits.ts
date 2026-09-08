// Effective limits combine risk.yaml with the limits.json overlay, always in the safer direction:
// caps take the minimum and `min_liq_distance_pct` (a floor) takes the maximum. `tighten()` validates
// every patched value against the *current effective* limits (not the yaml base), so a supervisor
// cannot loosen what a guardian pause or an earlier overlay set. Overlay expiry is ignored while a
// kill lock exists: a locked system never drifts looser on its own.

import type { RiskConfig } from "./config.ts";
import { readKillLock, readLimits, writeLimits, type LimitsActor } from "./state.ts";
import { ENGINE_IDS, type EngineId, type Limits, type LimitsOverlay } from "./types.ts";

export interface EffectiveLimits extends Limits {
  nav_usd_cap: number;
  max_net_delta_pct: number;
  max_leverage: number;
  min_liq_distance_pct: number;
  max_orders_per_sec: number;
  daily_drawdown_kill_pct: number;
  per_engine_max_notional_usd: Record<EngineId, number>;
  onchain_max_notional_usd: number;
  engines_paused: EngineId[] | "all";
}

export class TightenError extends Error {
  constructor(public readonly problems: string[]) {
    super(`limits overlay would loosen effective limits:\n  ${problems.join("\n  ")}`);
    this.name = "TightenError";
  }
}

const CAP_KEYS = ["nav_usd_cap", "max_net_delta_pct", "max_leverage", "max_orders_per_sec", "daily_drawdown_kill_pct", "onchain_max_notional_usd"] as const;
/** Higher is safer: liquidation must stay at least this far away. */
const FLOOR_KEYS = ["min_liq_distance_pct"] as const;
const NUMERIC_KEYS = [...CAP_KEYS, ...FLOOR_KEYS] as const;
type NumericKey = (typeof NUMERIC_KEYS)[number];

function loosens(k: NumericKey, candidate: number, current: number): boolean {
  return k === "min_liq_distance_pct" ? candidate < current : candidate > current;
}

/** True when the overlay is past `expires_at`; a kill lock freezes it in place. */
export function overlayExpired(overlay: LimitsOverlay, nowMs: number, killLocked: boolean): boolean {
  return overlay.expires_at !== null && !killLocked && nowMs >= overlay.expires_at;
}

export function effective(risk: RiskConfig, overlay: LimitsOverlay | null, nowMs: number, killLocked: boolean): EffectiveLimits {
  const o = overlay !== null && !overlayExpired(overlay, nowMs, killLocked) ? overlay : null;
  const perEngine = {} as Record<EngineId, number>;
  for (const e of ENGINE_IDS) {
    const base = risk.per_engine_max_notional_usd[e] ?? 0;
    const ov = o?.per_engine_max_notional_usd?.[e];
    perEngine[e] = ov === undefined ? base : Math.min(base, ov);
  }
  const out: EffectiveLimits = {
    nav_usd_cap: risk.nav_usd_cap,
    max_net_delta_pct: risk.max_net_delta_pct,
    max_leverage: risk.max_leverage,
    min_liq_distance_pct: risk.min_liq_distance_pct,
    max_orders_per_sec: risk.max_orders_per_sec,
    daily_drawdown_kill_pct: risk.daily_drawdown_kill_pct,
    per_engine_max_notional_usd: perEngine,
    onchain_max_notional_usd: risk.onchain_max_notional_usd,
    engines_paused: [],
  };
  if (o === null) return out;
  for (const k of NUMERIC_KEYS) {
    const v = o[k];
    if (v !== undefined && !loosens(k, v, out[k])) out[k] = v;
  }
  if (o.engines_paused !== undefined) out.engines_paused = o.engines_paused === "all" ? "all" : o.engines_paused.slice();
  return out;
}

export function isPaused(limits: EffectiveLimits, engine: EngineId): boolean {
  return limits.engines_paused === "all" || limits.engines_paused.includes(engine);
}

export type TightenPatch = Limits & { reason?: string; expires_at?: number | null };

/**
 * Validate `patch` against `current` (caps must be <= current, floors >= current; paused set may
 * only grow), merge it over the existing overlay and write limits.json as `actor`. Throws TightenError.
 */
export function tighten(dir: string, patch: TightenPatch, actor: LimitsActor, current: EffectiveLimits): LimitsOverlay {
  const problems: string[] = [];
  for (const k of NUMERIC_KEYS) {
    const v = patch[k];
    if (v !== undefined && loosens(k, v, current[k])) problems.push(`${k}: ${v} loosens effective ${current[k]}`);
  }
  if (patch.per_engine_max_notional_usd !== undefined) {
    for (const e of ENGINE_IDS) {
      const v = patch.per_engine_max_notional_usd[e];
      if (v !== undefined && v > current.per_engine_max_notional_usd[e]) {
        problems.push(`per_engine_max_notional_usd.${e}: ${v} > effective ${current.per_engine_max_notional_usd[e]}`);
      }
    }
  }
  if (patch.engines_paused !== undefined) {
    if (current.engines_paused === "all") {
      if (patch.engines_paused !== "all") problems.push("engines_paused: cannot un-pause from 'all'");
    } else if (patch.engines_paused !== "all") {
      for (const e of current.engines_paused) if (!patch.engines_paused.includes(e)) problems.push(`engines_paused: cannot un-pause ${e}`);
    }
  }
  if (problems.length > 0) throw new TightenError(problems);

  const existing = readLimits(dir);
  const killLocked = readKillLock(dir) !== null;
  const base = existing !== null && !overlayExpired(existing, Date.now(), killLocked) ? existing : null;
  const merged: Limits & { reason?: string; expires_at: number | null } = {
    expires_at: patch.expires_at !== undefined ? patch.expires_at : (base?.expires_at ?? null),
  };
  for (const k of NUMERIC_KEYS) {
    const v = patch[k] ?? base?.[k];
    if (v !== undefined) merged[k] = v;
  }
  const pe: Partial<Record<EngineId, number>> = {};
  let anyPe = false;
  for (const e of ENGINE_IDS) {
    const v = patch.per_engine_max_notional_usd?.[e] ?? base?.per_engine_max_notional_usd?.[e];
    if (v !== undefined) {
      pe[e] = v;
      anyPe = true;
    }
  }
  if (anyPe) merged.per_engine_max_notional_usd = pe;
  const paused = patch.engines_paused ?? base?.engines_paused;
  if (paused !== undefined) merged.engines_paused = paused;
  const reason = patch.reason ?? base?.reason;
  if (reason !== undefined) merged.reason = reason;
  return writeLimits(dir, merged, actor);
}

/** Guardian pause: every engine off until an operator clears the overlay. */
export function pauseAllEngines(dir: string, reason: string, current: EffectiveLimits): LimitsOverlay {
  return tighten(dir, { engines_paused: "all", reason, expires_at: null }, "guardian", current);
}
