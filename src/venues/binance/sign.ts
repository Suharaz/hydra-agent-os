// HMAC-SHA256 request signing. The signed payload is the exact query string Binance receives,
// parameters in insertion order, then `recvWindow`, then `timestamp` (local wall + per-base offset).

import { createHmac } from "node:crypto";

export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Record<string, QueryValue>;

export const RECV_WINDOW_MS = 5000;

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** `a=1&b=x` with URL encoding; undefined/null values are skipped. */
export function encodeQuery(params: QueryParams): string {
  let out = "";
  for (const key in params) {
    const v = params[key];
    if (v === undefined || v === null) continue;
    if (out.length > 0) out += "&";
    out += `${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`;
  }
  return out;
}

/**
 * Query string with `recvWindow`, `timestamp` (= `nowMs + offsetMs`) and `signature` appended.
 * `nowMs` is injectable so tests get a fixed vector.
 */
export function signedQuery(params: QueryParams, secret: string, offsetMs: number, nowMs: number = Date.now()): string {
  const base = encodeQuery(params);
  const stamped = `${base.length > 0 ? `${base}&` : ""}recvWindow=${RECV_WINDOW_MS}&timestamp=${Math.round(nowMs + offsetMs)}`;
  return `${stamped}&signature=${hmacSha256Hex(secret, stamped)}`;
}

/** Spot WS-API signing: params sorted by key, HMAC over the encoded string (no recvWindow). */
export function signWsApiParams(params: Record<string, string | number | boolean>, secret: string): string {
  const keys = Object.keys(params).sort();
  let payload = "";
  for (const k of keys) {
    if (payload.length > 0) payload += "&";
    payload += `${k}=${encodeURIComponent(String(params[k]))}`;
  }
  return hmacSha256Hex(secret, payload);
}
