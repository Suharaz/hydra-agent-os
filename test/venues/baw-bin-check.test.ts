import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempDir } from "../core/helpers.ts";
import { BAW_MIN_VERSION, BAW_PACKAGE, checkBawBin, BawAdapter } from "../../src/venues/onchain/baw-adapter.ts";

const dirs: string[] = [];

/** `<tmp>/pkg/package.json` + `<tmp>/pkg/bin/baw.js`; returns the bin path. */
function fakePackage(name: string, version: string): string {
  const root = tempDir();
  dirs.push(root);
  const pkg = join(root, "pkg");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version }));
  const bin = join(pkg, "bin", "baw.js");
  writeFileSync(bin, "#!/usr/bin/env node\n");
  return bin;
}

afterAll(() => {
  for (const d of dirs) cleanup(d);
});

test("rejects a binary whose package is not @binance/agentic-wallet", () => {
  const bin = fakePackage("@evil/agentic-wallet", "9.9.9");
  expect(() => checkBawBin(bin)).toThrow(/expected "@binance\/agentic-wallet"/);
});

test("rejects a version below the minimum", () => {
  const bin = fakePackage(BAW_PACKAGE, "1.8.9");
  expect(() => checkBawBin(bin)).toThrow(/>= 1\.9\.0 required/);
});

test("accepts the right package at or above the minimum version", () => {
  const exact = checkBawBin(fakePackage(BAW_PACKAGE, BAW_MIN_VERSION));
  expect(exact.version).toBe(BAW_MIN_VERSION);
  const newer = checkBawBin(fakePackage(BAW_PACKAGE, "1.12.0"));
  expect(newer.version).toBe("1.12.0");
  expect(newer.packageDir.endsWith("pkg")).toBe(true);
});

test("rejects a missing binary", () => {
  expect(() => checkBawBin(join(tempDir(), "nope"))).toThrow(/does not exist/);
});

test("BawAdapter quote and swap use documented CLI arguments", async () => {
  const calls: string[][] = [];
  
  const fakeSpawn = (args: string[], _opts: unknown): unknown => {
    calls.push(args);
    return {
      stdout: new Blob([JSON.stringify({
        data: { price: "2000", fromAmount: "1", toAmount: "2000", gasUsd: "5", txHash: "0xabc" }
      })]).stream(),
      stderr: new Blob([""]).stream(),
      exited: Promise.resolve(0),
      kill: () => {},
    };
  };

  const adapter = new BawAdapter({ bin: "/fake/baw", skipCheck: true, spawn: fakeSpawn as unknown as typeof Bun.spawn });
  
  // Mock walletStatus internally to bypass `auth signin` check
  adapter.walletStatus = async () => ({ connected: true, address: "0x123" });
  await adapter.quote("ETH/USDC@8453");
  expect(calls[0]?.slice(1)).toEqual([
    "market-order", "quote", "--binanceChainId", "8453", "--fromToken", "USDC", "--toToken", "ETH", "--fromTokenQty", "1", "--json"
  ]);
  await adapter.swap({ id: "1", engine: "smmirror", venue: "dex", symbol: "ETH/USDC@8453", side: "BUY", qty: 0.5, type: "MARKET", ttlMs: 5000, paper: false, tSignalNs: 0 });
  expect(calls[2]?.slice(1)).toEqual([
    "market-order", "swap", "--binanceChainId", "8453", "--fromToken", "USDC", "--toToken", "ETH", "--fromTokenQty", "1000", "--json"
  ]);
});
