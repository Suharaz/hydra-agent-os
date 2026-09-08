// Buyer side of x402 v2: `x402fetch` retries a 402 once with a PAYMENT-SIGNATURE produced by a
// Signer. `LocalSigner` signs EIP-3009 authorizations with a raw key (demo); `BawSigner` shells
// the paired Binance agentic wallet (`baw x402-payment preview|sign`) so no key lives in HYDRA.

import { randomBytes } from "node:crypto";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import type { Payment } from "../core/types.ts";
import {
  assetDecimals,
  chainIdOf,
  decodeHeader,
  encodeHeader,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettleResponse,
  TRANSFER_WITH_AUTHORIZATION,
} from "./facilitator.ts";

export interface Signer {
  readonly address: string;
  /** Returns the PAYMENT-SIGNATURE header value for `reqs`. */
  sign(reqs: PaymentRequirements): Promise<string>;
}

export class PaymentRejected extends Error {
  constructor(
    reason: string,
    public readonly requirements: PaymentRequirements,
    public readonly usd: number,
  ) {
    super(reason);
    this.name = "PaymentRejected";
  }
}

/** Requirements from a 402 response, or null when it is not an x402 challenge. */
export function parseRequired(res: Response): PaymentRequired | null {
  if (res.status !== 402) return null;
  const h = res.headers.get("PAYMENT-REQUIRED");
  if (h === null) return null;
  try {
    return decodeHeader<PaymentRequired>(h);
  } catch {
    return null;
  }
}

/** Price of `reqs` in USD (stablecoin units). */
export function requirementsUsd(reqs: PaymentRequirements): number {
  return Number(reqs.amount) / 10 ** assetDecimals(reqs.network, reqs.asset);
}

export interface X402FetchOptions {
  fetch?: typeof fetch;
  /** Records the outbound payment once the seller confirms settlement. */
  ledger?: { insertPayment(p: Payment): unknown };
  /** Called before signing; return a rejection reason to refuse (throws PaymentRejected). */
  accept?: (reqs: PaymentRequirements, usd: number) => string | null;
}

export interface PaidResponse extends Response {
  payment?: SettleResponse;
}

/** GET/POST `url`; on 402, signs the `exact` requirement and replays once. */
export async function x402fetch(url: string, init: RequestInit | undefined, signer: Signer, opts: X402FetchOptions = {}): Promise<PaidResponse> {
  const fetchFn = opts.fetch ?? fetch;
  const first = await fetchFn(url, init);
  const prReq = parseRequired(first);
  if (prReq === null) return first;
  const reqs = prReq.accepts.find((a) => a.scheme === "exact");
  if (reqs === undefined) return first;
  
  const usd = requirementsUsd(reqs);
  const refusal = opts.accept?.(reqs, usd) ?? null;
  if (refusal !== null) throw new PaymentRejected(refusal, reqs, usd);
  const header = await signer.sign(reqs);
  const headers = new Headers(init?.headers);
  headers.set("PAYMENT-SIGNATURE", header);
  const res: PaidResponse = await fetchFn(url, { ...init, headers });
  const pr = res.headers.get("PAYMENT-RESPONSE");
  if (pr !== null) {
    const settled = decodeHeader<SettleResponse>(pr);
    res.payment = settled;
    if (settled.success && opts.ledger !== undefined) {
      opts.ledger.insertPayment({ direction: "out", counterparty: reqs.payTo, amount: usd, asset: reqs.asset, network: reqs.network, tx: settled.transaction, meta: { resource: prReq.resource?.url ?? url, payer: signer.address } });
    }
  }
  return res;
}

export class LocalSigner implements Signer {
  private readonly account: PrivateKeyAccount;
  readonly address: string;

  constructor(privateKeyHex: string, private readonly now: () => number = Date.now) {
    this.account = privateKeyToAccount((privateKeyHex.startsWith("0x") ? privateKeyHex : `0x${privateKeyHex}`) as `0x${string}`);
    this.address = this.account.address;
  }

  async sign(reqs: PaymentRequirements): Promise<string> {
    const nowSec = Math.floor(this.now() / 1000);
    const authorization = {
      from: this.address,
      to: reqs.payTo,
      value: reqs.amount,
      validAfter: "0",
      validBefore: String(nowSec + Math.max(60, reqs.maxTimeoutSeconds)),
      nonce: `0x${randomBytes(32).toString("hex")}`,
    };
    const signature = await this.account.signTypedData({
      domain: { name: String(reqs.extra?.name ?? ""), version: String(reqs.extra?.version ?? ""), chainId: chainIdOf(reqs.network), verifyingContract: reqs.asset as `0x${string}` },
      types: TRANSFER_WITH_AUTHORIZATION,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from as `0x${string}`,
        to: authorization.to as `0x${string}`,
        value: BigInt(authorization.value),
        validAfter: 0n,
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as `0x${string}`,
      },
    });
    const payload: PaymentPayload = { x402Version: 2, accepted: reqs, payload: { signature, authorization } };
    return encodeHeader(payload);
  }
}

/** Generates a throwaway demo key (never persisted). */
export function randomPrivateKey(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

interface PreviewJson {
  paymentId?: string;
  options?: Array<{ status?: string }>;
}

/** Signs through the paired `baw` wallet; `address` is the wallet's connected address (set via `connect`). */
export class BawSigner implements Signer {
  address: string;
  constructor(
    private readonly bawBin: string,
    address = "",
    private readonly spawnSync: typeof Bun.spawnSync = Bun.spawnSync,
  ) {
    this.address = address;
  }

  /** Resolves the wallet address from a paired adapter; throws when the wallet is not connected. */
  async connect(wallet: { walletStatus(): Promise<{ connected: boolean; address?: string }> }): Promise<void> {
    const status = await wallet.walletStatus();
    if (!status.connected || status.address === undefined) throw new Error("x402 live buyer requires a paired baw wallet: run `hydra baw pair`");
    this.address = status.address;
  }

  private run(args: string[]): Record<string, unknown> {
    const p = this.spawnSync([this.bawBin, ...args, "--json"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const out = new TextDecoder().decode(p.stdout);
    if (p.exitCode !== 0) throw new Error(`baw ${args.slice(0, 2).join(" ")} failed (${p.exitCode}): ${new TextDecoder().decode(p.stderr).slice(0, 200)}`);
    const json = JSON.parse(out) as Record<string, unknown>;
    return typeof json.data === "object" && json.data !== null ? (json.data as Record<string, unknown>) : json;
  }
  sign(reqs: PaymentRequirements): Promise<string> {
    const required: PaymentRequired = { x402Version: 2, resource: { url: "baw" }, accepts: [reqs] };
    const preview = this.run(["x402-payment", "preview", "--paymentRequirements", encodeHeader(required)]) as PreviewJson;
    const idx = (preview.options ?? []).findIndex((o) => o.status === "READY_TO_SIGN");
    if (preview.paymentId === undefined || idx < 0) return Promise.reject(new Error("baw x402-payment preview: nothing ready to sign"));
    const signed = this.run(["x402-payment", "sign", "--paymentId", preview.paymentId, "--selectedIndex", String(idx)]);
    const value = signed.paymentHeaderValue;
    if (typeof value !== "string") return Promise.reject(new Error("baw x402-payment sign: no paymentHeaderValue"));
    return Promise.resolve(value);
  }
}
