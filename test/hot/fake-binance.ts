// In-process fake of the futures (/fapi) and spot (/api/v3) REST surfaces the hot lane touches.
// MARKET orders fill at `state.prices` and mutate positions / balances; LIMIT and stop orders rest
// in the open-order lists. `failNext` injects one-shot failures per path; `setBanned` turns every
// request into a 418 with Retry-After until cleared. Signatures are not checked.

import { loadEnv, type Env } from "../../src/core/env.ts";

/** Demo-mode Env with fake keys for both venues; `extra` overrides raw env vars. */
export function fakeEnv(extra: Record<string, string> = {}): Env {
  return loadEnv({
    source: {
      HYDRA_MODE: "demo",
      BINANCE_SPOT_API_KEY: "spot-key",
      BINANCE_SPOT_API_SECRET: "spot-secret",
      BINANCE_FUTURES_API_KEY: "fut-key",
      BINANCE_FUTURES_API_SECRET: "fut-secret",
      DASHBOARD_TOKEN: "t",
      ...extra,
    },
    notice: () => undefined,
    warn: () => undefined,
  });
}

export interface FakeFuturesOrder {
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
}

export interface FakeSpotOrder {
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
  transactTime: number;
}

export interface FakeTrade {
  id: number;
  orderId: number;
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  time: number;
}

export interface FakeRequest {
  method: string;
  path: string;
  params: Record<string, string>;
}

export interface FakeState {
  /** symbol -> signed position amount. */
  futuresPositions: Map<string, number>;
  /** asset -> free balance. */
  spotBalances: Map<string, number>;
  /** symbol -> fill / mark price (default 100). */
  prices: Map<string, number>;
  futuresOpenOrders: FakeFuturesOrder[];
  spotOpenOrders: FakeSpotOrder[];
  /** Every accepted order in arrival order (filled, resting, or cancelled). */
  futuresOrders: FakeFuturesOrder[];
  spotOrders: FakeSpotOrder[];
  futuresTrades: FakeTrade[];
  spotTrades: FakeTrade[];
  requests: FakeRequest[];
  futuresWallet: number;
}

export interface FakeBinance {
  url: string;
  /** Futures REST base (`url`). */
  futuresUrl: string;
  /** Spot REST base (`url` + `/api`), as SpotRest expects. */
  spotUrl: string;
  state: FakeState;
  /** Next request whose pathname equals `path` (and satisfies `when`, if given) fails with `status` and `body`. */
  failNext(path: string, status: number, body?: unknown, when?: (params: Record<string, string>) => boolean): void;
  setBanned(on: boolean): void;
  stop(): void;
}

const QUOTES = ["USDT", "USDC", "BUSD", "BTC"] as const;

export function splitSymbol(symbol: string): { base: string; quote: string } {
  for (const q of QUOTES) if (symbol.endsWith(q) && symbol.length > q.length) return { base: symbol.slice(0, -q.length), quote: q };
  return { base: symbol, quote: "USDT" };
}

function num(v: string | undefined, def = 0): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function exchangeInfo(prices: Map<string, number>): unknown {
  const symbols = [...prices.keys()].map((symbol) => ({
    symbol,
    status: "TRADING",
    baseAsset: splitSymbol(symbol).base,
    quoteAsset: splitSymbol(symbol).quote,
    filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.01", minPrice: "0.01", maxPrice: "1000000" },
      { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "10000" },
      { filterType: "MIN_NOTIONAL", notional: "5" },
    ],
  }));
  return { timezone: "UTC", serverTime: Date.now(), rateLimits: [], symbols };
}

export function startFakeBinance(): FakeBinance {
  const state: FakeState = {
    futuresPositions: new Map(),
    spotBalances: new Map([["USDT", 100_000]]),
    prices: new Map([
      ["BTCUSDT", 60_000],
      ["ETHUSDT", 3000],
      ["SOLUSDT", 150],
      ["BNBUSDT", 600],
    ]),
    futuresOpenOrders: [],
    spotOpenOrders: [],
    futuresOrders: [],
    spotOrders: [],
    futuresTrades: [],
    spotTrades: [],
    requests: [],
    futuresWallet: 100_000,
  };
  const failures = new Map<string, Array<{ status: number; body: unknown; when?: (params: Record<string, string>) => boolean }>>();
  let banned = false;
  let nextOrderId = 1000;
  let nextTradeId = 5000;

  const price = (symbol: string): number => state.prices.get(symbol) ?? 100;

  const futuresOrder = (p: Record<string, string>): Response => {
    const symbol = p.symbol ?? "";
    const side = p.side === "SELL" ? "SELL" : "BUY";
    const type = p.type ?? "MARKET";
    const qty = num(p.quantity);
    const reduceOnly = p.reduceOnly === "true";
    const closePosition = p.closePosition === "true";
    const row: FakeFuturesOrder = {
      orderId: nextOrderId++,
      symbol,
      status: "NEW",
      clientOrderId: p.newClientOrderId ?? `auto-${nextOrderId}`,
      price: p.price ?? "0",
      avgPrice: "0",
      origQty: String(qty),
      executedQty: "0",
      cumQuote: "0",
      timeInForce: p.timeInForce ?? "GTC",
      type,
      reduceOnly,
      closePosition,
      side,
      positionSide: "BOTH",
      stopPrice: p.stopPrice ?? "0",
      updateTime: Date.now(),
    };
    if (type === "MARKET") {
      const cur = state.futuresPositions.get(symbol) ?? 0;
      let delta = side === "BUY" ? qty : -qty;
      if (closePosition) delta = -cur;
      else if (reduceOnly) {
        if (cur === 0 || Math.sign(delta) === Math.sign(cur)) return json({ code: -2022, msg: "ReduceOnly Order is rejected." }, 400);
        if (Math.abs(delta) > Math.abs(cur)) delta = -cur;
      }
      const filled = Math.abs(delta);
      const px = price(symbol);
      const next = cur + delta;
      if (Math.abs(next) < 1e-12) state.futuresPositions.delete(symbol);
      else state.futuresPositions.set(symbol, next);
      row.status = "FILLED";
      row.avgPrice = String(px);
      row.executedQty = String(filled);
      row.cumQuote = String(filled * px);
      state.futuresTrades.push({ id: nextTradeId++, orderId: row.orderId, symbol, side, price: px, qty: filled, time: row.updateTime });
    } else {
      state.futuresOpenOrders.push(row);
    }
    state.futuresOrders.push(row);
    return json(row);
  };

  const spotOrder = (p: Record<string, string>): Response => {
    const symbol = p.symbol ?? "";
    const side = p.side === "SELL" ? "SELL" : "BUY";
    const type = p.type ?? "MARKET";
    const qty = num(p.quantity);
    const row: FakeSpotOrder = {
      symbol,
      orderId: nextOrderId++,
      clientOrderId: p.newClientOrderId ?? `auto-${nextOrderId}`,
      price: p.price ?? "0",
      origQty: String(qty),
      executedQty: "0",
      cummulativeQuoteQty: "0",
      status: "NEW",
      timeInForce: p.timeInForce ?? "GTC",
      type,
      side,
      transactTime: Date.now(),
    };
    if (type === "MARKET") {
      const { base, quote } = splitSymbol(symbol);
      const px = price(symbol);
      const baseBal = state.spotBalances.get(base) ?? 0;
      const quoteBal = state.spotBalances.get(quote) ?? 0;
      if (side === "SELL" && baseBal + 1e-12 < qty) return json({ code: -2010, msg: "Account has insufficient balance for requested action." }, 400);
      if (side === "BUY" && quoteBal < qty * px) return json({ code: -2010, msg: "Account has insufficient balance for requested action." }, 400);
      const nb = side === "BUY" ? baseBal + qty : baseBal - qty;
      if (Math.abs(nb) < 1e-12) state.spotBalances.delete(base);
      else state.spotBalances.set(base, nb);
      state.spotBalances.set(quote, side === "BUY" ? quoteBal - qty * px : quoteBal + qty * px);
      row.status = "FILLED";
      row.executedQty = String(qty);
      row.cummulativeQuoteQty = String(qty * px);
      row.price = String(px);
      state.spotTrades.push({ id: nextTradeId++, orderId: row.orderId, symbol, side, price: px, qty, time: row.transactTime });
    } else {
      state.spotOpenOrders.push(row);
    }
    state.spotOrders.push(row);
    return json(row);
  };

  const cancelFrom = <T extends { orderId: number; clientOrderId: string; symbol: string; status: string }>(list: T[], p: Record<string, string>): T | null => {
    const id = num(p.orderId, -1);
    const cid = p.origClientOrderId;
    const i = list.findIndex((o) => o.symbol === p.symbol && (o.orderId === id || (cid !== undefined && o.clientOrderId === cid)));
    if (i < 0) return null;
    const [o] = list.splice(i, 1);
    if (o === undefined) return null;
    o.status = "CANCELED";
    return o;
  };

  const handle = (method: string, path: string, p: Record<string, string>): Response => {
    // ---- futures ----
    if (path === "/fapi/v1/time") return json({ serverTime: Date.now() });
    if (path === "/fapi/v1/exchangeInfo") return json(exchangeInfo(state.prices));
    if (path === "/fapi/v1/depth") {
      const px = price(p.symbol ?? "");
      return json({ lastUpdateId: 1, E: Date.now(), T: Date.now(), bids: [[String(px - 0.5), "10"]], asks: [[String(px + 0.5), "10"]] });
    }
    if (path === "/fapi/v1/listenKey") return json({ listenKey: "fake-listen-key" });
    if (path === "/fapi/v1/order") {
      if (method === "GET") {
        const o = state.futuresOrders.find((o) => o.symbol === p.symbol && (o.orderId === num(p.orderId, -1) || o.clientOrderId === p.origClientOrderId));
        return o === undefined ? json({ code: -2013, msg: "Order does not exist." }, 400) : json(o);
      }
      if (method === "POST") return futuresOrder(p);
      if (method === "DELETE") {
        const o = cancelFrom(state.futuresOpenOrders, p);
        return o === null ? json({ code: -2011, msg: "Unknown order sent." }, 400) : json(o);
      }
    }
    if (path === "/fapi/v1/allOpenOrders" && method === "DELETE") {
      for (const o of state.futuresOpenOrders) if (o.symbol === p.symbol) o.status = "CANCELED";
      state.futuresOpenOrders = state.futuresOpenOrders.filter((o) => o.symbol !== p.symbol);
      return json({ code: 200, msg: "The operation of cancel all open order is done." });
    }
    if (path === "/fapi/v1/openOrders") return json(p.symbol === undefined ? state.futuresOpenOrders : state.futuresOpenOrders.filter((o) => o.symbol === p.symbol));
    if (path === "/fapi/v1/positionRisk" || path === "/fapi/v2/positionRisk" || path === "/fapi/v3/positionRisk") {
      const rows = [];
      for (const [symbol, qty] of state.futuresPositions) {
        if (p.symbol !== undefined && p.symbol !== symbol) continue;
        const px = price(symbol);
        rows.push({
          symbol,
          positionAmt: String(qty),
          entryPrice: String(px),
          markPrice: String(px),
          unRealizedProfit: "0",
          liquidationPrice: String(qty > 0 ? px * 0.5 : px * 1.5),
          leverage: "3",
          notional: String(qty * px),
          positionSide: "BOTH",
          updateTime: Date.now(),
        });
      }
      return json(rows);
    }
    if (path === "/fapi/v1/account" || path === "/fapi/v2/account" || path === "/fapi/v3/account") {
      return json({
        totalWalletBalance: String(state.futuresWallet),
        totalUnrealizedProfit: "0",
        totalMarginBalance: String(state.futuresWallet),
        availableBalance: String(state.futuresWallet),
        assets: [{ asset: "USDT", walletBalance: String(state.futuresWallet) }],
        positions: [],
      });
    }
    if (path === "/fapi/v1/userTrades") {
      return json(
        state.futuresTrades
          .filter((t) => t.symbol === p.symbol && t.id >= num(p.fromId, 0))
          .slice(0, num(p.limit, 1000))
          .map((t) => ({
            symbol: t.symbol,
            id: t.id,
            orderId: t.orderId,
            side: t.side,
            price: String(t.price),
            qty: String(t.qty),
            realizedPnl: "0",
            quoteQty: String(t.price * t.qty),
            commission: "0",
            commissionAsset: "USDT",
            time: t.time,
            buyer: t.side === "BUY",
            maker: false,
          })),
      );
    }
    // ---- spot ----
    if (path === "/api/v3/time") return json({ serverTime: Date.now() });
    if (path === "/api/v3/exchangeInfo") return json(exchangeInfo(state.prices));
    if (path === "/api/v3/depth") {
      const px = price(p.symbol ?? "");
      return json({ lastUpdateId: 1, bids: [[String(px - 0.5), "10"]], asks: [[String(px + 0.5), "10"]] });
    }
    if (path === "/api/v3/order") {
      if (method === "GET") {
        const o = state.spotOrders.find((o) => o.symbol === p.symbol && (o.orderId === num(p.orderId, -1) || o.clientOrderId === p.origClientOrderId));
        return o === undefined ? json({ code: -2013, msg: "Order does not exist." }, 400) : json(o);
      }
      if (method === "POST") return spotOrder(p);
      if (method === "DELETE") {
        const o = cancelFrom(state.spotOpenOrders, p);
        return o === null ? json({ code: -2011, msg: "Unknown order sent." }, 400) : json(o);
      }
    }
    if (path === "/api/v3/openOrders") {
      if (method === "DELETE") {
        const gone = state.spotOpenOrders.filter((o) => o.symbol === p.symbol);
        for (const o of gone) o.status = "CANCELED";
        state.spotOpenOrders = state.spotOpenOrders.filter((o) => o.symbol !== p.symbol);
        return json(gone);
      }
      return json(p.symbol === undefined ? state.spotOpenOrders : state.spotOpenOrders.filter((o) => o.symbol === p.symbol));
    }
    if (path === "/api/v3/account") {
      const balances = [];
      for (const [asset, free] of state.spotBalances) if (free !== 0 || p.omitZeroBalances !== "true") balances.push({ asset, free: String(free), locked: "0" });
      return json({ canTrade: true, canWithdraw: true, canDeposit: true, balances });
    }
    if (path === "/api/v3/myTrades") {
      return json(
        state.spotTrades
          .filter((t) => t.symbol === p.symbol && t.id >= num(p.fromId, 0))
          .slice(0, num(p.limit, 1000))
          .map((t) => ({
            symbol: t.symbol,
            id: t.id,
            orderId: t.orderId,
            price: String(t.price),
            qty: String(t.qty),
            quoteQty: String(t.price * t.qty),
            commission: "0",
            commissionAsset: "USDT",
            time: t.time,
            isBuyer: t.side === "BUY",
            isMaker: false,
          })),
      );
    }
    return json({ code: -1121, msg: `fake: unhandled ${method} ${path}` }, 404);
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      const params: Record<string, string> = {};
      u.searchParams.forEach((v, k) => {
        params[k] = v;
      });
      state.requests.push({ method: req.method, path: u.pathname, params });
      if (banned) return json({ code: -1003, msg: "Way too much request weight used; IP banned." }, 418, { "Retry-After": "1" });
      const q = failures.get(u.pathname);
      if (q !== undefined) {
        const i = q.findIndex((f) => f.when === undefined || f.when(params));
        if (i >= 0) {
          const [f] = q.splice(i, 1);
          if (f !== undefined) return json(f.body ?? { code: -1000, msg: `fake: injected failure ${f.status}` }, f.status);
        }
      }
      return handle(req.method, u.pathname, params);
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    futuresUrl: url,
    spotUrl: `${url}/api`,
    state,
    failNext(path, status, body, when) {
      let q = failures.get(path);
      if (q === undefined) {
        q = [];
        failures.set(path, q);
      }
      q.push({ status, body, when });
    },
    setBanned(on) {
      banned = on;
    },
    stop() {
      server.stop(true);
    },
  };
}
