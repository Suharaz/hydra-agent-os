---
phase: 1
title: "Foundation: repo, config, modes, bus, ledger, CLI"
status: pending
priority: P1
effort: "1d"
dependencies: []
---

# Phase 1: Foundation: repo, config, modes, bus, ledger, CLI

## Overview
Bootstrap the single-package Bun/TypeScript repo, typed config with per-agent OpenRouter model, mode/feature flags, in-process event bus, SQLite ledger (write-through for orders, batched for telemetry), structured logging, and the `cli.ts` skeleton every later phase extends.

## Requirements
- Functional: `bun run hydra --mode demo` boots, validates config/env, opens ledger, prints venue matrix, exits cleanly on SIGINT/SIGTERM and on Windows console close (`process.on('SIGHUP')` + `Bun` exit hooks).
- Functional: `config/agents.yaml` declares 5 agents, each with `model` (OpenRouter `provider/model[:variant]`), optional `shadow_model` (A/B, log-only), `fallback_models`, `temperature`, `interval`/`cron`, `provider` routing block. Env override `HYDRA_MODEL_<AGENT>`. `watchAgents()` hot-reloads the scheduler. <!-- Updated: Validation Session 1 - shadow_model + hot-reload -->
- Functional: operator-authenticated writes (`actor='operator'`, from dashboard Settings or CLI) may change `agents.yaml` and the two budget keys in `risk.yaml` (`llm_daily_budget_usd`, `data_daily_budget_usd`) at runtime; all other `risk.yaml` keys are file-only and require restart. LLM agents have no write path to either file.
- Functional: `config/risk.yaml` is code-owned and holds every safety constant, symbol whitelist, budgets and alert config (schema below).
- Functional: `src/cli.ts` exists from day one with verbs `intent | kill | unkill | promote | replay | agent run | mcp | buy | baw pair | scenario` — stubs that print "not implemented in this phase" until their phase lands.
- Non-functional: bus dispatch synchronous, zero allocation beyond the event object; ledger `orders`/`intents`/`fills`/`trades` writes are synchronous write-through (durable before the next network call); telemetry tables batched per 50 ms.
- Non-functional: no secrets in repo; `.env.example` documents every variable; `.gitignore` covers `state/`, `.env`, `reports/`, `bun.lock` is committed; all `@binance/*`, `@x402/*`, `@modelcontextprotocol/*` deps pinned exact.

## Architecture
```
src/
  core/env.ts       # zod-parsed process.env → Env {mode, spot, futures, onchain, x402, mcp, keys, dashboardToken, telegramBotToken, telegramChatId, alertWebhook, bawBin}
  core/config.ts    # loads+validates config/{agents,engines,risk,pricing}.yaml; watchEngines(), watchAgents(); writeAgents/writeBudgets(actor='operator'); atomic writes; single writer queue with content-hash CAS
  core/bus.ts       # typed EventEmitter<HydraEvents>; sync dispatch
  core/ledger.ts    # bun:sqlite WAL; write-through + batched APIs; read API
  core/log.ts       # JSON lines + 2k ring buffer
  core/types.ts     # Intent, Order, Fill, Trade, Position, Veto, OpportunityContract, AgentDecision, Payment, Limits, KillLock, Budgets
  core/clock.ts     # Bun.nanoseconds() monotonic; wall clock
  core/state.ts     # state/*.json helpers: limits.json (overlay), budgets.json, kill.lock — each with owner check
  core/alert.ts     # alert(level, msg): Telegram Bot API sendMessage (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) with retry; ALERT_WEBHOOK_URL generic fallback; used by kill.ts/guardian  <!-- Updated: Validation Session 1 - Telegram -->
  cli.ts            # verb router
  main.ts           # wiring by mode; shutdown order: agents → engines → executor → feed → ledger
```

Bus events (closed registry; payload types in `types.ts`):
`feed.depth`, `feed.trade`, `feed.liq`, `feed.mark` (includes fundingRate/nextFundingTime), `feed.onchain.smartmoney`, `feed.dexquote`, `engine.intent`, `engine.contract`, `kernel.veto`, `exec.order`, `exec.fill`, `exec.rollback`, `guardian.breach`, `system.kill`, `system.kill.failed`, `system.kill.cleared`, `system.throttle`, `system.llm_credits`, `config.reload`, `limits.reload`, `budgets.reload`, `agent.decision`.

Ledger tables (`id INTEGER PK`, `ts_ns INTEGER`, `ts_wall INTEGER` on all):
- `events(kind, json)` — batched
- `intents(engine, venue, symbol, side, qty, type, paper INT, t_signal_ns, json)` — write-through
- `orders(intent_id, venue, client_id UNIQUE, ext_id, status, t_sent_ns, t_ack_ns, latency_ms, json)` — write-through; inserted `PENDING` before REST send, updated after ACK
- `fills(order_id, venue, trade_id, price, qty, fee, fee_asset, UNIQUE(venue, trade_id))` — write-through
- `trades(engine, venue, symbol, opened_ns, closed_ns, qty, entry, exit, realized, fees, ret_bps)` — written by positions.ts on round-trip close (FIFO per engine/symbol)
- `vetoes(intent_id, rule, detail)`
- `positions_snap(json)` — batched
- `pnl_daily(engine, date, realized, fees, trades, wins, max_dd_bps)` — upserted by positions.ts on each `trades` insert and by guardian hourly
- `llm_calls(run_id, agent, role 'primary'|'shadow', model, prompt_tokens, completion_tokens, cost_usd, latency_ms, schema_valid INT, json)`
- `agent_runs(run_id UNIQUE, agent, role, model, decision_json, applied INT, tool_rejections INT, cost_usd, latency_ms, schema_valid INT, agreement_pct REAL NULL, pnl_1h_usd REAL NULL)` — one row per model per run; shadow rows never `applied` <!-- Updated: Validation Session 1 - A/B -->
- `payments(direction, counterparty, amount, asset, network, tx, json)`
- `config_changes(actor, path, before_hash, after_hash, diff)`
Read API: `pnlByEngine(sinceTs)`, `engineStats(engine, days)` → `{trades, hitRate, avgRetBps, sharpe, maxDdBps}` from `trades`, `latencyStats(sinceTs)` → p50/p95 from `orders.latency_ms`, `recentVetoes(n)`, `openOrders()`, `llmCostToday()`, `dataSpendToday()`, `abMetrics(agent, days)` → per model `{runs, costUsd, p50LatencyMs, schemaValidRate, toolRejectRate, agreementPct, pnl1hUsd}`.

`config/agents.yaml`:
```yaml
agents:
  commander:  { model: openai/gpt-5.6-luna, shadow_model: google/gemini-3.6-flash, interval: 5m, temperature: 0.2, fallback_models: [google/gemini-3.6-flash], provider: { require_parameters: true, allow_fallbacks: true } }
  supervisor: { model: google/gemini-3.6-flash,      interval: 1m,  temperature: 0.0 }
  treasurer:  { model: google/gemini-3.5-flash-lite, interval: 15m, temperature: 0.1 }
  coach:      { model: openai/gpt-5.6-luna,          cron: "0 0 * * *", temperature: 0.4 }
  sales:      { model: google/gemini-3.5-flash-lite, interval: 30m, temperature: 0.5 }
```
Model ids are placeholders — any OpenRouter id validated by `^[a-z0-9-]+/[a-z0-9._:-]+$`.

`config/risk.yaml` (code-owned; agents cannot write it):
```yaml
nav_usd_cap: 5000
max_net_delta_pct: 25
max_leverage: 3
min_liq_distance_pct: 15
max_orders_per_sec: 8
daily_drawdown_kill_pct: 4
nav_jump_alert_pct: 50            # guardian: NAV change > this in 1 min → pause + alert (testnet reset / venue glitch)
per_engine_max_notional_usd: { liqfade: 2000, basis: 2500, convert: 1000, smmirror: 300, cexdex: 800, tokstock: 300 }
onchain_max_notional_usd: 200
audit_ttl_sec: 600
allowed_symbols:
  futures: [BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT]
  spot:    [BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT]
  dex:     []                       # live: filled by human; paper: fixtures
llm_daily_budget_usd: 5
data_daily_budget_usd: 1
transfer_max_usd_per_day: 0       # 0 = no automated transfers, ever
kill_verify_attempts_before_alert: 3
```

`state/` files (owner enforced in `state.ts`):
- `limits.json` — overlay written only via `limits.tighten` (Supervisor tool); schema = subset of risk.yaml caps; `expires_at`.
- `budgets.json` — `{engine: budgetUsd}` written only via `budget.set` (Treasurer tool); kernel reads.
- `kill.lock` — `{reason, at, residue: {futures, spot, dex}}` written only by `kill.ts`; removed only by `cli unkill`.

## Related Code Files
- Create: `package.json`, `bunfig.toml`, `tsconfig.json`, `.env.example`, `.gitignore`, `README.md` (stub), `LICENSE`
- Create: `config/{agents,engines,risk,pricing}.yaml` (engines/pricing content filled in Phases 4/6)
- Create: `src/core/{env,config,bus,ledger,log,types,clock,state,alert}.ts`, `src/cli.ts`, `src/main.ts`
- Create: `test/core/{config,ledger,bus,state,limits-schema}.test.ts`

## Implementation Steps
1. `bun init`; deps: `zod`, `yaml`, `hono`; dev `@types/bun`. Strict TS, `noUncheckedIndexedAccess`. Commit `bun.lock`.
2. `env.ts`: zod schema; `HYDRA_MODE` derives defaults (`demo` → SPOT=testnet, FUTURES=demo, ONCHAIN=paper, X402=mock, MCP=off). Explicit flags override. `live` requires `HYDRA_I_UNDERSTAND_REAL_MONEY=1`. `DASHBOARD_TOKEN` required (auto-generated and printed if absent in demo). `ALERT_WEBHOOK_URL` optional (warn if absent in live). `BAW_BIN` absolute path required when ONCHAIN=live.
3. `types.ts`: `Intent {id, engine, venue:'spot'|'futures'|'dex', symbol, side, qty, type:'LIMIT'|'MARKET', price?, tp?, sl?, ttlMs, paper:boolean, tSignalNs:number, legs?: Intent[]}`; `OpportunityContract`; `Veto`; `Limits`; `KillLock`; `Budgets`; per-engine `EngineParams` union.
4. `bus.ts`: typed emitter over the registry above; test ensures every emitted event name in `src/**` is declared (grep-based test).
5. `ledger.ts`: WAL; tables; write-through methods (`insertIntent`, `insertOrderPending`, `updateOrderAck`, `insertFill`, `insertTrade`) run synchronously; batched methods for `events`, `positions_snap`; `busy_timeout=2000`; second read-only connection factory for dashboard.
6. `config.ts`: YAML → zod; `watchEngines(cb)` (`fs.watch` + 100 ms debounce + hash gate); `writeEngines(patch, actor)` through a single async write queue with CAS on file hash (retry once on mismatch), records `config_changes`.
7. `state.ts`: `readLimits/writeLimits(actor)`, `readBudgets/writeBudgets(actor)`, `readKillLock/writeKillLock(actor)/clearKillLock(actor)`; owner check throws on wrong actor; same write queue as config.
8. `alert.ts`: Telegram `sendMessage` with 3 retries; generic webhook fallback; no-op with log if neither configured (warn in live).
9. `cli.ts`: verb router + help; all verbs stubbed.
10. `main.ts`: `--mode`, venue matrix, ledger, signal handlers, module registration hooks.
11. Tests: config rejects unknown agent keys / bad model id; ledger `orders.client_id` unique + write-through survives `process.exit` mid-batch (spawn child, kill after insert); bus order; `state.ts` owner enforcement; risk.yaml schema requires `allowed_symbols`.

## Success Criteria
- [x] `bun run hydra --mode demo` prints venue matrix and exits 0 on SIGINT within 1 s
- [x] `bun test test/core` green
- [x] `HYDRA_MODE=live` without acknowledgement fails fast; `ONCHAIN=live` without `BAW_BIN` fails fast
- [x] `state/hydra.sqlite` has all 12 tables; killed child process leaves its `orders` row durable
- [x] `config.writeAgents({commander:{model:'x/y'}}, 'operator')` triggers `watchAgents` callback ≤200 ms; same call with actor `commander` throws
- [x] `bun run cli --help` lists all verbs

## Risk Assessment
- Bun `fs.watch` duplicate events on Windows → debounce + hash gate (signal: repeated `config.reload` same hash).
- Write-through sqlite adds ~0.1–0.5 ms per order → acceptable vs 200 ms network; measured in Phase 8.
- Windows console close bypasses SIGINT → boot-time recovery (Phase 3) is the real safety net; write-through ledger makes it possible.
