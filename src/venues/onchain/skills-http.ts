// Binance Skills Hub public HTTP endpoints (no wallet, no auth). Real in demo and live.
// - audit(): POST .../security/token/audit  (query-token-audit SKILL.md, verified)
// - tokenInfo(): GET .../market/token/dynamic/info/ai  (query-token-info scripts/cli.mjs)
// - leaderboardScore(): GET .../market/leaderboard/query  (baw CLI's public endpoint)
// - tokenizedStock(): GET .../rwa/stock/detail/list/ai + /rwa/dynamic/ai  (tokenized-securities SKILL.md)
// Every result is cached with a TTL (default 10 min). `base: "off"` serves fixtures/audit.json
// and canned shapes so tests never touch the network.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { logger } from "../../core/log.ts";
import { realClock, type Clock } from "../binance/ws.ts";

const log = logger("skills.http");

export const AUDIT_PATH = "/bapi/defi/v1/public/wallet-direct/security/token/audit";
export const TOKEN_DYNAMIC_PATH = "/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info/ai";
export const LEADERBOARD_PATH = "/bapi/defi/v1/public/wallet-direct/market/leaderboard/query";
export const RWA_LIST_PATH = "/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai";
export const RWA_DYNAMIC_PATH = "/bapi/defi/v2/public/wallet-direct/buw/wallet/market/token/rwa/dynamic/ai";
/** Skills that live on www.binance.com rather than web3.binance.com. */
const RWA_BASE = "https://www.binance.com";

const USER_AGENT = "binance-web3/1.4 (Skill)";

export interface AuditResult {
  pass: boolean;
  /** `LOW` | `MEDIUM` | `HIGH` | `UNKNOWN` (no data / unsupported / HTTP error). */
  risk: string;
  raw: unknown;
}

export interface TokenInfo {
  price: number;
  volume24h: number;
  marketCap: number;
  liquidity: number;
  holders: number;
  raw: unknown;
}

export interface LeaderboardScore {
  found: boolean;
  rank: number | null;
  winRate: number | null;
  realizedPnl: number | null;
  /** 0-100 proxy of the skill's 6-dimension model: win-rate 60 % + pnl sign 40 %; null when not ranked. */
  score: number | null;
  raw: unknown;
}

export interface TokenizedStock {
  ticker: string;
  symbol: string;
  chainId: string;
  contractAddress: string;
  tokenPrice: number | null;
  sharesMultiplier: number;
  stockPrice: number | null;
  openState: boolean | null;
  raw: unknown;
}

export interface SkillsHttpOptions {
  /** `https://web3.binance.com` or `"off"` for fixture mode. */
  base: string;
  fetch?: typeof fetch;
  ttlMs?: number;
  clock?: Clock;
  /** fixtures/audit.json path (fixture mode). */
  auditFixture?: string;
}

const Envelope = z.object({ code: z.string().optional(), success: z.boolean().optional(), data: z.unknown() }).loose();

const AuditData = z
  .object({
    hasResult: z.boolean().optional(),
    isSupported: z.boolean().optional(),
    riskLevelEnum: z.string().optional(),
    riskLevel: z.number().optional(),
    riskItems: z.array(z.object({ id: z.string().optional(), details: z.array(z.object({ title: z.string().optional(), isHit: z.boolean().optional(), riskType: z.string().optional() }).loose()).optional() }).loose()).optional(),
  })
  .loose();

const numStr = z.union([z.string(), z.number(), z.null()]).optional();
const TokenDynamic = z.object({ price: numStr, volume24h: numStr, marketCap: numStr, liquidity: numStr, holders: numStr }).loose();
const LeaderboardRow = z.object({ address: z.string(), winRate: numStr, realizedPnl: numStr }).loose();
const LeaderboardData = z.object({ data: z.array(LeaderboardRow).optional() }).loose();
const RwaListRow = z.object({ chainId: z.string(), contractAddress: z.string(), symbol: z.string(), ticker: z.string(), multiplier: numStr }).loose();
const RwaDynamic = z
  .object({
    tokenInfo: z.object({ price: numStr, sharesMultiplier: numStr }).loose().optional(),
    stockInfo: z.object({ price: numStr }).loose().optional(),
    statusInfo: z.object({ openState: z.boolean().nullable().optional() }).loose().optional(),
  })
  .loose();

const AuditFixture = z.record(z.string(), z.unknown());

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

function toNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export class SkillsHttp {
  readonly offline: boolean;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly clock: Clock;
  private readonly auditFixture: string;
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(opts: SkillsHttpOptions) {
    this.offline = opts.base === "off";
    this.base = opts.base.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.clock = opts.clock ?? realClock;
    this.auditFixture = opts.auditFixture ?? "fixtures/audit.json";
  }

  private cached<T>(key: string, produce: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    const now = this.clock.nowMs();
    if (hit !== undefined && hit.expiresAt > now) return Promise.resolve(hit.value as T);
    return produce().then((value) => {
      this.cache.set(key, { value, expiresAt: this.clock.nowMs() + this.ttlMs });
      return value;
    });
  }

  private async call(url: string, init: RequestInit): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { "Content-Type": "application/json", "Accept-Encoding": "identity", "User-Agent": USER_AGENT, source: "agent", ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`skills http ${res.status} for ${url}`);
    const env = Envelope.safeParse(await res.json());
    if (!env.success) throw new Error(`skills http: unexpected envelope for ${url}`);
    if (env.data.success === false) throw new Error(`skills http: success=false code=${env.data.code ?? "?"} for ${url}`);
    return env.data.data;
  }

  /**
   * Token security audit. `pass` is true only when the audit has data, the token is supported,
   * risk is LOW/MEDIUM (level <= 3) and no `RISK`-type item is hit. Any HTTP failure yields
   * `{pass: false, risk: "UNKNOWN"}` (kernel rule 9 then vetoes, which is the safe direction).
   */
  audit(token: string, chainId = "56"): Promise<AuditResult> {
    const key = `audit:${chainId}:${token.toLowerCase()}`;
    const hit = this.cache.get(key);
    const now = this.clock.nowMs();
    if (hit !== undefined && hit.expiresAt > now) return Promise.resolve(hit.value as AuditResult);
    
    return (async () => {
      if (this.offline) return this.auditFromFixture(token);
      let res: AuditResult;
      try {
        const raw = await this.call(`${this.base}${AUDIT_PATH}`, {
          method: "POST",
          body: JSON.stringify({ binanceChainId: chainId, contractAddress: token, requestId: crypto.randomUUID() }),
        });
        res = SkillsHttp.gradeAudit(raw);
      } catch (err) {
        log.warn("audit failed", { token, error: err instanceof Error ? err.message : String(err) });
        return { pass: false, risk: "UNKNOWN", raw: null };
      }
      if (res.raw !== null) {
        this.cache.set(key, { value: res, expiresAt: this.clock.nowMs() + this.ttlMs });
      }
      return res;
    })();
  }

  static gradeAudit(raw: unknown): AuditResult {
    const parsed = AuditData.safeParse(raw);
    if (!parsed.success || parsed.data.hasResult !== true || parsed.data.isSupported !== true) return { pass: false, risk: "UNKNOWN", raw };
    const d = parsed.data;
    const risk = d.riskLevelEnum ?? "UNKNOWN";
    const level = d.riskLevel ?? 5;
    let hit = false;
    for (const item of d.riskItems ?? []) for (const det of item.details ?? []) if (det.isHit === true && det.riskType === "RISK") hit = true;
    return { pass: level <= 3 && risk !== "HIGH" && !hit, risk, raw };
  }

  private auditFromFixture(token: string): AuditResult {
    const parsed = AuditFixture.safeParse(JSON.parse(readFileSync(this.auditFixture, "utf8")));
    if (!parsed.success) return { pass: false, risk: "UNKNOWN", raw: null };
    const table = parsed.data;
    const raw = table[token.toLowerCase()] ?? table[token] ?? table.default;
    return raw === undefined ? { pass: false, risk: "UNKNOWN", raw: null } : SkillsHttp.gradeAudit(raw);
  }

  /** Real-time market data for a token (price/volume/liquidity/holders). */
  tokenInfo(token: string, chainId = "56"): Promise<TokenInfo> {
    return this.cached(`info:${chainId}:${token.toLowerCase()}`, async () => {
      if (this.offline) return { price: 0, volume24h: 0, marketCap: 0, liquidity: 0, holders: 0, raw: null };
      const raw = await this.call(`${this.base}${TOKEN_DYNAMIC_PATH}?chainId=${encodeURIComponent(chainId)}&contractAddress=${encodeURIComponent(token)}`, { method: "GET" });
      const d = TokenDynamic.safeParse(raw);
      if (!d.success) throw new Error("tokenInfo: unexpected payload");
      return { price: toNum(d.data.price), volume24h: toNum(d.data.volume24h), marketCap: toNum(d.data.marketCap), liquidity: toNum(d.data.liquidity), holders: toNum(d.data.holders), raw };
    });
  }

  /**
   * Scans the public leaderboard (top `pages` x 20 by PnL, 7d) for `address`. The skill's full
   * 6-dimension model runs inside the baw CLI; this is a proxy from the public rows only.
   */
  leaderboardScore(address: string, chainId = "56", pages = 5): Promise<LeaderboardScore> {
    const target = address.toLowerCase();
    return this.cached(`lb:${chainId}:${target}`, async () => {
      if (this.offline) return { found: false, rank: null, winRate: null, realizedPnl: null, score: null, raw: null };
      for (let page = 0; page < pages; page++) {
        const qs = `chainId=${encodeURIComponent(chainId)}&period=7d&tag=ALL&sortBy=0&orderBy=0&pageNo=${page}&pageSize=20`;
        const raw = await this.call(`${this.base}${LEADERBOARD_PATH}?${qs}`, { method: "GET" });
        const d = LeaderboardData.safeParse(raw);
        const rows = d.success ? (d.data.data ?? []) : [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i] as z.infer<typeof LeaderboardRow>;
          if (row.address.toLowerCase() !== target) continue;
          const winRate = toNum(row.winRate);
          const pnl = toNum(row.realizedPnl);
          const score = Math.round(Math.min(100, Math.max(0, winRate)) * 0.6 + (pnl > 0 ? 40 : 0));
          return { found: true, rank: page * 20 + i + 1, winRate, realizedPnl: pnl, score, raw: row };
        }
        if (rows.length < 20) break;
      }
      return { found: false, rank: null, winRate: null, realizedPnl: null, score: null, raw: null };
    });
  }

  /** Ondo tokenized US stock: list lookup by ticker, then dynamic data (price, multiplier, status). */
  tokenizedStock(ticker: string): Promise<TokenizedStock | null> {
    const t = ticker.toUpperCase();
    return this.cached(`rwa:${t}`, async () => {
      if (this.offline) return null;
      const list = await this.call(`${RWA_BASE}${RWA_LIST_PATH}?type=1`, { method: "GET" });
      const rows = z.array(RwaListRow).safeParse(list);
      if (!rows.success) throw new Error("tokenizedStock: unexpected list payload");
      const row = rows.data.find((r) => r.ticker.toUpperCase() === t) ?? null;
      if (row === null) return null;
      const dyn = await this.call(`${RWA_BASE}${RWA_DYNAMIC_PATH}?chainId=${encodeURIComponent(row.chainId)}&contractAddress=${encodeURIComponent(row.contractAddress)}`, { method: "GET" });
      const d = RwaDynamic.safeParse(dyn);
      const tokenInfo = d.success ? d.data.tokenInfo : undefined;
      const stockInfo = d.success ? d.data.stockInfo : undefined;
      const statusInfo = d.success ? d.data.statusInfo : undefined;
      return {
        ticker: row.ticker,
        symbol: row.symbol,
        chainId: row.chainId,
        contractAddress: row.contractAddress,
        tokenPrice: tokenInfo?.price === undefined || tokenInfo.price === null ? null : toNum(tokenInfo.price),
        sharesMultiplier: toNum(tokenInfo?.sharesMultiplier ?? row.multiplier) || 1,
        stockPrice: stockInfo?.price === undefined || stockInfo.price === null ? null : toNum(stockInfo.price),
        openState: statusInfo?.openState ?? null,
        raw: dyn,
      };
    });
  }

  clearCache(): void {
    this.cache.clear();
  }
}
