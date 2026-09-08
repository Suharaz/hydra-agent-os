// FeedHub: every market-data connection, the per-symbol books and the rolling burst / VWAP /
// gap state engines read. One dispatcher (`applyFrame`) is shared by the live sockets and the
// `replay` verb, so a recorded fixture exercises exactly the production parse -> emit path.
//
// Connections (<= 3 futures sockets by design):
//   futures `/public`  : <sym>@depth@100ms, <sym>@aggTrade, <sym>@markPrice@1s
//   futures `/market`  : <sym>@forceOrder
//   spot stream        : <sym>@bookTicker, <sym>@trade
//   mainnet spot (demo): <sym>@bookTicker as the reference mid for the paper DEX (signal only)
// Books buffer diffs until the REST snapshot lands; `feed.depth` is emitted only while synced.

import { nowNs as monoNs } from "../core/clock.ts";
import { bus as globalBus, type Bus } from "../core/bus.ts";
import type { Config, RiskConfig } from "../core/config.ts";
import type { Env } from "../core/env.ts";
import type { Ledger } from "../core/ledger.ts";
import { logger } from "../core/log.ts";
import type { MarkEvent, Mode, Side } from "../core/types.ts";
import type { Module } from "../main.ts";
import { FuturesRest, type DepthSnapshot, type Ticker24h } from "../venues/binance/rest-futures.ts";
import { SpotRest } from "../venues/binance/rest-spot.ts";
import { urlMatrix, type UrlMatrix } from "../venues/binance/urls.ts";
import { BinanceWs, combinedStreamUrl, realClock, realWsFactory, streamName, type Clock, type Frame, type WsFactory } from "../venues/binance/ws.ts";
import type { OnchainAdapter } from "../venues/onchain/adapter.ts";
import { BawAdapter } from "../venues/onchain/baw-adapter.ts";
import { PaperAdapter } from "../venues/onchain/paper-adapter.ts";
import { SkillsHttp } from "../venues/onchain/skills-http.ts";
import { Book, type DepthDiff } from "./book.ts";

const log = logger("feed");

const DEPTH_LEVELS_EMITTED = 20;
const BURST_WINDOW_MS = 1000;
const VWAP_WINDOW_S = 60;
const ADV_REFRESH_MS = 5 * 60_000;
const DEX_QUOTE_MS = 2000;
const SNAPSHOT_RETRY_MS = 1000;

export type BookView = Pick<Book, "synced" | "ageMs" | "bestBid" | "bestAsk" | "mid" | "spreadBps" | "imbalance" | "microprice">;

export interface Burst {
  buyUsd1s: number;
  sellUsd1s: number;
}

/** Which socket a frame came from; inferred from the event type when omitted (replay). */
export type FrameSource = "futures" | "spot" | "spotRef";

/** Read-only REST surface the hub needs; null disables snapshots/ADV (replay). */
export type FeedFuturesRest = Pick<FuturesRest, "depth" | "ticker24h">;

export interface FeedHubDeps {
  futuresRest: FeedFuturesRest | null;
  /** Reserved for spot REST reads; the hub currently only needs the spot stream. */
  spotRest: SpotRest | null;
  /** null = no sockets (replay). */
  wsFactory: WsFactory | null;
  onchain: OnchainAdapter | null;
  skills: SkillsHttp | null;
  clock?: Clock;
  nowNs?: () => number;
  bus?: Bus;
  /** null = no sockets (replay). */
  urls: UrlMatrix | null;
  mode: Mode;
  risk: Pick<RiskConfig, "allowed_symbols">;
}

interface SymbolState {
  book: Book;
  snapInflight: boolean;
  mark: MarkEvent | null;
  adv: number;
  // Rolling 1 s burst ring: parallel arrays, `head` is the first live entry.
  ringTs: number[];
  ringBuy: number[];
  ringSell: number[];
  ringHead: number;
  buyUsd: number;
  sellUsd: number;
  // 60 one-second VWAP buckets keyed by their absolute second.
  vwapSec: number[];
  vwapPv: number[];
  vwapV: number[];
  lastTradeMs: number;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

export class FeedHub {
  private readonly clock: Clock;
  private readonly nowNs: () => number;
  private readonly bus: Bus;
  private readonly symbols = new Map<string, SymbolState>();
  private readonly spotTop = new Map<string, { bid: number; ask: number }>();
  private readonly refTop = new Map<string, { bid: number; ask: number }>();
  private readonly sockets: BinanceWs[] = [];
  private readonly timers = new Set<unknown>();
  private trackerStop: (() => void) | null = null;
  private stopped = true;

  constructor(private readonly deps: FeedHubDeps) {
    this.clock = deps.clock ?? realClock;
    this.nowNs = deps.nowNs ?? monoNs;
    this.bus = deps.bus ?? globalBus;
    for (const s of deps.risk.allowed_symbols.futures) this.state(s);
  }

  // ---- read API -----------------------------------------------------------

  book(symbol: string): BookView | null {
    return this.symbols.get(symbol)?.book ?? null;
  }

  mark(symbol: string): MarkEvent | null {
    return this.symbols.get(symbol)?.mark ?? null;
  }

  /** One-sided taker USD over the trailing 1 s (futures aggTrade). */
  burst(symbol: string): Burst {
    const st = this.symbols.get(symbol);
    if (st === undefined) return { buyUsd1s: 0, sellUsd1s: 0 };
    this.evictBurst(st, st.lastTradeMs);
    return { buyUsd1s: st.buyUsd, sellUsd1s: st.sellUsd };
  }

  /** (mark - index) / index in bps; 0 before the first markPrice. */
  gapBps(symbol: string): number {
    const m = this.symbols.get(symbol)?.mark ?? null;
    return m === null || m.index <= 0 ? 0 : ((m.mark - m.index) / m.index) * 10_000;
  }

  /** Volume-weighted price over the trailing 60 s of aggTrades; 0 when empty. */
  vwap1m(symbol: string): number {
    const st = this.symbols.get(symbol);
    if (st === undefined) return 0;
    const minSec = Math.floor(st.lastTradeMs / 1000) - VWAP_WINDOW_S + 1;
    let pv = 0;
    let v = 0;
    for (let i = 0; i < VWAP_WINDOW_S; i++) {
      if ((st.vwapSec[i] as number) >= minSec) {
        pv += st.vwapPv[i] as number;
        v += st.vwapV[i] as number;
      }
    }
    return v > 0 ? pv / v : 0;
  }

  /** 24 h quote volume (USD) from ticker24h; 0 until the first poll. */
  adv(symbol: string): number {
    return this.symbols.get(symbol)?.adv ?? 0;
  }

  /**
   * Inject an ADV value for offline replay; bypasses the REST ticker24h poll.
   * Only use in deterministic replay/test contexts where no REST is available.
   */
  overrideAdv(symbol: string, usd: number): void {
    this.state(symbol).adv = usd;
  }


  /** Spot top of book (testnet in demo, mainnet in live). */
  spotTopOfBook(symbol: string): { bid: number; ask: number } | null {
    return this.spotTop.get(symbol) ?? null;
  }

  /** Mainnet spot mid for `BASE/QUOTE` (paper DEX anchor); falls back to the spot stream. */
  referenceMid(base: string, quote: string): number | null {
    const sym = `${base}${quote}`.toUpperCase();
    const t = this.refTop.get(sym) ?? this.spotTop.get(sym);
    return t === undefined || t.bid <= 0 || t.ask <= 0 ? null : (t.bid + t.ask) / 2;
  }

  // ---- lifecycle ----------------------------------------------------------

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.openSockets();
    this.startAdvPolling();
    this.startOnchain();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const s of this.sockets) s.stop();
    this.sockets.length = 0;
    for (const h of this.timers) this.clock.clearTimeout(h);
    this.timers.clear();
    if (this.trackerStop !== null) {
      this.trackerStop();
      this.trackerStop = null;
    }
  }

  private openSockets(): void {
    const { wsFactory, urls, risk } = this.deps;
    if (wsFactory === null || urls === null) return;
    const fut = risk.allowed_symbols.futures;
    const spot = risk.allowed_symbols.spot;
    if (fut.length > 0) {
      const pub: string[] = [];
      for (const s of fut) pub.push(streamName(s, "depth@100ms"), streamName(s, "aggTrade"), streamName(s, "markPrice@1s"));
      this.sockets.push(
        new BinanceWs({
          name: "fut.public",
          url: combinedStreamUrl(urls.futuresWs, pub, "/public"),
          wsFactory,
          clock: this.clock,
          onFrame: (f) => this.applyFrame(f, "futures"),
          onOpen: (reconnect) => {
            // Any diffs missed while disconnected break the pu chain: force a fresh snapshot.
            for (const [sym, st] of this.symbols) {
              st.book.clear();
              this.resync(sym, st);
            }
            if (reconnect) log.info("public stream reconnected; books resyncing");
          },
        }),
      );
      this.sockets.push(
        new BinanceWs({
          name: "fut.market",
          url: combinedStreamUrl(urls.futuresWs, fut.map((s) => streamName(s, "forceOrder")), "/market"),
          wsFactory,
          clock: this.clock,
          onFrame: (f) => this.applyFrame(f, "futures"),
        }),
      );
    }
    if (spot.length > 0) {
      const streams: string[] = [];
      for (const s of spot) streams.push(streamName(s, "bookTicker"), streamName(s, "trade"));
      this.sockets.push(
        new BinanceWs({
          name: "spot.stream",
          url: combinedStreamUrl(urls.spotStream, streams),
          wsFactory,
          clock: this.clock,
          onFrame: (f) => this.applyFrame(f, "spot"),
        }),
      );
      // Demo: the testnet has no real liquidity, so the paper DEX anchors on mainnet public quotes.
      if (this.deps.mode === "demo" && urls.mainnetSpotStream !== urls.spotStream) {
        this.sockets.push(
          new BinanceWs({
            name: "spot.mainnet",
            url: combinedStreamUrl(
              urls.mainnetSpotStream,
              spot.map((s) => streamName(s, "bookTicker")),
            ),
            wsFactory,
            clock: this.clock,
            onFrame: (f) => this.applyFrame(f, "spotRef"),
          }),
        );
      }
    }
    for (const s of this.sockets) s.start();
  }

  private startAdvPolling(): void {
    const rest = this.deps.futuresRest;
    if (rest === null || this.symbols.size === 0) return;
    const poll = () => {
      if (this.stopped) return;
      for (const [sym, st] of this.symbols) {
        rest.ticker24h(sym).then(
          (t: Ticker24h) => {
            st.adv = num(t.quoteVolume);
          },
          (err: unknown) => log.warn("ticker24h failed", { symbol: sym, error: err instanceof Error ? err.message : String(err) }),
        );
      }
    };
    poll();
    this.every(poll, ADV_REFRESH_MS);
  }

  private startOnchain(): void {
    const oc = this.deps.onchain;
    if (oc === null) return;
    this.trackerStop = oc.trackerStream((e) => {
      if (!this.stopped) this.bus.emit("feed.onchain.smartmoney", e);
    });
    const pairs = this.deps.risk.allowed_symbols.dex;
    if (pairs.length === 0) return;
    const inflight = new Set<string>();
    const poll = () => {
      if (this.stopped) return;
      for (const pair of pairs) {
        if (inflight.has(pair)) continue;
        inflight.add(pair);
        oc.quote(pair).then(
          (q) => {
            inflight.delete(pair);
            if (!this.stopped) this.bus.emit("feed.dexquote", q);
          },
          (err: unknown) => {
            inflight.delete(pair);
            log.warn("dex quote failed", { pair, error: err instanceof Error ? err.message : String(err) });
          },
        );
      }
    };
    poll();
    this.every(poll, DEX_QUOTE_MS);
  }

  /** Interval built from chained timeouts so a single handle set covers everything. */
  private every(fn: () => void, ms: number): void {
    const tick = () => {
      this.timers.delete(h);
      if (this.stopped) return;
      fn();
      h = this.clock.setTimeout(tick, ms);
      this.timers.add(h);
    };
    let h = this.clock.setTimeout(tick, ms);
    this.timers.add(h);
  }

  // ---- dispatcher ---------------------------------------------------------

  /**
   * Routes one parsed frame to its handler. Used by the sockets and by `replay`; `source`
   * defaults from the event type (`trade`/`bookTicker` are spot, everything else futures).
   */
  applyFrame(frame: Frame, source?: FrameSource): void {
    const d = frame.data;
    let e = frame.e;
    if (e === null) {
      // bookTicker carries no `e`; combined frames name it, raw frames are recognised by shape.
      if (frame.stream !== null) e = frame.stream.slice(frame.stream.indexOf("@") + 1);
      else if ("A" in d && "B" in d && "s" in d) e = "bookTicker";
    }
    switch (e) {
      case "depthUpdate":
        return this.onDepth(d);
      case "aggTrade":
        return this.onAggTrade(d);
      case "markPriceUpdate":
        return this.onMark(d);
      case "forceOrder":
        return this.onForceOrder(d);
      case "trade":
        return this.onSpotTrade(d);
      case "bookTicker":
        return this.onBookTicker(d, source === "spotRef" ? this.refTop : this.spotTop);
      default:
        return;
    }
  }

  private onDepth(d: Record<string, unknown>): void {
    const symbol = String(d.s);
    const st = this.state(symbol);
    const diff: DepthDiff = { U: num(d.U), u: num(d.u), b: d.b as [string, string][], a: d.a as [string, string][] };
    if (typeof d.pu === "number") diff.pu = d.pu;
    if (typeof d.E === "number") diff.E = d.E;
    const wasSynced = st.book.synced;
    const applied = st.book.applyDiff(diff);
    if (!applied) {
      // Buffered pre-snapshot (or gap -> onGap already asked for a resync).
      if (!wasSynced) this.resync(symbol, st);
      return;
    }
    this.bus.emit("feed.depth", {
      venue: "futures",
      symbol,
      bids: st.book.levels("bid", DEPTH_LEVELS_EMITTED),
      asks: st.book.levels("ask", DEPTH_LEVELS_EMITTED),
      synced: true,
      tsNs: this.nowNs(),
    });
  }

  private onAggTrade(d: Record<string, unknown>): void {
    const symbol = String(d.s);
    const st = this.state(symbol);
    const price = num(d.p);
    const qty = num(d.q);
    // `m` = buyer is maker, i.e. the aggressor sold.
    const side: Side = d.m === true ? "SELL" : "BUY";
    const tMs = typeof d.T === "number" ? d.T : typeof d.E === "number" ? d.E : this.clock.nowMs();
    this.recordTrade(st, tMs, price, qty, side);
    this.bus.emit("feed.trade", { venue: "futures", symbol, price, qty, side, tsNs: this.nowNs() });
  }

  private onSpotTrade(d: Record<string, unknown>): void {
    const symbol = String(d.s);
    this.bus.emit("feed.trade", {
      venue: "spot",
      symbol,
      price: num(d.p),
      qty: num(d.q),
      side: d.m === true ? "SELL" : "BUY",
      tsNs: this.nowNs(),
    });
  }

  private onMark(d: Record<string, unknown>): void {
    const symbol = String(d.s);
    const st = this.state(symbol);
    const ev: MarkEvent = {
      symbol,
      mark: num(d.p),
      index: num(d.i),
      fundingRate: num(d.r),
      nextFundingTime: num(d.T),
      tsNs: this.nowNs(),
    };
    st.mark = ev;
    this.bus.emit("feed.mark", ev);
  }

  /**
   * forceOrder is a *sample*, not the tape: Binance pushes at most one liquidation per symbol
   * per 1000 ms, so engines must treat `feed.liq` as a lower bound on cascade intensity.
   */
  private onForceOrder(d: Record<string, unknown>): void {
    const o = (typeof d.o === "object" && d.o !== null ? d.o : d) as Record<string, unknown>;
    const symbol = String(o.s);
    const side: Side = o.S === "BUY" ? "BUY" : "SELL";
    const filled = num(o.z);
    const qty = filled > 0 ? filled : num(o.q);
    const avg = num(o.ap);
    const price = avg > 0 ? avg : num(o.p);
    this.bus.emit("feed.liq", { symbol, side, price, qty, usd: price * qty, tsNs: this.nowNs() });
  }

  private onBookTicker(d: Record<string, unknown>, into: Map<string, { bid: number; ask: number }>): void {
    const symbol = String(d.s);
    const cur = into.get(symbol);
    if (cur === undefined) into.set(symbol, { bid: num(d.b), ask: num(d.a) });
    else {
      cur.bid = num(d.b);
      cur.ask = num(d.a);
    }
  }

  // ---- state ---------------------------------------------------------------

  private state(symbol: string): SymbolState {
    let st = this.symbols.get(symbol);
    if (st !== undefined) return st;
    st = {
      book: new Book(symbol, {
        nowMs: () => this.clock.nowMs(),
        onGap: (sym, detail) => {
          log.warn("depth gap; resyncing", { symbol: sym, detail });
          this.resync(sym, st as SymbolState);
        },
      }),
      snapInflight: false,
      mark: null,
      adv: 0,
      ringTs: [],
      ringBuy: [],
      ringSell: [],
      ringHead: 0,
      buyUsd: 0,
      sellUsd: 0,
      vwapSec: new Array<number>(VWAP_WINDOW_S).fill(-1),
      vwapPv: new Array<number>(VWAP_WINDOW_S).fill(0),
      vwapV: new Array<number>(VWAP_WINDOW_S).fill(0),
      lastTradeMs: 0,
    };
    this.symbols.set(symbol, st);
    return st;
  }

  private resync(symbol: string, st: SymbolState): void {
    const rest = this.deps.futuresRest;
    if (rest === null || st.snapInflight || this.stopped) return;
    st.snapInflight = true;
    rest.depth(symbol, 1000).then(
      (snap: DepthSnapshot) => {
        st.snapInflight = false;
        if (this.stopped) return;
        const ok = st.book.applySnapshot(snap);
        log.info("depth snapshot", { symbol, lastUpdateId: snap.lastUpdateId, synced: ok, depth: st.book.depth });
        if (!ok) this.resync(symbol, st);
      },
      (err: unknown) => {
        st.snapInflight = false;
        log.warn("depth snapshot failed", { symbol, error: err instanceof Error ? err.message : String(err) });
        if (this.stopped) return;
        const h = this.clock.setTimeout(() => {
          this.timers.delete(h);
          this.resync(symbol, st);
        }, SNAPSHOT_RETRY_MS);
        this.timers.add(h);
      },
    );
  }

  private recordTrade(st: SymbolState, tMs: number, price: number, qty: number, side: Side): void {
    const usd = price * qty;
    if (tMs > st.lastTradeMs) st.lastTradeMs = tMs;
    // Burst ring.
    st.ringTs.push(tMs);
    st.ringBuy.push(side === "BUY" ? usd : 0);
    st.ringSell.push(side === "SELL" ? usd : 0);
    if (side === "BUY") st.buyUsd += usd;
    else st.sellUsd += usd;
    this.evictBurst(st, st.lastTradeMs);
    // VWAP bucket.
    const sec = Math.floor(tMs / 1000);
    const i = ((sec % VWAP_WINDOW_S) + VWAP_WINDOW_S) % VWAP_WINDOW_S;
    if (st.vwapSec[i] !== sec) {
      st.vwapSec[i] = sec;
      st.vwapPv[i] = 0;
      st.vwapV[i] = 0;
    }
    st.vwapPv[i] = (st.vwapPv[i] as number) + usd;
    st.vwapV[i] = (st.vwapV[i] as number) + qty;
  }

  private evictBurst(st: SymbolState, nowMs: number): void {
    const cutoff = nowMs - BURST_WINDOW_MS;
    while (st.ringHead < st.ringTs.length && (st.ringTs[st.ringHead] as number) <= cutoff) {
      st.buyUsd -= st.ringBuy[st.ringHead] as number;
      st.sellUsd -= st.ringSell[st.ringHead] as number;
      st.ringHead++;
    }
    if (st.ringHead === st.ringTs.length) {
      st.ringTs.length = 0;
      st.ringBuy.length = 0;
      st.ringSell.length = 0;
      st.ringHead = 0;
      // Guard against float drift once the window is empty.
      st.buyUsd = 0;
      st.sellUsd = 0;
    } else if (st.ringHead > 1024 && st.ringHead * 2 > st.ringTs.length) {
      st.ringTs.splice(0, st.ringHead);
      st.ringBuy.splice(0, st.ringHead);
      st.ringSell.splice(0, st.ringHead);
      st.ringHead = 0;
    }
  }
}

// ---- module -----------------------------------------------------------------

export interface FeedModuleContext {
  env: Env;
  config: Config;
  ledger: Ledger;
  stateDir: string;
  configDir: string;
}

export const SMARTMONEY_FIXTURE = "fixtures/smartmoney.ndjson";

/** Real clients from the env's URL matrix; paper on-chain adapter in demo, `baw` in live. */
export interface FeedModule extends Module {
  hub: FeedHub;
  onchain: OnchainAdapter;
  skills: SkillsHttp;
  futuresRest: FuturesRest;
  spotRest: SpotRest;
}

export function createFeedModule(ctx: FeedModuleContext): FeedModule {
  const { env, config } = ctx;
  const urls = urlMatrix(env);
  const futuresRest = new FuturesRest({ baseUrl: urls.futuresRest, key: env.keys.futures?.key, secret: env.keys.futures?.secret });
  const spotRest = new SpotRest({ baseUrl: urls.spotRest, key: env.keys.spot?.key, secret: env.keys.spot?.secret });
  let hub: FeedHub | null = null;
  const onchain: OnchainAdapter =
    env.onchain === "paper"
      ? new PaperAdapter({
          fixturePath: SMARTMONEY_FIXTURE,
          replaySpeed: env.replaySpeed,
          referenceMid: (base, quote) => hub?.referenceMid(base, quote) ?? null,
        })
      : new BawAdapter({ bin: env.bawBin ?? "" }); // ctor runs checkBawBin; a null/invalid BAW_BIN refuses to boot
  const skills = new SkillsHttp({ base: env.skillsHttp });
  hub = new FeedHub({ futuresRest, spotRest, wsFactory: realWsFactory, onchain, skills, urls, mode: env.mode, risk: config.risk });
  const h = hub;
  return {
    name: "feed",
    order: "feed",
    hub: h,
    onchain,
    skills,
    futuresRest,
    spotRest,
    start: () => h.start(),
    stop: () => h.stop(),
  };
}
