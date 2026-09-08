// Shared fetch transport for the two REST clients: URL/query assembly, HMAC signing with the
// per-base server-time offset, Binance error envelope -> BinanceError, one -1021 resync+retry,
// 429/418 surfaced with Retry-After so the executor can pause instead of hammering.

import { logger } from "../../core/log.ts";
import { encodeQuery, signedQuery, type QueryParams } from "./sign.ts";
import { TimeSync } from "./time-sync.ts";

const log = logger("binance.http");

export class BinanceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number,
    public readonly msg: string,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(`binance ${status} code=${code}: ${msg}`);
    this.name = "BinanceError";
  }
  get throttled(): boolean {
    return this.status === 429 || this.status === 418;
  }
}

export interface HttpOptions {
  baseUrl: string;
  key?: string;
  secret?: string;
  fetch?: typeof fetch;
  timeSync?: TimeSync;
  /** Path of the venue's `time` endpoint (relative to baseUrl), used for -1021 resync. */
  timePath: string;
  /** Called with the parsed X-MBX-USED-WEIGHT-1M value on every response (ok or error). */
  onWeight?: (used: number) => void;
}

export type Method = "GET" | "POST" | "PUT" | "DELETE";

export class BinanceHttp {
  readonly baseUrl: string;
  readonly timeSync: TimeSync;
  private readonly key: string | undefined;
  private readonly secret: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timePath: string;
  private readonly onWeight: ((used: number) => void) | undefined;

  constructor(opts: HttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.key = opts.key;
    this.secret = opts.secret;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeSync = opts.timeSync ?? new TimeSync();
    this.timePath = opts.timePath;
    this.onWeight = opts.onWeight;
  }

  get hasKeys(): boolean {
    return this.key !== undefined && this.secret !== undefined;
  }

  async serverTime(): Promise<number> {
    const r = (await this.request("GET", this.timePath)) as { serverTime: number };
    return r.serverTime;
  }

  async syncTime(): Promise<void> {
    await this.timeSync.refresh(this.baseUrl, () => this.serverTime());
  }

  /** Public (unsigned) request; API key header is still sent when present (USER_STREAM endpoints). */
  request(method: Method, path: string, params: QueryParams = {}): Promise<unknown> {
    return this.send(method, path, encodeQuery(params), false);
  }

  /** Signed (TRADE/USER_DATA) request; retries once after a -1021 with a fresh time offset. */
  async signed(method: Method, path: string, params: QueryParams = {}): Promise<unknown> {
    if (this.secret === undefined || this.key === undefined) throw new BinanceError(0, -2014, "API key/secret not configured");
    try {
      return await this.send(method, path, signedQuery(params, this.secret, this.timeSync.offsetFor(this.baseUrl)), true);
    } catch (err) {
      if (!(err instanceof BinanceError) || err.code !== -1021) throw err;
      log.warn("timestamp rejected (-1021); resyncing server time and retrying once", { base: this.baseUrl });
      await this.syncTime();
      return this.send(method, path, signedQuery(params, this.secret, this.timeSync.offsetFor(this.baseUrl)), true);
    }
  }

  private async send(method: Method, path: string, query: string, signedReq: boolean): Promise<unknown> {
    const url = query.length > 0 ? `${this.baseUrl}${path}?${query}` : `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (this.key !== undefined) headers["X-MBX-APIKEY"] = this.key;
    if (signedReq || method !== "GET") headers["Content-Type"] = "application/x-www-form-urlencoded";
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers });
    } catch (err) {
      throw new BinanceError(0, -1000, `network: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.onWeight !== undefined) {
      const w = res.headers.get("x-mbx-used-weight-1m") ?? res.headers.get("x-mbx-used-weight");
      if (w !== null && w !== "") this.onWeight(Number(w));
    }
    const text = await res.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        if (res.ok) throw new BinanceError(res.status, -1000, `non-JSON response: ${text.slice(0, 120)}`);
      }
    }
    if (res.ok) return body;
    const env = (body ?? {}) as { code?: number; msg?: string };
    const retryAfter = res.headers.get("Retry-After");
    const retryAfterMs = retryAfter !== null && retryAfter !== "" ? Number(retryAfter) * 1000 : res.status === 429 || res.status === 418 ? 60_000 : null;
    throw new BinanceError(res.status, env.code ?? -1000, env.msg ?? text.slice(0, 200) ?? res.statusText, retryAfterMs);
  }
}
