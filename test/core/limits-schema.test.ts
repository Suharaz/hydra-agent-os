import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { RiskSchema } from "../../src/core/config.ts";
import { LIMITS_KEYS, LimitsSchema, StateError, writeLimits } from "../../src/core/state.ts";
import { REPO_CONFIG, cleanup, tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanup(d);
});

const risk = parseYaml(readFileSync(join(REPO_CONFIG, "risk.yaml"), "utf8")) as Record<string, unknown>;

describe("RiskSchema", () => {
  test("repo risk.yaml is valid", () => {
    expect(RiskSchema.safeParse(risk).success).toBe(true);
  });

  test("allowed_symbols and each venue list are required", () => {
    const { allowed_symbols: _a, ...without } = risk;
    expect(RiskSchema.safeParse(without).success).toBe(false);
    expect(RiskSchema.safeParse({ ...risk, allowed_symbols: { futures: [], spot: [] } }).success).toBe(false);
    expect(RiskSchema.safeParse({ ...risk, allowed_symbols: { futures: [], spot: [], dex: [], perp: [] } }).success).toBe(false);
  });

  test("unknown keys and out-of-range values rejected", () => {
    expect(RiskSchema.safeParse({ ...risk, surprise: 1 }).success).toBe(false);
    expect(RiskSchema.safeParse({ ...risk, max_leverage: 0.5 }).success).toBe(false);
    expect(RiskSchema.safeParse({ ...risk, daily_drawdown_kill_pct: 101 }).success).toBe(false);
    expect(RiskSchema.safeParse({ ...risk, per_engine_max_notional_usd: { liqfade: 1 } }).success).toBe(false);
  });
});

describe("limits overlay", () => {
  test("overlay keys are exactly the tighten-able risk caps", () => {
    const riskKeys = new Set(Object.keys(RiskSchema.shape));
    for (const k of LIMITS_KEYS) {
      if (k === "engines_paused") continue;
      expect(riskKeys.has(k)).toBe(true);
    }
    // Budget/whitelist/transfer keys are never overlay-able by an agent.
    for (const k of ["allowed_symbols", "llm_daily_budget_usd", "data_daily_budget_usd", "transfer_max_usd_per_day", "audit_ttl_sec"]) {
      expect(LimitsSchema.safeParse({ [k]: 1 }).success).toBe(false);
    }
  });

  test("writeLimits rejects unknown key and leaves no file", () => {
    const dir = tempDir();
    dirs.push(dir);
    expect(() => writeLimits(dir, { allowed_symbols: { futures: [] }, expires_at: null } as never, "supervisor")).toThrow(StateError);
    expect(() => writeLimits(dir, { max_leverage: 2, bogus: 1, expires_at: null } as never, "supervisor")).toThrow(StateError);
    expect(existsSync(join(dir, "limits.json"))).toBe(false);
    writeLimits(dir, { max_leverage: 2, expires_at: null }, "supervisor");
    expect(existsSync(join(dir, "limits.json"))).toBe(true);
  });
});
