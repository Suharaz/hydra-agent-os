// One on-chain surface for engines/executor: PaperAdapter (demo) and BawAdapter (live) implement it.

import type { DexQuote, Intent, SmartMoneyEvent } from "../../core/types.ts";

export interface SwapResult {
  /** Tx hash (live) or paper reference id. */
  txOrRef: string;
  price: number;
  qty: number;
  fee: number;
}

export interface WalletStatus {
  connected: boolean;
  address?: string;
}

export interface OnchainAdapter {
  readonly kind: "paper" | "baw";
  /** `pair` is `BASE/QUOTE@chainId` (e.g. `BNB/USDT@56`); chain defaults to BSC when omitted. */
  quote(pair: string): Promise<DexQuote>;
  swap(intent: Intent): Promise<SwapResult>;
  walletStatus(): Promise<WalletStatus>;
  /** Starts the smart-money push stream; returns the unsubscribe function. */
  trackerStream(onEvent: (e: SmartMoneyEvent) => void): () => void;
}

export class NotImplemented extends Error {
  constructor(what: string) {
    super(`not implemented: ${what}`);
    this.name = "NotImplemented";
  }
}

export interface ParsedPair {
  base: string;
  quote: string;
  chain: string;
}

export function parsePair(pair: string): ParsedPair {
  const at = pair.indexOf("@");
  const chain = at >= 0 ? pair.slice(at + 1) : "56";
  const body = at >= 0 ? pair.slice(0, at) : pair;
  const slash = body.indexOf("/");
  if (slash <= 0) throw new Error(`invalid pair "${pair}"; expected BASE/QUOTE[@chainId]`);
  return { base: body.slice(0, slash), quote: body.slice(slash + 1), chain };
}

/**
 * Maps one `baw tracker ws --json` line (`{stream, data}`) to a SmartMoneyEvent; null when the
 * line is not a trade push. Field names follow the wallet-tracker skill's tx records.
 */
export function mapTrackerPush(line: unknown, tsNs: number): SmartMoneyEvent | null {
  if (typeof line !== "object" || line === null) return null;
  const rec: Record<string, unknown> = "data" in line && typeof line.data === "object" && line.data !== null ? (line.data as Record<string, unknown>) : (line as Record<string, unknown>);
  const wallet = str(rec.address) ?? str(rec.wallet);
  const token = str(rec.ca) ?? str(rec.contractAddress) ?? str(rec.token);
  if (wallet === null || token === null) return null;
  const chain = str(rec.chainId) ?? str(rec.chain) ?? "56";
  const usd = num(rec.txUsdValue) ?? num(rec.amountUsd) ?? num(rec.usd) ?? 0;
  const cat = num(rec.tradeSideCategory);
  let side: "BUY" | "SELL" | null = null;
  if (cat !== null) side = cat === 11 || cat === 19 ? "BUY" : cat === 21 || cat === 29 ? "SELL" : null;
  else {
    const s = (str(rec.side) ?? str(rec.tradeSide) ?? "").toUpperCase();
    side = s === "BUY" || s === "SELL" ? s : null;
  }
  if (side === null) return null;
  return { wallet, token, chain, side, amountUsd: usd, tsNs };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
