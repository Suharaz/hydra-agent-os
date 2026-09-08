import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  MIN_PASSPHRASE,
  mergeSecrets,
  readSecrets,
  SecretsError,
  secretsExist,
  secretsPath,
  secretsPresent,
  verifyPassphrase,
  writeSecrets,
} from "../../src/core/secrets.ts";
import { cleanup, tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanup(d);
});
function scratch(): string {
  const d = tempDir();
  dirs.push(d);
  return d;
}

const PASS = "correct horse battery";

describe("secrets store", () => {
  test("round-trips a map under the passphrase", () => {
    const dir = scratch();
    writeSecrets(dir, PASS, { OPENROUTER_API_KEY: "sk-or-abc", BINANCE_SPOT_API_KEY: "k", BINANCE_SPOT_API_SECRET: "s" });
    expect(secretsExist(dir)).toBe(true);
    expect(readSecrets(dir, PASS)).toEqual({ OPENROUTER_API_KEY: "sk-or-abc", BINANCE_SPOT_API_KEY: "k", BINANCE_SPOT_API_SECRET: "s" });
  });

  test("a wrong passphrase cannot decrypt", () => {
    const dir = scratch();
    writeSecrets(dir, PASS, { OPENROUTER_API_KEY: "sk-or-abc" });
    expect(() => readSecrets(dir, "wrong passphrase here")).toThrow(SecretsError);
    expect(verifyPassphrase(dir, "wrong passphrase here")).toBe(false);
    expect(verifyPassphrase(dir, PASS)).toBe(true);
  });

  test("no secret value is written in the clear", () => {
    const dir = scratch();
    const secret = "sk-or-super-secret-value-xyz";
    writeSecrets(dir, PASS, { OPENROUTER_API_KEY: secret, TELEGRAM_BOT_TOKEN: "12345:tok" });
    const onDisk = readFileSync(secretsPath(dir), "utf8");
    expect(onDisk.includes(secret)).toBe(false);
    expect(onDisk.includes("12345:tok")).toBe(false);
  });

  test("present lists stored key names without the passphrase", () => {
    const dir = scratch();
    writeSecrets(dir, PASS, { OPENROUTER_API_KEY: "x", BAW_BIN: "/usr/bin/baw" });
    expect(secretsPresent(dir).sort()).toEqual(["BAW_BIN", "OPENROUTER_API_KEY"]);
  });

  test("blank and whitespace-only values are not stored", () => {
    const dir = scratch();
    writeSecrets(dir, PASS, { OPENROUTER_API_KEY: "keep", BINANCE_SPOT_API_KEY: "", BINANCE_SPOT_API_SECRET: "   " });
    expect(readSecrets(dir, PASS)).toEqual({ OPENROUTER_API_KEY: "keep" });
  });

  test("merge preserves omitted keys, overrides provided, and clears on whitespace", () => {
    const dir = scratch();
    writeSecrets(dir, PASS, { OPENROUTER_API_KEY: "old", BINANCE_SPOT_API_KEY: "keep-me" });
    const present = mergeSecrets(dir, PASS, { OPENROUTER_API_KEY: "new", TELEGRAM_CHAT_ID: "42", BINANCE_SPOT_API_KEY: " " });
    expect(present.sort()).toEqual(["OPENROUTER_API_KEY", "TELEGRAM_CHAT_ID"]);
    expect(readSecrets(dir, PASS)).toEqual({ OPENROUTER_API_KEY: "new", TELEGRAM_CHAT_ID: "42" });
  });

  test("reading or verifying a nonexistent store is a bootstrap, not an error", () => {
    const dir = scratch();
    expect(secretsExist(dir)).toBe(false);
    expect(readSecrets(dir, PASS)).toEqual({});
    expect(secretsPresent(dir)).toEqual([]);
    expect(verifyPassphrase(dir, "anything at all")).toBe(true);
  });

  test("MIN_PASSPHRASE is a sane floor", () => {
    expect(MIN_PASSPHRASE).toBeGreaterThanOrEqual(12);
  });
});
