---
phase: 4
title: "Signal Engines"
status: pending
priority: P1
effort: "2d"
dependencies: [2, 3]
---

# Phase 4: Signal Engines

## Overview
Engine SDK plus six engines as small deterministic state machines. Engines read Feed Hub state synchronously, emit `Intent`s and `OpportunityContract`s, and take parameters from `config/engines.yaml` (hot-reloaded, written by Commander within declared bounds). Symbols are constrained by `risk.yaml.allowed_symbols`; paper→live promotion is human-only in live.

## Requirements
- Functional: `Engine { id; subscribes: EventName[]; onEvent(e); onTick(nowNs); configure(params); contract(): OpportunityContract | null; stats() }`; registry starts/stops/reconfigures from `engines.yaml`.
- Functional engines: `liqfade`, `smmirror`, `basis`; `cexdex`, `convert`, `tokstock`. `imbalance.ts` is a helper module (filter), not an engine.
- Functional: `engines.yaml` per engine `{enabled, paper, symbols (⊆ allowed_symbols), sizeUsd, params: <typed per engine>}`; each engine declares a zod params schema with `min/max` per numeric param; `paper` intents are recorded at mid by the executor without REST.
- Functional: every engine checks `book.synced && ageMs < 2000` before LIMIT pricing; otherwise skips or uses MARKET only if the engine allows.
- Non-functional: `onEvent` < 50 µs; no per-event timers.

## Architecture
```
src/hot/engines/engine.ts, registry.ts, imbalance.ts
src/hot/engines/{liqfade,basis,convert,smmirror,cexdex,tokstock}.ts
config/engines.yaml
```
Engine specs:
| Engine | Trigger | Entry | Exit | Params (bounds) |
|---|---|---|---|---|
| liqfade | `forceOrder` is a 1-per-second-per-symbol *sample*. Cascade score = `snapshotsInWindow` (consecutive one-sided samples) × `gapBps` (mark−index) × `burstRatio` (one-sided aggTrade USD 1 s ÷ ADV-scaled) ; displacement vs 1-min VWAP ≥ `minDispBps` | fade direction; LIMIT at best±1 tick if book synced, else MARKET if `allowMarket` | TP `tpBps`, SL `slBps`, time stop `maxHoldMs` | `windowMs 1000–5000 (3000)`, `minSnapshots 2–5 (2)`, `minSampleUsd 5e4–1e6 (2e5)`, `minGapBps 2–30 (8)`, `minBurstRatio 1–10 (3)`, `minDispBps 10–100 (40)`, `tpBps 10–100 (35)`, `slBps 10–100 (25)`, `maxHoldMs 3e4–3e5 (1.2e5)`, `chaseMs 100–2000 (400)` |
| basis | basis = (perpMark − spotMid)/spotMid; z-score over `lookbackSec`. Demo: spotMid from **mainnet public bookTicker**; spot leg is `paper` in demo (testnet book is not real liquidity). Live: both legs real | short perp + long spot (or inverse), equal notional | z < `zExit` or `maxHoldMs` | `lookbackSec 60–900 (300)`, `zEntry 1–4 (2)`, `zExit 0–1 (0.5)`, `maxHoldMs` |
| smmirror | `feed.onchain.smartmoney` buy; wallet score ≥ `minScore` via `skills-http.leaderboardScore`; token audit PASS (rule 9) | listed on Binance spot → spot LIMIT ask+`slipBps`; else `venue:'dex'` intent (paper in demo) | TP/SL bps; exit when source wallet sells ≥ `exitOnSellPct` | `minScore 50–100 (80)`, `slipBps 0–50 (10)`, `tpBps`, `slBps`, `exitOnSellPct 10–100 (40)`, `maxTokenAgeSec` |
| cexdex | `feed.dexquote` vs spot book both directions; edge after fees+gas+slippage ≥ `minEdgeBps` | spot leg + DEX leg (same `OnchainAdapter` used for quote and fill) | immediate | `minEdgeBps 5–100 (25)` |
| convert | live: `POST /sapi/v1/convert/getQuote` vs book; demo: log-only synthetic | accept quote (live, `execute:true`) | n/a | `minEdgeBps`, `pollMs` |
| tokstock | `skills-http.tokenizedStock` vs reference deviation ≥ `devBps` | DEX leg | mean reversion / time stop | `devBps 20–200 (60)` |

`sizeUsd` is top-level only (not in params). Contracts published on tick; Commander reads via ledger/dashboard API.

## Related Code Files
- Create: `src/hot/engines/*.ts`, `config/engines.yaml`
- Create: `test/hot/engines/{liqfade,basis,smmirror,registry-reload}.test.ts` (fixtures from Phase 2)
- Modify: `src/main.ts`, `src/hot/feed-hub.ts` (VWAP, ADV from `/fapi/v1/ticker/24hr`)

## Implementation Steps
1. `engine.ts`: base class (cooldown, open-intent tracking, `emitIntent()` stamps `tSignalNs` + `paper`), per-engine zod params schema with bounds exported for Commander/`tools.ts`.
2. `registry.ts`: start/stop/reconfigure on `config.reload`; reject config whose `symbols` ⊄ `allowed_symbols` (log + keep previous).
3. `liqfade.ts`: per-symbol ring of forceOrder samples; score as specified; single intent per cascade (cooldown); exits via executor TP/SL + time stop.
4. `basis.ts`: rolling mean/std; 2-leg intent; demo spot leg paper.
5. `smmirror.ts`: tracker events → score → audit → intent; listing map from spot `exchangeInfo`.
6. `cexdex.ts`, `convert.ts`, `tokstock.ts`.
7. `imbalance.ts` helpers; liqfade uses for LIMIT vs MARKET.
8. Tests: replay `fixtures/liq-cascade-eth.ndjson` (sampled forceOrder + burst) → exactly one intent, expected side; a single large liquidation without burst → no intent; basis entry/exit on synthetic series; registry hot-reload; symbols outside whitelist rejected.

## Success Criteria
- [x] Replay yields one liqfade intent; single-sample decoy yields none
- [x] Editing `engines.yaml` (`liqfade.params.minGapBps`) applies ≤200 ms without restart (log line)
- [ ] Basis opens a perp leg on demo-fapi with a paper spot leg; both recorded in ledger with `paper` flags — GATED: needs demo-fapi key (paper-only verified)
- [x] Paper intents write `orders.status='PAPER'` and never call REST

## Risk Assessment
- Demo liquidations sparse → CLI replay + synthetic cascade generator; video labels replay explicitly.
- Params overfit in 2 days → conservative defaults; Coach tunes only inside bounds.
- Spot testnet + futures demo are separate accounts → basis spot leg paper in demo (documented).
