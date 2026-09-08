// Live on-chain adapter over the pinned `baw` CLI (`@binance/agentic-wallet`). Every call is
// `Bun.spawn([BAW_BIN, ...args, '--json'])`; never `npx baw`. `checkBawBin` refuses any binary
// whose adjacent package.json is not `@binance/agentic-wallet` >= 1.9.0.

import type { Subprocess } from "bun";
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path";
import { z } from "zod";
import { logger } from "../../core/log.ts";
import { nowNs } from "../../core/clock.ts";
import type { DexQuote, Intent, SmartMoneyEvent } from "../../core/types.ts";
import { mapTrackerPush, parsePair, type OnchainAdapter, type SwapResult, type WalletStatus } from "./adapter.ts";

const log = logger("onchain.baw");

export const BAW_PACKAGE = "@binance/agentic-wallet";
export const BAW_MIN_VERSION = "1.9.0";

const PackageJson = z.object({ name: z.string(), version: z.string() });

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.+-]/).map((x) => Number(x) || 0);
  const pb = b.replace(/^v/, "").split(/[.+-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface BawBinInfo {
  bin: string;
  resolved: string;
  packageDir: string;
  version: string;
}

/**
 * Resolves `bin` (following symlinks), walks up to the nearest package.json and requires
 * `name === "@binance/agentic-wallet"` and `version >= 1.9.0`. Throws otherwise.
 */
export function checkBawBin(bin: string): BawBinInfo {
  if (!existsSync(bin)) throw new Error(`BAW_BIN "${bin}" does not exist`);
  const resolved = realpathSync(bin);
  let dir = dirname(resolved);
  let pkgPath: string | null = null;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      pkgPath = candidate;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (pkgPath === null) throw new Error(`BAW_BIN "${bin}": no package.json found above ${resolved}`);
  const parsed = PackageJson.safeParse(JSON.parse(readFileSync(pkgPath, "utf8")));
  if (!parsed.success) throw new Error(`BAW_BIN "${bin}": ${pkgPath} lacks name/version`);
  const { name, version } = parsed.data;
  if (name !== BAW_PACKAGE) throw new Error(`BAW_BIN "${bin}" resolves to package "${name}", expected "${BAW_PACKAGE}"`);
  if (compareVersions(version, BAW_MIN_VERSION) < 0) throw new Error(`BAW_BIN "${bin}" is ${BAW_PACKAGE}@${version}; >= ${BAW_MIN_VERSION} required`);
  return { bin, resolved, packageDir: dirname(pkgPath), version };
}

export interface BawRunResult {
  ok: boolean;
  code: number;
  json: unknown;
  stderr: string;
}

export interface BawAdapterOptions {
  bin: string;
  /** Skip the package check (tests with a fake script). */
  skipCheck?: boolean;
  spawn?: typeof Bun.spawn;
  timeoutMs?: number;
}

const QuoteJson = z
  .object({
    price: z.union([z.string(), z.number()]).optional(),
    fromAmount: z.union([z.string(), z.number()]).optional(),
    toAmount: z.union([z.string(), z.number()]).optional(),
    gasUsd: z.union([z.string(), z.number()]).optional(),
    gasFeeUsd: z.union([z.string(), z.number()]).optional(),
  })
  .loose();

const StatusJson = z.object({ status: z.string().optional(), address: z.string().optional(), connected: z.boolean().optional() }).loose();

const SwapJson = z
  .object({
    txHash: z.string().optional(),
    hash: z.string().optional(),
    transactionHash: z.string().optional(),
    orderId: z.string().optional(),
    fromAmount: z.union([z.string(), z.number()]).optional(),
    toAmount: z.union([z.string(), z.number()]).optional(),
    gasUsd: z.union([z.string(), z.number()]).optional(),
    gasFeeUsd: z.union([z.string(), z.number()]).optional(),
  })
  .loose();

export class BawAdapter implements OnchainAdapter {
  readonly kind = "baw" as const;
  private readonly bin: string;
  private readonly spawnImpl: typeof Bun.spawn;
  private readonly timeoutMs: number;

  constructor(opts: BawAdapterOptions) {
    if (!opts.skipCheck) checkBawBin(opts.bin);
    this.bin = opts.bin;
    this.spawnImpl = opts.spawn ?? Bun.spawn;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** One-shot `baw <args> --json`; stdout parsed as JSON. */
  async run(args: string[]): Promise<BawRunResult> {
    const proc = this.spawnImpl([this.bin, ...args, "--json"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), this.timeoutMs);
    try {
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      let json: unknown = null;
      try {
        json = out.trim().length > 0 ? JSON.parse(out) : null;
      } catch {
        json = { raw: out };
      }
      return { ok: code === 0, code, json, stderr: err };
    } finally {
      clearTimeout(timer);
    }
  }

  async quote(pair: string): Promise<DexQuote> {
    const { base, quote, chain } = parsePair(pair);
    const r = await this.run(["market-order", "quote", "--binanceChainId", chain, "--fromToken", quote, "--toToken", base, "--fromTokenQty", "1"]);
    if (!r.ok) throw new Error(`baw market-order quote failed (${r.code}): ${r.stderr.slice(0, 200)}`);
    const body = QuoteJson.safeParse(unwrapData(r.json));
    if (!body.success) throw new Error("baw market-order quote: unexpected payload");
    const d = body.data;
    let price = d.price !== undefined ? Number(d.price) : NaN;
    if (!Number.isFinite(price) && d.fromAmount !== undefined && d.toAmount !== undefined) price = Number(d.fromAmount) / Number(d.toAmount);
    if (!Number.isFinite(price) || price <= 0) throw new Error("baw market-order quote: no price");
    const gasUsd = Number(d.gasUsd ?? d.gasFeeUsd ?? 0) || 0;
    // The aggregator quotes one executable price; spread is folded into it, so bid == ask.
    return { pair, chain, bid: price, ask: price, gasUsd, tsNs: nowNs() };
  }

  /** `market-order quote` then `swap`; refuses while the wallet is unpaired. */
  async swap(intent: Intent): Promise<SwapResult> {
    const status = await this.walletStatus();
    if (!status.connected) throw new Error("baw wallet not connected; run `hydra baw pair`");
    const { base, quote, chain } = parsePair(intent.symbol);
    const [from, to] = intent.side === "BUY" ? [quote, base] : [base, quote];
    const q = await this.quote(intent.symbol);
    const amount = intent.side === "BUY" ? intent.qty * q.ask : intent.qty;
    const r = await this.run(["market-order", "swap", "--binanceChainId", chain, "--fromToken", from, "--toToken", to, "--fromTokenQty", String(amount)]);
    if (!r.ok) throw new Error(`baw market-order swap failed (${r.code}): ${r.stderr.slice(0, 200)}`);
    const body = SwapJson.safeParse(unwrapData(r.json));
    if (!body.success) throw new Error("baw market-order swap: unexpected payload");
    const d = body.data;
    const tx = d.txHash ?? d.hash ?? d.transactionHash ?? d.orderId;
    if (tx === undefined) throw new Error("baw market-order swap: no tx hash");
    const fromAmt = d.fromAmount !== undefined ? Number(d.fromAmount) : amount;
    const toAmt = d.toAmount !== undefined ? Number(d.toAmount) : NaN;
    const price = Number.isFinite(toAmt) && toAmt > 0 ? (intent.side === "BUY" ? fromAmt / toAmt : toAmt / fromAmt) : q.ask;
    const qty = intent.side === "BUY" ? (Number.isFinite(toAmt) && toAmt > 0 ? toAmt : intent.qty) : intent.qty;
    const fee = Number(d.gasUsd ?? d.gasFeeUsd ?? q.gasUsd) || 0;
    log.info("swap sent", { intent: intent.id, tx, price, qty });
    return { txOrRef: String(tx), price, qty, fee };
  }

  async walletStatus(): Promise<WalletStatus> {
    const r = await this.run(["wallet", "status"]);
    if (!r.ok) return { connected: false };
    const parsed = StatusJson.safeParse(unwrapData(r.json));
    if (!parsed.success) return { connected: false };
    const s = parsed.data;
    const connected = s.connected ?? (s.status !== undefined && s.status !== "UNCONNECTED");
    return s.address !== undefined ? { connected, address: s.address } : { connected };
  }

  /** `baw tracker ws --smy --json` NDJSON -> SmartMoneyEvent. Restarts the process if it exits. */
  trackerStream(onEvent: (e: SmartMoneyEvent) => void): () => void {
    let stopped = false;
    let proc: Subprocess | null = null;
    let restartTimer: Timer | undefined;
    const launch = () => {
      if (stopped) return;
      proc = this.spawnImpl([this.bin, "tracker", "ws", "--smy", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const current = proc;
      void readLines(current.stdout as ReadableStream<Uint8Array>, (line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        const ev = mapTrackerPush(parsed, nowNs());
        if (ev !== null) onEvent(ev);
      }).then(
        () => current.exited,
        () => current.exited,
      ).then((code) => {
        if (stopped) return;
        log.warn("tracker ws exited; restarting in 5 s", { code });
        restartTimer = setTimeout(launch, 5000);
      });
    };
    launch();
    return () => {
      stopped = true;
      clearTimeout(restartTimer);
      proc?.kill();
    };
  }
}

function unwrapData(json: unknown): unknown {
  return typeof json === "object" && json !== null && "data" in json ? json.data : json;
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length > 0) onLine(line);
      nl = buf.indexOf("\n");
    }
  }
  if (buf.trim().length > 0) onLine(buf.trim());
}
