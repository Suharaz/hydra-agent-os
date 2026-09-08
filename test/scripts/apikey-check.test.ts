// test/scripts/apikey-check.test.ts — Unit tests for checkApiKeyPermissions.
// Tests a fake apiRestrictions implementation; no network calls.

import { describe, expect, it } from "bun:test";
import { checkApiKeyPermissions } from "../../src/venues/binance/apikey-check.ts";
import type { ApiRestrictions } from "../../src/venues/binance/rest-spot.ts";

function makeRest(overrides: Partial<ApiRestrictions>) {
  const defaults: ApiRestrictions = {
    ipRestrict: true,
    enableWithdrawals: false,
    enableInternalTransfer: false,
    permitsUniversalTransfer: false,
    enableSpotAndMarginTrading: true,
    enableFutures: true,
  };
  const restrictions: ApiRestrictions = { ...defaults, ...overrides };
  return {
    apiRestrictions: () => Promise.resolve(restrictions),
  };
}

describe("checkApiKeyPermissions", () => {
  it("returns ok=true for a minimal safe key", async () => {
    const result = await checkApiKeyPermissions(makeRest({}));
    expect(result.ok).toBe(true);
    expect(result.problems).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.raw).toBeDefined();
  });

  it("returns problem when enableWithdrawals is true", async () => {
    const result = await checkApiKeyPermissions(makeRest({ enableWithdrawals: true }));
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.some((p) => p.toLowerCase().includes("withdrawal"))).toBe(true);
  });

  it("returns problem when permitsUniversalTransfer is true", async () => {
    const result = await checkApiKeyPermissions(makeRest({ permitsUniversalTransfer: true }));
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.some((p) => p.toLowerCase().includes("universal transfer"))).toBe(true);
  });

  it("returns both problems when both dangerous flags are true", async () => {
    const result = await checkApiKeyPermissions(
      makeRest({ enableWithdrawals: true, permitsUniversalTransfer: true }),
    );
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(2);
  });

  it("returns warning (not problem) when ipRestrict is false", async () => {
    const result = await checkApiKeyPermissions(makeRest({ ipRestrict: false }));
    expect(result.ok).toBe(true);
    expect(result.problems).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.toLowerCase().includes("ip whitelist") || w.toLowerCase().includes("iprestrict"))).toBe(true);
  });

  it("returns problem + warning when withdrawal enabled and no IP whitelist", async () => {
    const result = await checkApiKeyPermissions(
      makeRest({ enableWithdrawals: true, ipRestrict: false }),
    );
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });

  it("surfaces problem when apiRestrictions() rejects", async () => {
    const failRest = {
      apiRestrictions: () => Promise.reject(new Error("network timeout")),
    };
    const result = await checkApiKeyPermissions(failRest);
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems[0]).toContain("network timeout");
    expect(result.raw).toBeNull();
  });
  it("rejects malformed permission responses instead of interpreting absent flags as false", async () => {
    const rest = makeRest({});
    const incomplete = { ...rest, apiRestrictions: async () => ({}) as ApiRestrictions };
    expect((await checkApiKeyPermissions(incomplete)).ok).toBe(false);
    const invalid = { ...rest, apiRestrictions: async () => ({ enableWithdrawals: "false" }) as unknown as ApiRestrictions };
    expect((await checkApiKeyPermissions(invalid)).ok).toBe(false);
  });

  it("rejects internal transfer permission", async () => {
    expect((await checkApiKeyPermissions(makeRest({ enableInternalTransfer: true }))).ok).toBe(false);
  });
});
