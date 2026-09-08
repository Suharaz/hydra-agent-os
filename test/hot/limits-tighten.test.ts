import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/core/config.ts";
import { TightenError, effective, tighten } from "../../src/core/limits.ts";
import { readKillLock, readLimits, writeKillLock, writeLimits } from "../../src/core/state.ts";
import { REPO_CONFIG, cleanup, tempDir } from "../core/helpers.ts";

const RISK = loadConfig(REPO_CONFIG).risk; // max_leverage 3, max_orders_per_sec 8

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanup(d);
});
function dir(): string {
  const d = tempDir();
  dirs.push(d);
  return d;
}

function current(d: string, nowMs: number) {
  return effective(RISK, readLimits(d), nowMs, readKillLock(d) !== null);
}

describe("limits.tighten", () => {
  test("overlay looser than the current effective limits is rejected", () => {
    const d = dir();
    const now = Date.now();
    tighten(d, { max_leverage: 2, engines_paused: ["basis"] }, "supervisor", current(d, now));
    expect(current(d, now).max_leverage).toBe(2);
    // Looser than the overlay although tighter than risk.yaml.
    expect(() => tighten(d, { max_leverage: 2.5 }, "supervisor", current(d, now))).toThrow(TightenError);
    // Un-pausing is loosening too.
    expect(() => tighten(d, { engines_paused: [] }, "supervisor", current(d, now))).toThrow(TightenError);
    // Tighter still is fine and keeps the earlier keys.
    const merged = tighten(d, { max_orders_per_sec: 4 }, "supervisor", current(d, now));
    expect(merged.max_leverage).toBe(2);
    expect(merged.engines_paused).toEqual(["basis"]);
    expect(current(d, now).max_orders_per_sec).toBe(4);
  });

  test("expires_at is ignored while kill-locked", () => {
    const d = dir();
    const now = Date.now();
    writeLimits(d, { max_leverage: 1.5, expires_at: now - 1, reason: "test" }, "supervisor");
    expect(effective(RISK, readLimits(d), now, false).max_leverage).toBe(3);
    writeKillLock(d, { reason: "test", at: now, residue: { futures: [], spot: [], dex: [] } }, "kill");
    expect(current(d, now).max_leverage).toBe(1.5);
    // Merge base: an expired overlay is still the base for a new tighten while locked.
    const merged = tighten(d, { max_orders_per_sec: 2 }, "supervisor", current(d, now));
    expect(merged.max_leverage).toBe(1.5);
  });

  test("kill.lock survives an overlay write", () => {
    const d = dir();
    const now = Date.now();
    const lock = writeKillLock(d, { reason: "drawdown", at: now, residue: { futures: [{ symbol: "BTCUSDT", qty: 0.01 }], spot: [], dex: [] } }, "kill");
    writeLimits(d, { engines_paused: "all", expires_at: null, reason: "guardian pause" }, "guardian");
    tighten(d, { max_leverage: 1 }, "supervisor", current(d, now));
    expect(readKillLock(d)).toEqual(lock);
    expect(current(d, now).engines_paused).toBe("all");
  });
});
