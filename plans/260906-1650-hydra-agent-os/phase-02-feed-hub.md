---
phase: 2
title: "Feed Hub: Binance WS + on-chain adapters"
status: pending
priority: P1
effort: "1.5d"
dependencies: [1]
---

# Phase 2: Feed Hub: Binance WS + on-chain adapters

## Overview
Single in-memory bus fed by Binance futures/spot WebSocket streams, user-data streams with gap recovery, and on-chain data through one `OnchainAdapter` interface (`PaperAdapter` in demo, `BawAdapter` live) plus `SkillsHttp` for Skills Hub public HTTP APIs (real in demo). Maintains local order books with an explicit `synced` flag.

## Requirements
- Functional: futures streams `depth@100ms` (`/public`), `aggTrade`, `markPrice@1s`, `forceOrder`, `!forceOrder@arr` (`/market`), user data (`/private`); spot `bookTicker`, `trade`, user-data via WS-API `userDataStream.subscribe.signature`. Routed paths on `demo-fstream` verified (101 upgrade on `/market`, `/public`, `/ws`); keep `/ws` fallback probe anyway.
- Functional: local L2 book per futures symbol with snapshot+diff sync (`GET /fapi/v1/depth?limit=1000`, `pu === lastU` gap rule, resync on gap). `book.synced` and `book.ageMs` exposed; engines must check.
- Functional: `forceOrder` semantics documented in code: Binance pushes only the largest liquidation per symbol per 1000 ms — the stream is a sampled signal, not a sum. Feed Hub also maintains a 1-s one-sided aggTrade volume burst per symbol and mark−index gap for engines.
- Functional: fill recovery — on `/private` reconnect, `listenKeyExpired`, or boot: `GET /fapi/v1/userTrades?symbol&fromId=<last trade_id per symbol>` and spot `GET /api/v3/myTrades?fromId`; synthesize `exec.fill` for unseen trades; `fills` dedup by `UNIQUE(venue, trade_id)`.
- Functional: `SkillsHttp` — public no-auth Skills Hub endpoints: token audit (`POST https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit`), token info/leaderboard/tokenized-stock queries as documented in the corresponding `SKILL.md` references; results cached with TTL; used in demo and live.
- Functional: smart-money events from `baw tracker ws --smy --json` (live) or NDJSON replay (paper) → `feed.onchain.smartmoney`.
- Functional: DEX quotes via `OnchainAdapter.quote(pair)` every 2 s → `feed.dexquote`; single source used by both signal and fill simulation (no second quote generator).
- Non-functional: p99 parse→emit < 1 ms; reconnect with jittered backoff; 23-h rotation; ≤10 outbound msgs/s/connection; ≤3 futures connections; server-time offset per base URL (`/fapi/v1/time`, `/api/v3/time`) refreshed every 5 min and on `-1021`.
- Non-functional: `baw` invoked only via absolute `BAW_BIN`; boot check `baw --version ≥ 1.9.0` and resolved package name `@binance/agentic-wallet`; never `npx baw`.

## Architecture
```
src/venues/binance/ws.ts          # raw Bun WebSocket, combined-stream parsing, reconnect, rotation, counters
src/venues/binance/sign.ts        # HMAC-SHA256; signedQuery(base, params) uses per-base server-time offset
src/venues/binance/time-sync.ts   # offset per base URL
src/venues/binance/rest-futures.ts, rest-spot.ts
src/venues/binance/userdata.ts    # futures listenKey (POST/PUT, verified exists on demo) → /private/ws; listenKeyExpired handler; spot WS-API signature subscribe
src/venues/binance/recovery.ts    # userTrades/myTrades fromId replay → exec.fill
src/venues/binance/urls.ts        # mode → URL matrix; boot probe
src/venues/onchain/adapter.ts     # OnchainAdapter { quote, swap, walletStatus, trackerStream }
src/venues/onchain/paper-adapter.ts
src/venues/onchain/baw-adapter.ts # spawn wrapper (BAW_BIN), run()/stream(); swap() implemented in Phase 6
src/venues/onchain/skills-http.ts # audit(token), tokenInfo(), leaderboardScore(addr), tokenizedStock(ticker); TTL cache
src/hot/feed-hub.ts               # connections, books, burst/gap state; read API for engines
src/hot/book.ts                   # L2 book with synced/ageMs
fixtures/smartmoney.ndjson, fixtures/liq-cascade-eth.ndjson (recorded forceOrder snapshots + aggTrade burst), fixtures/audit.json
```
URL matrix:
| Venue | demo | live |
|---|---|---|
| Futures REST | `https://demo-fapi.binance.com` | `https://fapi.binance.com` |
| Futures WS | `wss://demo-fstream.binance.com` | `wss://fstream.binance.com` |
| Spot REST | `https://testnet.binance.vision/api` | `https://api.binance.com/api` |
| Spot WS-API | `wss://ws-api.testnet.binance.vision/ws-api/v3` | `wss://ws-api.binance.com/ws-api/v3` |
| Spot streams | `wss://stream.testnet.binance.vision` | `wss://stream.binance.com:9443` |
| Mainnet public spot bookTicker (signal only, demo) | `wss://stream.binance.com:9443` | — |

## Related Code Files
- Create: `src/venues/binance/{ws,sign,time-sync,rest-futures,rest-spot,userdata,recovery,urls,symbols}.ts`
- Create: `src/venues/onchain/{adapter,paper-adapter,baw-adapter,skills-http}.ts`
- Create: `src/hot/{feed-hub,book}.ts`, fixtures above
- Create: `test/hot/book.test.ts`, `test/venues/{ws-parse,recovery-dedupe,baw-bin-check}.test.ts`
- Modify: `src/main.ts`, `src/cli.ts` (`replay` verb)

## Implementation Steps
1. `time-sync.ts` + `sign.ts` with per-base offset.
2. `ws.ts`: `/ws/<s1>/<s2>` builder; single `JSON.parse`; dispatch by `e`; reconnect backoff 0.5→30 s jittered; 23-h rotation; counters.
3. `book.ts`: `applySnapshot`, `applyDiff` with gap rule → `synced=false` + resync; `imbalance(n)`, `microprice()`, `ageMs`.
4. `feed-hub.ts`: per symbol subscribe; buffer diffs until snapshot; emit `feed.depth` only when synced; `forceOrder` → `feed.liq`; maintain per-symbol `burst = {buyUsd1s, sellUsd1s}` from aggTrade and `gapBps = (mark−index)/index` from markPrice; `feed.mark` includes funding fields.
5. `userdata.ts`: futures listenKey lifecycle (keepalive 30 min; on `listenKeyExpired` re-POST + reconnect); spot WS-API signature subscribe; emit `exec.order`/`exec.fill`.
6. `recovery.ts`: track last `trade_id` per venue/symbol in ledger; on reconnect/boot pull `fromId`, insert unseen fills (dedupe by UNIQUE), emit `exec.fill`.
7. `baw-adapter.ts`: `Bun.spawn([env.bawBin, ...args, '--json'])`; boot check version + package name (read `package.json` next to resolved bin); `trackerStream()`; `quote()`; `swap()` stub (Phase 6). ONCHAIN=paper → never spawned.
8. `paper-adapter.ts`: tracker replay from fixture with `REPLAY_SPEED`; `quote()` = mainnet spot mid ± random walk 0–40 bps; `swap()` fills at last quote ± slippage (Phase 6 wires executor).
9. `skills-http.ts`: audit + token info + leaderboard score with TTL cache; fixtures used only when `SKILLS_HTTP=off` (tests).
10. Demo signal source for basis: subscribe mainnet public spot `bookTicker` (no auth) when `SPOT=testnet` so basis measures real basis; testnet spot book still used for spot execution/fills.
11. `cli replay <fixture>` feeds events into the bus with original timing.
12. Tests: book gap → resync; recovery inserts only unseen trades; `BAW_BIN` check rejects wrong package; WS parser combined/raw.

## Success Criteria
- [ ] `bun run hydra --mode demo` logs `futures ws connected (3 sockets, routed=true)` and `spot ws-api authenticated`; dashboard counter (Phase 7) or log shows >50 depth updates/s for BTCUSDT — GATED: needs demo-fapi/testnet keys (WS auth path unverified)
- [ ] Simulated 20-s network drop during an open order → after reconnect the fill appears exactly once in `fills` (test with fake REST) — GATED: fake-REST test exists; real user-stream drop unverified
- [x] `cli replay fixtures/liq-cascade-eth.ndjson` emits `feed.liq` + burst updates
- [x] `skills-http.audit('0x…honeypot')` returns risk level from the real endpoint in demo
- [x] ONCHAIN=live with a wrong `BAW_BIN` refuses to boot

## Risk Assessment
- Skills Hub public endpoints may rate-limit or change → TTL cache 10 min, fixture fallback only in tests; signal: HTTP≠200 → audit-cache miss → kernel rule 9 vetoes DEX intents (safe).
- Spot testnet monthly reset → Guardian NAV-jump alert pauses spot engines (Phase 3); documented.
- `baw` on Windows unverified → live on-chain documented for Linux/WSL.
