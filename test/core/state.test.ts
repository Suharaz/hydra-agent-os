import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bus } from "../../src/core/bus.ts";
import {
  OwnerError,
  StateError,
  clearKillLock,
  clearLimits,
  readBudgets,
  readKillLock,
  readLimits,
  writeBudgets,
  writeKillLock,
  writeLimits,
} from "../../src/core/state.ts";
import type { KillLock } from "../../src/core/types.ts";
import { cleanup, tempDir } from "./helpers.ts";

const dirs: string[] = [];
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  for (const d of dirs.splice(0)) cleanup(d);
});
function scratch(): string {
  const d = join(tempDir(), "state"); // nested: writers must mkdir
  dirs.push(d);
  return d;
}

const lock: KillLock = { reason: "drawdown", at: 1_700_000_000_000, residue: { futures: [{ symbol: "BTCUSDT", qty: 0.01 }], spot: [], dex: [] } };

describe("limits.json", () => {
  test("null when absent; supervisor/guardian/operator may write; others rejected", () => {
    const dir = scratch();
    expect(readLimits(dir)).toBeNull();
    for (const actor of ["commander", "treasurer", "coach", "sales", "system", "kill"] as const) {
      expect(() => writeLimits(dir, { max_leverage: 2, expires_at: null }, actor as never)).toThrow(OwnerError);
    }
    expect(existsSync(join(dir, "limits.json"))).toBe(false);

    const hashes: string[] = [];
    disposers.push(bus.on("limits.reload", (e) => hashes.push(e.hash)));
    const written = writeLimits(dir, { max_leverage: 2, engines_paused: ["basis"], reason: "vol spike", expires_at: null }, "supervisor");
    expect(written.actor).toBe("supervisor");
    expect(written.updated_at).toBeGreaterThan(0);
    const back = readLimits(dir);
    expect(back).toEqual(written);
    expect(hashes.length).toBe(1);

    writeLimits(dir, { engines_paused: "all", expires_at: Date.now() + 60_000 }, "guardian");
    expect(readLimits(dir)?.engines_paused).toBe("all");
    expect(readLimits(dir)?.max_leverage).toBeUndefined(); // overlay replaced, not merged

    expect(() => clearLimits(dir, "guardian" as never)).toThrow(OwnerError);
    clearLimits(dir, "operator");
    expect(readLimits(dir)).toBeNull();
    expect(hashes.length).toBe(3);
  });

  test("invalid overlay values rejected before any write", () => {
    const dir = scratch();
    expect(() => writeLimits(dir, { max_leverage: Number.NaN, expires_at: null }, "operator")).toThrow(StateError);
    expect(() => writeLimits(dir, { per_engine_max_notional_usd: { liqfade: Number.POSITIVE_INFINITY }, expires_at: null }, "operator")).toThrow(StateError);
    expect(() => writeLimits(dir, { engines_paused: ["nope"] as never, expires_at: null }, "operator")).toThrow(StateError);
    expect(existsSync(join(dir, "limits.json"))).toBe(false);
  });
});

describe("budgets.json", () => {
  test("empty when absent; treasurer/operator may write; unknown engine rejected", () => {
    const dir = scratch();
    expect(readBudgets(dir)).toEqual({});
    expect(() => writeBudgets(dir, { liqfade: 100 }, "commander" as never)).toThrow(OwnerError);
    expect(() => writeBudgets(dir, { liqfade: 100 }, "supervisor" as never)).toThrow(OwnerError);
    const hashes: string[] = [];
    disposers.push(bus.on("budgets.reload", (e) => hashes.push(e.hash)));
    writeBudgets(dir, { liqfade: 100, basis: 0 }, "treasurer");
    expect(readBudgets(dir)).toEqual({ liqfade: 100, basis: 0 });
    writeBudgets(dir, { cexdex: 5 }, "operator");
    expect(readBudgets(dir)).toEqual({ cexdex: 5 });
    expect(hashes.length).toBe(2);
    expect(() => writeBudgets(dir, { bogus: 1 } as never, "treasurer")).toThrow(StateError);
    expect(() => writeBudgets(dir, { liqfade: -1 }, "treasurer")).toThrow(StateError);
    expect(readBudgets(dir)).toEqual({ cexdex: 5 });
  });
});

describe("kill.lock", () => {
  test("null when absent; only `kill` writes; only operator clears", () => {
    const dir = scratch();
    expect(readKillLock(dir)).toBeNull();
    expect(() => writeKillLock(dir, lock, "operator" as never)).toThrow(OwnerError);
    expect(() => writeKillLock(dir, lock, "guardian" as never)).toThrow(OwnerError);
    expect(() => writeKillLock(dir, lock, "supervisor" as never)).toThrow(OwnerError);
    expect(existsSync(join(dir, "kill.lock"))).toBe(false);

    writeKillLock(dir, lock, "kill");
    expect(readKillLock(dir)).toEqual(lock);
    expect(JSON.parse(readFileSync(join(dir, "kill.lock"), "utf8"))).toEqual(lock);

    expect(() => clearKillLock(dir, "supervisor" as never)).toThrow(OwnerError);
    expect(() => clearKillLock(dir, "kill" as never)).toThrow(OwnerError);
    expect(readKillLock(dir)).toEqual(lock);
    expect(clearKillLock(dir, "operator")).toBe(true);
    expect(readKillLock(dir)).toBeNull();
    expect(clearKillLock(dir, "operator")).toBe(false);
  });

  test("malformed lock content is rejected on write and surfaced on read", () => {
    const dir = scratch();
    expect(() => writeKillLock(dir, { ...lock, residue: { futures: [] } } as never, "kill")).toThrow(StateError);
    writeKillLock(dir, lock, "kill");
    // A corrupted file must not silently read as "no lock" (kill state fails closed).
    writeFileSync(join(dir, "kill.lock"), '{"reason": 1}');
    expect(() => readKillLock(dir)).toThrow(StateError);
  });
});
