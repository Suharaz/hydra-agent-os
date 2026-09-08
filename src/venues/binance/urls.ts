// Mode -> URL matrix (phase-02 table) and the boot probe for the routed futures WS paths.

import type { Env } from "../../core/env.ts";
import { logger } from "../../core/log.ts";
import { rawStreamUrl, realClock, realWsFactory, WS_OPEN, type Clock, type FuturesRoute, type WsFactory } from "./ws.ts";

export interface UrlMatrix {
  futuresRest: string;
  futuresWs: string;
  spotRest: string;
  spotWsApi: string;
  spotStream: string;
  /** Public mainnet spot streams; demo basis signal source. Same as spotStream in live. */
  mainnetSpotStream: string;
}

export const MAINNET_SPOT_STREAM = "wss://stream.binance.com:9443";

export function urlMatrix(env: Env): UrlMatrix {
  return {
    futuresRest: env.futures === "live" ? "https://fapi.binance.com" : "https://demo-fapi.binance.com",
    futuresWs: env.futures === "live" ? "wss://fstream.binance.com" : "wss://demo-fstream.binance.com",
    spotRest: env.spot === "live" ? "https://api.binance.com/api" : "https://testnet.binance.vision/api",
    spotWsApi: env.spot === "live" ? "wss://ws-api.binance.com/ws-api/v3" : "wss://ws-api.testnet.binance.vision/ws-api/v3",
    spotStream: env.spot === "live" ? MAINNET_SPOT_STREAM : "wss://stream.testnet.binance.vision",
    mainnetSpotStream: MAINNET_SPOT_STREAM,
  };
}

export interface RoutedProbe {
  market: boolean;
  public: boolean;
  ws: boolean;
}

const log = logger("urls.probe");

/**
 * Opens one short-lived socket per candidate path and reports which upgraded (101). Used at boot
 * to decide between routed (`/market`, `/public`) and legacy `/ws` stream URLs. Never throws.
 */
export async function probeRoutedPaths(
  base: string,
  wsFactory: WsFactory = realWsFactory,
  clock: Clock = realClock,
  timeoutMs = 3000,
  probeStream = "btcusdt@aggTrade",
): Promise<RoutedProbe> {
  const tryPath = (route: FuturesRoute | null): Promise<boolean> => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const url = rawStreamUrl(base, [probeStream], route);
    let socket: { close(): void } | null = null;
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clock.clearTimeout(timer);
      resolve(ok);
      try {
        socket?.close();
      } catch {
        // already closed
      }
    };
    const timer = clock.setTimeout(() => finish(false), timeoutMs);
    try {
      const ws = wsFactory(url);
      socket = ws;
      ws.onopen = () => finish(true);
      ws.onerror = () => finish(false);
      ws.onclose = () => finish(false);
      if (ws.readyState === WS_OPEN) finish(true);
    } catch {
      finish(false);
    }
    return promise;
  };
  const [market, pub, ws] = await Promise.all([tryPath("/market"), tryPath("/public"), tryPath(null)]);
  const result: RoutedProbe = { market, public: pub, ws };
  log.info("routed path probe", { base, ...result });
  return result;
}
