// smmirror: mirror smart-money buys. A tracker BUY that is fresh (<= maxTokenAgeSec), from a
// wallet scoring >= minScore on the leaderboard and whose token passes the security audit (rule 9
// reads the same AuditCache) becomes a spot LIMIT at ask+slipBps when `<TICKER>USDT` is whitelisted
// on spot, else a DEX intent (paper in demo). Exits: TP/SL bps and the source wallet selling
// >= exitOnSellPct of its entry notional. Skills calls are async; onEvent only schedules them.

import type { EventName, HydraEvents } from "../../core/bus.ts";
import type { EngineId, OpportunityContract, SmartMoneyEvent, Venue } from "../../core/types.ts";
import { logger } from "../../core/log.ts";
import { Engine, type IntentDraft, type ParamsOf } from "./engine.ts";

const log = logger("smmirror");

type Params = ParamsOf<"smmirror">;

/** Tracker events carry contract addresses; spot listing needs the ticker (BSC majors). */
const TICKER_BY_ADDRESS: Record<string, string> = {
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": "BNB",
  "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82": "CAKE",
  "0x55d398326f99059ff775485246999027b3197955": "USDT",
  "0x2170ed0880ac9a755fd29b2688956bd959f933f8": "ETH",
  "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c": "BTCB",
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "USDC",
  "0x570a5d26f7765ecb712c0924e4de545b89fd43df": "SOL",
};

const MAX_HOLD_MS = 30 * 60_000;

interface Tracked {
  wallet: string;
  token: string;
  notionalUsd: number;
  soldUsd: number;
}

export class SmmirrorEngine extends Engine<Params> {
  readonly id: EngineId = "smmirror";
  readonly subscribes: readonly EventName[] = ["feed.onchain.smartmoney"];
  private readonly tracked = new Map<string, Tracked>();
  private readonly inflight = new Set<string>();
  private readonly lastPx = new Map<string, number>();
  private last: OpportunityContract | null = null;
  private skippedScore = 0;
  private skippedAudit = 0;
  private mirrored = 0;

  protected override onConfigure(): void {
    this.last = null;
  }

  onEvent<K extends EventName>(name: K, payload: HydraEvents[K]): void {
    if (name !== "feed.onchain.smartmoney") return;
    const e = payload as SmartMoneyEvent;
    if (e.side === "SELL") this.onSell(e);
    else if (!this.inflight.has(e.token)) {
      this.inflight.add(e.token);
      void this.onBuy(e).finally(() => this.inflight.delete(e.token));
    }
  }

  override contract(): OpportunityContract | null {
    return this.last;
  }

  override stats(): Record<string, number> {
    return { ...super.stats(), mirrored: this.mirrored, skippedScore: this.skippedScore, skippedAudit: this.skippedAudit };
  }

  protected override markOf(venue: Venue, symbol: string): number {
    if (venue !== "dex") return super.markOf(venue, symbol);
    const ref = this.ctx.feed.referenceMid(symbol.slice(0, symbol.indexOf("/")), "USDT");
    return ref ?? this.lastPx.get(symbol) ?? 0;
  }

  private onSell(e: SmartMoneyEvent): void {
    for (const [id, t] of this.tracked) {
      if (t.wallet !== e.wallet || t.token !== e.token) continue;
      t.soldUsd += e.amountUsd;
      if ((t.soldUsd / t.notionalUsd) * 100 >= this.params.exitOnSellPct) {
        this.tracked.delete(id);
        void this.close(id, "source_sold", e.tsNs);
      }
    }
  }

  private async onBuy(e: SmartMoneyEvent): Promise<void> {
    const p = this.params;
    const ticker = TICKER_BY_ADDRESS[e.token.toLowerCase()] ?? e.token;
    const spotSymbol = `${ticker}USDT`;
    const dexSymbol = e.chain === "56" ? `${ticker}/USDT` : `${ticker}/USDT@${e.chain}`;
    if ((this.ctx.nowNs() - e.tsNs) / 1e9 > p.maxTokenAgeSec) return;
    if (this.hasOpen(spotSymbol) || this.hasOpen(dexSymbol) || this.inCooldown(dexSymbol, e.tsNs)) return;
    const skills = this.ctx.skills;
    if (skills === null) {
      log.warn("no skills client; cannot audit", { token: e.token });
      return;
    }
    // Leaderboard rank is only meaningful against the live endpoint; fixture mode has no ranking.
    if (!skills.offline) {
      const score = (await skills.leaderboardScore(e.wallet, e.chain)).score;
      if (score === null || score < p.minScore) {
        this.skippedScore++;
        return;
      }
    }
    const audit = await skills.audit(e.token, e.chain);
    // Kernel rule 9 looks the audit up by the intent's symbol; bind the result to both the
    // contract identity and the pair we will trade so one fetch time governs both keys.
    const auditEntry = { pass: audit.pass, risk: audit.risk, tsMs: this.ctx.wallMs() };
    this.ctx.audit.set(e.token, auditEntry);
    this.ctx.audit.set(dexSymbol, auditEntry);
    if (!audit.pass) {
      this.skippedAudit++;
      return;
    }
    if (!this.enabled || this.hasOpen(spotSymbol) || this.hasOpen(dexSymbol)) return;

    let draft: IntentDraft;
    const spot = this.ctx.feed.spotTopOfBook(spotSymbol);
    if (this.ctx.risk.allowed_symbols.spot.includes(spotSymbol) && spot !== null && spot.ask > 0) {
      const px = spot.ask * (1 + p.slipBps / 10_000);
      draft = { venue: "spot", symbol: spotSymbol, side: "BUY", qty: this.sizeUsd / px, type: "LIMIT", price: px, tp: px * (1 + p.tpBps / 10_000), sl: px * (1 - p.slBps / 10_000), tSignalNs: e.tsNs, maxHoldMs: MAX_HOLD_MS };
    } else {
      const ref = this.ctx.feed.referenceMid(ticker, "USDT");
      const px = ref !== null && ref > 0 ? ref : 1;
      this.lastPx.set(dexSymbol, px);
      draft = { venue: "dex", symbol: dexSymbol, side: "BUY", qty: this.sizeUsd / px, type: "MARKET", tp: px * (1 + p.tpBps / 10_000), sl: px * (1 - p.slBps / 10_000), tSignalNs: e.tsNs, maxHoldMs: MAX_HOLD_MS };
      if (this.ctx.mode === "demo") draft.paper = true;
    }
    this.mirrored++;
    this.last = this.contractOf(draft.symbol, "BUY", draft.venue, p.tpBps, Math.min(1, e.amountUsd / 100_000), MAX_HOLD_MS, { wallet: e.wallet, token: e.token });
    const before = new Set(this.open.keys());
    const res = await this.emitIntent(draft);
    if (!res.ok) return;
    for (const id of this.open.keys()) if (!before.has(id)) this.tracked.set(id, { wallet: e.wallet, token: e.token, notionalUsd: e.amountUsd, soldUsd: 0 });
  }
}
