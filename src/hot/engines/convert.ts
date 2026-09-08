// convert: Binance Convert quote vs the spot book. Every `pollMs` each whitelisted `<BASE>USDT`
// symbol is priced USDT -> BASE. Demo has no Convert endpoint: the comparison is synthetic (the
// reference mid vs the spot book, i.e. the edge the executor's paper path would see) and only
// logged; nothing is ever emitted. Live asks the injected `convertQuote` (POST
// /sapi/v1/convert/getQuote, wired by the runtime) and publishes an OpportunityContract when the
// quote beats the book by >= minEdgeBps; there is no executor path for Convert acceptance yet,
// so the contract (not an Intent) is the deliverable Commander reads.

import type { EventName, HydraEvents } from "../../core/bus.ts";
import type { EngineId, OpportunityContract } from "../../core/types.ts";
import { logger } from "../../core/log.ts";
import { Engine, type EngineCtx, type ParamsOf } from "./engine.ts";

const log = logger("convert");

type Params = ParamsOf<"convert">;

export type ConvertQuoteFn = (from: string, to: string, amount: number) => Promise<{ ratio: number; quoteId: string }>;

export class ConvertEngine extends Engine<Params> {
  readonly id: EngineId = "convert";
  readonly subscribes: readonly EventName[] = [];
  private last: OpportunityContract | null = null;
  private lastPollNs = 0;
  private polls = 0;
  private edges = 0;
  private inflight = false;

  protected override onConfigure(): void {
    this.last = null;
    this.lastPollNs = 0;
  }

  onEvent(): void {}

  override contract(): OpportunityContract | null {
    return this.last;
  }

  override stats(): Record<string, number> {
    return { ...super.stats(), polls: this.polls, edges: this.edges };
  }

  override onTick(nowNs: number): void {
    super.onTick(nowNs);
    if (this.inflight || nowNs - this.lastPollNs < this.params.pollMs * 1e6) return;
    this.lastPollNs = nowNs;
    this.polls++;
    if (this.ctx.mode === "demo") {
      this.demoCompare();
      return;
    }
    // Optional runtime extension: the Phase 5 runtime injects the Convert client on the ctx it builds.
    const ctx: EngineCtx & { convertQuote?: ConvertQuoteFn } = this.ctx;
    const quoteFn = ctx.convertQuote;
    if (quoteFn === undefined) return;
    this.inflight = true;
    void this.livePoll(quoteFn, nowNs).finally(() => {
      this.inflight = false;
    });
  }

  private demoCompare(): void {
    for (const symbol of this.symbols) {
      const t = this.ctx.feed.spotTopOfBook(symbol);
      const ref = this.ctx.feed.referenceMid(symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol, "USDT");
      if (t === null || t.ask <= 0 || ref === null) continue;
      const edgeBps = ((t.ask - ref) / ref) * 10_000;
      if (edgeBps >= this.params.minEdgeBps) {
        this.edges++;
        log.info("synthetic convert edge (demo, log-only)", { symbol, edgeBps, ask: t.ask, ref });
      }
    }
  }

  private async livePoll(quoteFn: ConvertQuoteFn, nowNs: number): Promise<void> {
    for (const symbol of this.symbols) {
      const base = symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
      const t = this.ctx.feed.spotTopOfBook(symbol);
      if (t === null || t.ask <= 0) continue;
      let q: { ratio: number; quoteId: string };
      try {
        q = await quoteFn("USDT", base, this.sizeUsd);
      } catch (err) {
        log.warn("convert quote failed", { symbol, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (q.ratio <= 0) continue;
      // ratio = BASE per USDT; the implied price is 1/ratio, compared with what the book charges.
      const edgeBps = ((t.ask - 1 / q.ratio) / t.ask) * 10_000;
      if (edgeBps < this.params.minEdgeBps) continue;
      this.edges++;
      this.last = this.contractOf(symbol, "BUY", "spot", edgeBps, Math.min(1, edgeBps / (this.params.minEdgeBps * 2)), this.params.pollMs, { quoteId: q.quoteId, ratio: q.ratio, ask: t.ask, tsNs: nowNs });
      log.info("convert edge", { symbol, edgeBps, quoteId: q.quoteId });
    }
  }
}
