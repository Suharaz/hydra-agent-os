// Spot REST (testnet.binance.vision/api or api.binance.com/api). Base URL includes `/api`;
// `/sapi/*` (live only) is derived by swapping the trailing segment.

import { BinanceHttp, type HttpOptions } from "./http.ts";
import type { CancelRef, DepthSnapshot, ExchangeInfo } from "./rest-futures.ts";
import type { QueryParams } from "./sign.ts";

export interface SpotOrderRow {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  price: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: string;
  timeInForce: string;
  type: string;
  side: "BUY" | "SELL";
  transactTime?: number;
  fills?: Array<{ price: string; qty: string; commission: string; commissionAsset: string; tradeId: number }>;
  [k: string]: unknown;
}

export interface SpotAccount {
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
  balances: Array<{ asset: string; free: string; locked: string }>;
  [k: string]: unknown;
}

export interface SpotMyTrade {
  symbol: string;
  id: number;
  orderId: number;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker: boolean;
  [k: string]: unknown;
}

export interface ApiRestrictions {
  ipRestrict: boolean;
  enableWithdrawals: boolean;
  enableInternalTransfer: boolean;
  permitsUniversalTransfer: boolean;
  enableSpotAndMarginTrading: boolean;
  enableFutures: boolean;
  [k: string]: unknown;
}

export interface SpotOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET";
  quantity: number | string;
  price?: number | string;
  timeInForce?: "GTC" | "IOC" | "FOK";
  newClientOrderId: string;
}

export type SpotRestOptions = Omit<HttpOptions, "timePath">;

export class SpotRest {
  readonly http: BinanceHttp;
  /** `/sapi` lives beside `/api` on the same host; built once, shares the time offset. */
  private readonly sapi: BinanceHttp;

  constructor(opts: SpotRestOptions) {
    this.http = new BinanceHttp({ ...opts, timePath: "/v3/time" });
    this.sapi = new BinanceHttp({ ...opts, baseUrl: this.http.baseUrl.replace(/\/api$/, ""), timePath: "/api/v3/time", timeSync: this.http.timeSync });
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  time(): Promise<number> {
    return this.http.serverTime();
  }

  syncTime(): Promise<void> {
    return this.http.syncTime();
  }

  exchangeInfo(): Promise<ExchangeInfo> {
    return this.http.request("GET", "/v3/exchangeInfo") as Promise<ExchangeInfo>;
  }

  depth(symbol: string, limit = 100): Promise<DepthSnapshot> {
    return this.http.request("GET", "/v3/depth", { symbol, limit }) as Promise<DepthSnapshot>;
  }

  myTrades(symbol: string, fromId?: number, limit = 1000): Promise<SpotMyTrade[]> {
    return this.http.signed("GET", "/v3/myTrades", { symbol, fromId, limit }) as Promise<SpotMyTrade[]>;
  }

  order(p: SpotOrderParams): Promise<SpotOrderRow> {
    const params: QueryParams = {
      symbol: p.symbol,
      side: p.side,
      type: p.type,
      quantity: p.quantity,
      price: p.price,
      timeInForce: p.timeInForce,
      newClientOrderId: p.newClientOrderId,
      newOrderRespType: "RESULT",
    };
    return this.http.signed("POST", "/v3/order", params) as Promise<SpotOrderRow>;
  }

  cancelOrder(symbol: string, ref: CancelRef): Promise<SpotOrderRow> {
    return this.http.signed("DELETE", "/v3/order", { symbol, orderId: ref.orderId, origClientOrderId: ref.origClientOrderId }) as Promise<SpotOrderRow>;
  }

  queryOrder(symbol: string, ref: CancelRef): Promise<SpotOrderRow> {
    return this.http.signed("GET", "/v3/order", { symbol, orderId: ref.orderId, origClientOrderId: ref.origClientOrderId }) as Promise<SpotOrderRow>;
  }

  cancelOpenOrders(symbol: string): Promise<SpotOrderRow[]> {
    return this.http.signed("DELETE", "/v3/openOrders", { symbol }) as Promise<SpotOrderRow[]>;
  }

  openOrders(symbol?: string): Promise<SpotOrderRow[]> {
    return this.http.signed("GET", "/v3/openOrders", { symbol }) as Promise<SpotOrderRow[]>;
  }

  account(): Promise<SpotAccount> {
    return this.http.signed("GET", "/v3/account", { omitZeroBalances: true }) as Promise<SpotAccount>;
  }

  /** `/sapi/v1/account/apiRestrictions`; no testnet equivalent exists (live only). */
  apiRestrictions(): Promise<ApiRestrictions> {
    if (/testnet/.test(this.baseUrl)) return Promise.reject(new Error("apiRestrictions: /sapi has no testnet; live only"));
    return this.sapi.signed("GET", "/sapi/v1/account/apiRestrictions") as Promise<ApiRestrictions>;
  }
}
