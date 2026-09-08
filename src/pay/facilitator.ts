// x402 v2 facilitators: the seller hands every PAYMENT-SIGNATURE to `verify` before serving and
// to `settle` after. `MockFacilitator` checks the EIP-3009 signature locally with viem and never
// touches a chain (demo); `B402Facilitator` (Binance, BSC) and `CdpFacilitator` (Coinbase, Base)
// forward to the real HTTP facilitators. Selected by `X402`.

import { createHash, createPrivateKey, randomBytes, sign as cryptoSign } from "node:crypto";
import { verifyTypedData } from "viem";
import type { Env } from "../core/env.ts";
import { logger } from "../core/log.ts";

const log = logger("pay.facilitator");

import type { PaymentPayload, PaymentRequired, PaymentRequirements, VerifyResponse, SettleResponse, Network } from "@x402/core/types";
import { z } from "zod";

export type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse };

export const Eip3009AuthorizationSchema = z.object({
  from: z.string(),
  to: z.string(),
  value: z.string(),
  validAfter: z.string(),
  validBefore: z.string(),
  nonce: z.string(),
});
export type Eip3009Authorization = z.infer<typeof Eip3009AuthorizationSchema>;

export interface SettleResult extends SettleResponse {
  /** B402: accepted but not yet mined when polling ran out. */
  pending?: boolean;
}

export interface Facilitator {
  readonly kind: "mock" | "b402" | "cdp";
  verify(req: PaymentPayload, reqs: PaymentRequirements): Promise<VerifyResponse>;
  settle(req: PaymentPayload, reqs: PaymentRequirements): Promise<SettleResult>;
}

export interface AssetInfo {
  address: string;
  name: string;
  version: string;
  decimals: number;
}

/** Tokens the seller can price in, per CAIP-2 network. */
export const ASSETS: Record<string, Record<string, AssetInfo>> = {
  "eip155:84532": { USDC: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2", decimals: 6 } },
  "eip155:8453": { USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2", decimals: 6 } },
  "eip155:56": {
    USDT: { address: "0x55d398326f99059fF775485246999027B3197955", name: "Tether USD", version: "1", decimals: 18 },
    USDC: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", name: "USD Coin", version: "2", decimals: 18 },
    U: { address: "0xcE24439F2D9C6a2289F741120FE202248B666666", name: "U", version: "1", decimals: 18 },
    USD1: { address: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d", name: "USD1", version: "1", decimals: 18 },
  },
};

export function assetInfo(network: string, symbol: string): AssetInfo {
  const a = ASSETS[network]?.[symbol];
  if (a === undefined) throw new Error(`no asset ${symbol} on ${network}`);
  return a;
}

/** Decimals of `asset` (an address) on `network`; 6 when unknown. */
export function assetDecimals(network: string, asset: string): number {
  for (const a of Object.values(ASSETS[network] ?? {})) if (a.address.toLowerCase() === asset.toLowerCase()) return a.decimals;
  return 6;
}

export const TRANSFER_WITH_AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function chainIdOf(network: string): number {
  const m = /^eip155:(\d+)$/.exec(network);
  if (m === null) throw new Error(`not an EVM network: ${network}`);
  return Number(m[1]);
}

export function encodeHeader(v: unknown): string {
  return Buffer.from(JSON.stringify(v), "utf8").toString("base64");
}

export function decodeHeader<T>(v: string): T {
  return JSON.parse(Buffer.from(v, "base64").toString("utf8")) as T;
}

function hex(v: string): `0x${string}` {
  return (v.startsWith("0x") ? v : `0x${v}`) as `0x${string}`;
}

// ---- mock -----------------------------------------------------------------

/** Demo facilitator: local EIP-712 verify, nonce replay set, fake tx hash; never broadcasts. */
export class MockFacilitator implements Facilitator {
  readonly kind = "mock" as const;
  private readonly used = new Map<string, "verified" | "settled">();
  constructor(private readonly now: () => number = Date.now) {}

  async verify(req: PaymentPayload, reqs: PaymentRequirements): Promise<VerifyResponse> {
    if (req.x402Version !== 2 || req.accepted.scheme !== "exact") return { isValid: false, invalidReason: "unsupported scheme/version" };
    
    // Payload's accepted must match the server's requirements for amount and payTo
    if (req.accepted.network !== reqs.network) return { isValid: false, invalidReason: "network mismatch" };
    if (req.accepted.payTo.toLowerCase() !== reqs.payTo.toLowerCase()) return { isValid: false, invalidReason: "payTo mismatch" };
    const authResult = Eip3009AuthorizationSchema.safeParse(req.payload.authorization);
    if (!authResult.success) return { isValid: false, invalidReason: "bad authorization format" };
    const a = authResult.data;
    if (a.to.toLowerCase() !== reqs.payTo.toLowerCase()) return { isValid: false, invalidReason: "payTo mismatch" };
    
    let value: bigint;
    try {
      value = BigInt(a.value);
    } catch {
      return { isValid: false, invalidReason: "bad value" };
    }
    if (value < BigInt(reqs.amount)) return { isValid: false, invalidReason: "insufficient amount" };
    
    const nowSec = Math.floor(this.now() / 1000);
    if (Number(a.validAfter) > nowSec) return { isValid: false, invalidReason: "not yet valid" };
    if (Number(a.validBefore) <= nowSec) return { isValid: false, invalidReason: "expired" };
    const key = `${req.accepted.network}:${a.from.toLowerCase()}:${a.nonce.toLowerCase()}`;
    if (this.used.has(key)) return { isValid: false, invalidReason: "nonce already used" };
    
    let ok = false;
    try {
      ok = await verifyTypedData({
        address: hex(a.from),
        domain: { name: String(reqs.extra?.name ?? ""), version: String(reqs.extra?.version ?? ""), chainId: chainIdOf(reqs.network), verifyingContract: hex(reqs.asset) },
        types: TRANSFER_WITH_AUTHORIZATION,
        primaryType: "TransferWithAuthorization",
        message: { from: hex(a.from), to: hex(a.to), value, validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: hex(a.nonce) },
        signature: hex(req.payload.signature as string),
      });
    } catch (err) {
      return { isValid: false, invalidReason: `signature: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!ok) return { isValid: false, invalidReason: "invalid signature" };
    
    this.used.set(key, "verified");
    return { isValid: true, payer: a.from };
  }

  settle(req: PaymentPayload, reqs: PaymentRequirements): Promise<SettleResult> {
    const authResult = Eip3009AuthorizationSchema.safeParse(req.payload.authorization);
    if (!authResult.success) return Promise.resolve({ success: false, errorReason: "bad authorization format", transaction: "", network: req.accepted.network as Network });
    const a = authResult.data;
    const key = `${req.accepted.network}:${a.from.toLowerCase()}:${a.nonce.toLowerCase()}`;
    if (this.used.get(key) === "settled") return Promise.resolve({ success: false, errorReason: "nonce already used", transaction: "", network: req.accepted.network as Network });
    this.used.set(key, "settled");
    const tx = `0x${createHash("sha256").update(`${req.accepted.network}|${a.from}|${a.nonce}|${req.payload.signature}`).digest("hex")}`;
    return Promise.resolve({ success: true, transaction: tx, network: req.accepted.network as Network, payer: a.from });
  }
}

// ---- HTTP facilitators ----------------------------------------------------

type FetchFn = typeof fetch;

async function postJson(fetchFn: FetchFn, url: string, body: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${text.slice(0, 200)}`);
  return text.length > 0 ? JSON.parse(text) : {};
}

function unwrap(json: unknown): Record<string, unknown> {
  if (typeof json !== "object" || json === null) return {};
  const o = json as Record<string, unknown>;
  return typeof o.data === "object" && o.data !== null ? (o.data as Record<string, unknown>) : o;
}

function toVerify(json: unknown): VerifyResponse {
  const o = unwrap(json);
  const isValid = o.isValid === true || o.valid === true;
  const invalidReason = typeof o.invalidReason === "string" ? o.invalidReason : typeof o.reason === "string" ? o.reason : undefined;
  const payer = typeof o.payer === "string" ? o.payer : undefined;
  return { isValid, ...(invalidReason !== undefined ? { invalidReason } : {}), ...(payer !== undefined ? { payer } : {}) };
}

function toSettle(json: unknown, network: string): SettleResponse {
  const o = unwrap(json);
  return {
    success: o.success === true,
    transaction: typeof o.transaction === "string" ? o.transaction : typeof o.tx === "string" ? o.tx : "",
    network: (typeof o.network === "string" ? o.network : network) as Network,
    ...(typeof o.payer === "string" ? { payer: o.payer } : {}),
    ...(typeof o.errorReason === "string" ? { errorReason: o.errorReason } : {}),
  };
}

export interface B402Options {
  baseUrl: string;
  clientId: string;
  accessToken: string;
  privateKeyPem: string;
  fetch?: FetchFn;
  /** Settle poll interval (ms); default 4000. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Binance B402 facilitator on BSC. Settle is async and polled at 3-5 s until success, terminal
 * failure, or `maxTimeoutSeconds` elapses.
 *
 * UNVERIFIED: the request signing (RSA-SHA256 over `jsonBody + timestamp`) and the `X-Tesla-*`
 * header names follow Binance merchant-API conventions; the B402 facilitator docs and base URL are
 * issued only with merchant onboarding and have not been exercised against a real endpoint. Treat
 * the first live `/verify` response as the contract check; do not claim settlement without a tx hash.
 */
export class B402Facilitator implements Facilitator {
  readonly kind = "b402" as const;
  private readonly fetchFn: FetchFn;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly opts: B402Options) {
    this.fetchFn = opts.fetch ?? fetch;
    this.pollMs = opts.pollMs ?? 4000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** UNVERIFIED header set (no primary source in the repo research); confirm against onboarding docs before live use. */
  private headers(body: string): Record<string, string> {
    const timestamp = String(Date.now());
    const signature = cryptoSign("RSA-SHA256", Buffer.from(body + timestamp, "utf8"), createPrivateKey(this.opts.privateKeyPem)).toString("base64");
    return {
      "Content-Type": "application/json",
      "X-Tesla-ClientId": this.opts.clientId,
      "X-Tesla-SignAccessToken": this.opts.accessToken,
      "X-Tesla-Timestamp": timestamp,
      "X-Tesla-Signature": signature
    };
  }

  private call(path: string, body: unknown): Promise<unknown> {
    const json = JSON.stringify(body);
    return postJson(this.fetchFn, `${this.opts.baseUrl.replace(/\/$/, "")}/papi/v2/b402/${path}`, json, this.headers(json));
  }

  async verify(req: PaymentPayload, reqs: PaymentRequirements): Promise<VerifyResponse> {
    return toVerify(await this.call("verify", { x402Version: 2, paymentPayload: req, paymentRequirements: reqs }));
  }

  async settle(req: PaymentPayload, reqs: PaymentRequirements): Promise<SettleResult> {
    const deadline = Date.now() + Math.max(this.pollMs, reqs.maxTimeoutSeconds * 1000);
    for (;;) {
      const r = toSettle(await this.call("settle", { x402Version: 2, paymentPayload: req, paymentRequirements: reqs }), reqs.network);
      if (r.success) return { success: true, transaction: r.transaction, network: r.network, ...(r.payer !== undefined ? { payer: r.payer } : {}) };
      if (r.transaction === "") return { success: false, transaction: "", network: r.network };
      if (Date.now() >= deadline) {
        log.warn("b402 settle still pending at deadline", { tx: r.transaction });
        return { success: false, transaction: r.transaction, network: r.network, pending: true };
      }
      await this.sleep(this.pollMs);
    }
  }
}

export interface CdpOptions {
  url: string;
  apiKeyId: string;
  /** ES256 private key PEM. */
  apiKeySecret: string;
  fetch?: FetchFn;
}

function b64url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Coinbase CDP facilitator (Base mainnet); requests carry a short-lived ES256 JWT. */
export class CdpFacilitator implements Facilitator {
  readonly kind = "cdp" as const;
  private readonly fetchFn: FetchFn;
  constructor(private readonly opts: CdpOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  private jwt(method: string, url: URL): string {
    const key = createPrivateKey(this.opts.apiKeySecret);
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid: this.opts.apiKeyId, nonce: randomBytes(16).toString("hex") })));
    const payload = b64url(Buffer.from(JSON.stringify({ iss: "cdp", sub: this.opts.apiKeyId, aud: ["cdp_service"], nbf: now, exp: now + 120, uris: [`${method} ${url.host}${url.pathname}`] })));
    const sig = b64url(cryptoSign(null, Buffer.from(`${header}.${payload}`), key));
    return `${header}.${payload}.${sig}`;
  }

  private call(path: string, body: unknown): Promise<unknown> {
    const url = new URL(`${this.opts.url.replace(/\/$/, "")}/${path}`);
    return postJson(this.fetchFn, url.toString(), JSON.stringify(body), { authorization: `Bearer ${this.jwt("POST", url)}` });
  }

  async verify(req: PaymentPayload, reqs: PaymentRequirements): Promise<VerifyResponse> {
    return toVerify(await this.call("verify", { x402Version: 2, paymentPayload: req, paymentRequirements: reqs }));
  }

  async settle(req: PaymentPayload, reqs: PaymentRequirements): Promise<SettleResult> {
    const r = toSettle(await this.call("settle", { x402Version: 2, paymentPayload: req, paymentRequirements: reqs }), reqs.network);
    return { success: r.success, transaction: r.transaction, network: r.network, ...(r.payer !== undefined ? { payer: r.payer } : {}) };
  }
}

export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

function need(penv: Record<string, string | undefined>, key: string): string {
  const v = penv[key];
  if (v === undefined || v.trim() === "") throw new Error(`X402=${penv.X402 ?? ""} requires ${key}`);
  return v;
}

/** Facilitator for `env.x402`; live variants read their credentials from `penv`. */
export function selectFacilitator(env: Pick<Env, "x402">, penv: Record<string, string | undefined> = process.env): Facilitator {
  switch (env.x402) {
    case "mock":
      return new MockFacilitator();
    case "b402":
      return new B402Facilitator({ baseUrl: need(penv, "B402_BASE_URL"), clientId: need(penv, "B402_CLIENT_ID"), accessToken: need(penv, "B402_ACCESS_TOKEN"), privateKeyPem: need(penv, "B402_PRIVATE_KEY_PEM").replace(/\\n/g, "\n") });
    case "cdp":
      return new CdpFacilitator({ url: penv.CDP_FACILITATOR_URL ?? CDP_FACILITATOR_URL, apiKeyId: need(penv, "CDP_API_KEY_ID"), apiKeySecret: need(penv, "CDP_API_KEY_SECRET") });
  }
}
