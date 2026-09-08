// Encrypted-at-rest secret store for UI-managed credentials. AES-256-GCM over a scrypt-derived key;
// the master passphrase never touches disk. The on-disk envelope carries only KDF parameters, the
// ciphertext, and the list of key NAMES present (so the dashboard can show status without the
// passphrase) — never any secret value. Boot layers decrypted values under process.env; explicit
// env vars always win. Keys apply on the next process start (see main.ts), matching the fail-fast
// env model: nothing is mutated live.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Credentials settable through the dashboard. Names mirror env vars so boot can layer them directly. */
export const SECRET_KEYS = [
  "BINANCE_SPOT_API_KEY",
  "BINANCE_SPOT_API_SECRET",
  "BINANCE_FUTURES_API_KEY",
  "BINANCE_FUTURES_API_SECRET",
  "OPENROUTER_API_KEY",
  "X402_DEMO_PRIVATE_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "ALERT_WEBHOOK_URL",
  "BAW_BIN",
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];
export type SecretMap = Partial<Record<SecretKey, string>>;

const SECRET_KEY_LOOKUP: Record<string, true> = Object.fromEntries(SECRET_KEYS.map((k) => [k, true]));
export function isSecretKey(k: string): k is SecretKey {
  return SECRET_KEY_LOOKUP[k] === true;
}

/** Minimum master passphrase length; enforced at the entry point that accepts it. */
export const MIN_PASSPHRASE = 12;

// scrypt cost: N=2^15 keeps derivation ~tens of ms while resisting brute force. maxmem must clear
// 128*N*r bytes (~33 MB) or Node rejects the call.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 } as const;
const FILENAME = "secrets.enc";

interface Envelope {
  v: 1;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string; // base64
  iv: string; // base64 (12 bytes)
  tag: string; // base64 (16 bytes)
  ct: string; // base64 ciphertext
  present: SecretKey[];
}

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsError";
  }
}

export function secretsPath(stateDir: string): string {
  return join(stateDir, FILENAME);
}

export function secretsExist(stateDir: string): boolean {
  return existsSync(secretsPath(stateDir));
}

function loadEnvelope(stateDir: string): Envelope | null {
  const path = secretsPath(stateDir);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new SecretsError(`corrupt secrets store at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const e = parsed as Envelope;
  if (e === null || typeof e !== "object" || e.v !== 1 || e.kdf !== "scrypt" || typeof e.ct !== "string") {
    throw new SecretsError(`unrecognized secrets store format at ${path}`);
  }
  return e;
}

/** Names of stored credentials without decrypting. Safe to expose to an authenticated operator. */
export function secretsPresent(stateDir: string): SecretKey[] {
  const e = loadEnvelope(stateDir);
  if (e === null) return [];
  return Array.isArray(e.present) ? e.present.filter(isSecretKey) : [];
}

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return scryptSync(passphrase, salt, SCRYPT.keylen, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT.maxmem });
}

/** Decrypt the store. Throws SecretsError on a wrong passphrase (GCM tag mismatch) or corruption. */
export function readSecrets(stateDir: string, passphrase: string): SecretMap {
  const e = loadEnvelope(stateDir);
  if (e === null) return {};
  const key = deriveKey(passphrase, Buffer.from(e.salt, "base64"), e);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
  decipher.setAuthTag(Buffer.from(e.tag, "base64"));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(e.ct, "base64")), decipher.final()]);
  } catch {
    throw new SecretsError("wrong passphrase or tampered secrets store");
  }
  let obj: unknown;
  try {
    obj = JSON.parse(plain.toString("utf8"));
  } catch {
    throw new SecretsError("decrypted secrets are not valid JSON");
  }
  const out: SecretMap = {};
  if (obj !== null && typeof obj === "object") {
    for (const [k, val] of Object.entries(obj as Record<string, unknown>)) {
      if (isSecretKey(k) && typeof val === "string" && val !== "") out[k] = val;
    }
  }
  return out;
}

/** True when `passphrase` decrypts the existing store (or no store exists yet). */
export function verifyPassphrase(stateDir: string, passphrase: string): boolean {
  if (!secretsExist(stateDir)) return true;
  try {
    readSecrets(stateDir, passphrase);
    return true;
  } catch {
    return false;
  }
}

/** Encrypt `map` under `passphrase` and atomically replace the store. Empty values are dropped. */
export function writeSecrets(stateDir: string, passphrase: string, map: SecretMap): SecretKey[] {
  const clean: SecretMap = {};
  for (const k of SECRET_KEYS) {
    const v = map[k];
    if (typeof v === "string" && v.trim() !== "") clean[k] = v;
  }
  const present = Object.keys(clean).filter(isSecretKey);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, SCRYPT);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(clean), "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: Envelope = {
    v: 1,
    kdf: "scrypt",
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
    present,
  };
  const path = secretsPath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 });
  renameSync(tmp, path);
  return present;
}

/**
 * Merge an existing store with `updates` and persist. A key set to "" is cleared; a key omitted is
 * preserved. Requires the current passphrase (verified by decrypting the existing store).
 */
export function mergeSecrets(stateDir: string, passphrase: string, updates: SecretMap): SecretKey[] {
  const existing = secretsExist(stateDir) ? readSecrets(stateDir, passphrase) : {};
  const merged: SecretMap = { ...existing };
  for (const k of SECRET_KEYS) {
    if (!(k in updates)) continue;
    const v = updates[k];
    if (typeof v === "string" && v.trim() !== "") merged[k] = v.trim();
    else delete merged[k];
  }
  return writeSecrets(stateDir, passphrase, merged);
}

/** Constant-time passphrase equality (used to keep a save consistent with the boot passphrase). */
export function passphraseEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
