// USDⓈ-M futures REST (demo-fapi / fapi). Hot-path client: no SDK, one fetch per call.

import { BinanceHttp, type HttpOptions } from "./http.ts";
import type { QueryParams } from "./sign.ts";

export interface FuturesOrderRow {
  orderId: number;
  symbol: string;
  status: string;
  clientOrderId: string;
  price: string;
  avgPrice: string;
  origQty: string;
  executedQty: string;
  cumQuote: string;
  timeInForce: string;
  type: string;
  reduceOnly: boolean;
  closePosition: boolean;
  side: "BUY" | "SELL";
  positionSide: string;
  stopPrice: string;
  updateTime: number;
  [k: string]: unknown;
}

export interface FuturesPositionRow {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  notional: string;
  positionSide: string;
  updateTime: number;
  [k: string]: unknown;
}

export interface FuturesAccount {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  availableBalance: string;
  assets: Array<{ asset: string; walletBalance: string; unrealizedProfit: string; availableBalance: string; [k: string]: unknown }>;
  positions: Array<{ symbol: string; positionAmt: string; entryPrice: string; unrealizedProfit: string; leverage: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface FuturesUserTrade {
  id: number;
  orderId: number;
  symbol: string;
  side: "BUY" | "SELL";
  price: string;
  qty: string;
  quoteQty: string;
  realizedPnl: string;
  commission: string;
  commissionAsset: string;
  time: number;
  buyer: boolean;
  maker: boolean;
  positionSide: string;
  [k: string]: unknown;
}

export interface DepthSnapshot {
  lastUpdateId: number;
  E?: number;
  T?: number;
  bids: [string, string][];
  asks: [string, string][];
}

export interface Ticker24h {
  symbol: string;
  lastPrice: string;
  volume: string;
  quoteVolume: string;
  [k: string]: unknown;
}

export interface PremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
  [k: string]: unknown;
}

export interface ExchangeInfo {
  symbols: Array<{
    symbol: string;
    status: string;
    filters: Array<{ filterType: string; [k: string]: unknown }>;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

export interface FuturesOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  quantity?: number | string;
  price?: number | string;
  timeInForce?: "GTC" | "IOC" | "FOK" | "GTX";
  reduceOnly?: boolean;
  newClientOrderId: string;
  stopPrice?: number | string;
  closePosition?: boolean;
}

export type CancelRef = { orderId: number; origClientOrderId?: undefined } | { origClientOrderId: string; orderId?: undefined };

export type FuturesRestOptions = Omit<HttpOptions, "timePath">;

export class FuturesRest {
  readonly http: BinanceHttp;

  constructor(opts: FuturesRestOptions) {
    this.http = new BinanceHttp({ ...opts, timePath: "/fapi/v1/time" });
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
    return this.http.request("GET", "/fapi/v1/exchangeInfo") as Promise<ExchangeInfo>;
  }

  depth(symbol: string, limit = 1000): Promise<DepthSnapshot> {
    return this.http.request("GET", "/fapi/v1/depth", { symbol, limit }) as Promise<DepthSnapshot>;
  }

  ticker24h(symbol: string): Promise<Ticker24h> {
    return this.http.request("GET", "/fapi/v1/ticker/24hr", { symbol }) as Promise<Ticker24h>;
  }

  premiumIndex(symbol: string): Promise<PremiumIndex> {
    return this.http.request("GET", "/fapi/v1/premiumIndex", { symbol }) as Promise<PremiumIndex>;
  }

  userTrades(symbol: string, fromId?: number, limit = 1000): Promise<FuturesUserTrade[]> {
    return this.http.signed("GET", "/fapi/v1/userTrades", { symbol, fromId, limit }) as Promise<FuturesUserTrade[]>;
  }

  async listenKeyCreate(): Promise<string> {
    const r = (await this.http.request("POST", "/fapi/v1/listenKey")) as { listenKey: string };
    return r.listenKey;
  }

  async listenKeyKeepalive(key: string): Promise<void> {
    await this.http.request("PUT", "/fapi/v1/listenKey", { listenKey: key });
  }

  async listenKeyClose(key: string): Promise<void> {
    await this.http.request("DELETE", "/fapi/v1/listenKey", { listenKey: key });
  }

  order(p: FuturesOrderParams): Promise<FuturesOrderRow> {
    const params: QueryParams = {
      symbol: p.symbol,
      side: p.side,
      type: p.type,
      quantity: p.quantity,
      price: p.price,
      timeInForce: p.timeInForce,
      reduceOnly: p.reduceOnly,
      newClientOrderId: p.newClientOrderId,
      stopPrice: p.stopPrice,
      closePosition: p.closePosition,
      newOrderRespType: "RESULT",
    };
    return this.http.signed("POST", "/fapi/v1/order", params) as Promise<FuturesOrderRow>;
  }

  cancelOrder(symbol: string, ref: CancelRef): Promise<FuturesOrderRow> {
    return this.http.signed("DELETE", "/fapi/v1/order", { symbol, orderId: ref.orderId, origClientOrderId: ref.origClientOrderId }) as Promise<FuturesOrderRow>;
  }

  queryOrder(symbol: string, ref: CancelRef): Promise<FuturesOrderRow> {
    return this.http.signed("GET", "/fapi/v1/order", { symbol, orderId: ref.orderId, origClientOrderId: ref.origClientOrderId }) as Promise<FuturesOrderRow>;
  }

  cancelAllOpenOrders(symbol: string): Promise<{ code: number; msg: string }> {
    return this.http.signed("DELETE", "/fapi/v1/allOpenOrders", { symbol }) as Promise<{ code: number; msg: string }>;
  }

  openOrders(symbol?: string): Promise<FuturesOrderRow[]> {
    return this.http.signed("GET", "/fapi/v1/openOrders", { symbol }) as Promise<FuturesOrderRow[]>;
  }

  positionRisk(symbol?: string): Promise<FuturesPositionRow[]> {
    return this.http.signed("GET", "/fapi/v3/positionRisk", { symbol }) as Promise<FuturesPositionRow[]>;
  }

  account(): Promise<FuturesAccount> {
    return this.http.signed("GET", "/fapi/v3/account") as Promise<FuturesAccount>;
  }

  leverage(symbol: string, n: number): Promise<{ leverage: number; maxNotionalValue: string; symbol: string }> {
    return this.http.signed("POST", "/fapi/v1/leverage", { symbol, leverage: n }) as Promise<{ leverage: number; maxNotionalValue: string; symbol: string }>;
  }
}
