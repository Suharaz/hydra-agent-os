---
phase: 5
title: "LLM agents on OpenRouter + MCP bridge"
status: pending
priority: P1
effort: "2d"
dependencies: [1, 3]
---

# Phase 5: LLM agents on OpenRouter + MCP bridge

## Overview
Cold lane: minimal agent runtime over OpenRouter chat completions (tool calling + strict JSON-schema output), five agents each bound to its own model, a scheduler, a tool registry exposing ledger reads and bounded writes (engine config within bounds, tighten-only limits, budgets, kill), and an optional Binance MCP bridge for onboarding/showcase.

## Requirements
- Functional `llm.ts`: `chat({agent, messages, tools?, schema?})` → OpenRouter with per-agent `model`, `models` (fallbacks), `provider`, `temperature`, `max_tokens`; `response_format: json_schema strict` when `schema` given; records `llm_calls` (model actually used, tokens, cost, latency). Retry 429 with `Retry-After`; on 402 emit `system.llm_credits` and pause cold lane (hot lane + Guardian unaffected).
- Functional: model resolution `HYDRA_MODEL_<AGENT>` → `agents.yaml` → default. `agents.yaml` hot-reload via `watchAgents()`: scheduler re-reads model/shadow/interval on next run without restart. <!-- Updated: Validation Session 1 -->
- Functional shadow A/B: when `shadow_model` is set, `agent.ts` runs the same context through the shadow model in parallel (own tool-read access; write tools stubbed to "would-call" recorders); shadow decision is validated against the schema and stored in `agent_runs(role='shadow', applied=0)`; primary decision applied as usual. Metrics computed per run: cost, latency, `schema_valid`, `tool_rejections` (write-tool stubs that would have been rejected by bounds), `agreement_pct` = Jaccard over normalised patch set (Commander/Coach) or identical overlay/kill verdict (Supervisor) or budget vector cosine (Treasurer); `pnl_1h_usd` back-filled by a 1-h delayed job from `trades` attributed to engines the primary touched. Shadow spend counts toward `llm_daily_budget_usd`; shadow is paused first at 70% budget.
- Functional: all output schemas are **strict-compatible**: every property required (`nullable` instead of optional), `additionalProperties:false` everywhere, no `z.record`; per-engine params as explicit objects generated from engine schemas. A test converts each schema to JSON Schema and asserts strict rules.
- Functional agents and write scope (code-enforced):
  - **Commander** : reads regime stats, contracts, `engineStats`, NAV, latency; outputs `EnginePatch[]` — `enabled`, `symbols` (enum from `allowed_symbols`), `sizeUsd` ≤ engine cap, `params` within bounds, `paper` **only true→demote** in live (demo: both directions) → `writeEngines(patch,'commander')`. All-or-nothing per run.
  - **Risk Supervisor** : reads vetoes, drawdown, exposure, `latencyStats`, `engineStats`; outputs `LimitsOverlay` (tighten-only vs current effective) or `Kill{reason}` via `kill.now`. Cannot clear kill lock. Does not use MCP (MCP scopes cover the Agentic sub, not the hot-lane sub).
  - **Treasurer** : allocates `budgets.json[engine]` (Kelly-capped from `engineStats`), tracks `llm_daily_budget_usd` / `data_daily_budget_usd`; **no transfers** — proposes transfers as `reports/transfer-requests.md` for a human; pays x402 data invoices via `pay.buy` tool (Phase 6) within budget.
  - **Coach** : nightly post-mortem per engine from `trades`; proposes params within bounds; may demote live→paper; promotion is human `cli promote`; writes `reports/YYYY-MM-DD.md`.
  - **Sales** : performance summary; `pricing.set` within bounds (Phase 6); writes `reports/square-draft.md` (live posting by human via `square-post` skill).
- Functional MCP bridge : `@modelcontextprotocol/client` StreamableHTTP + OAuth provider + local callback; `tools/list` on connect; read-only whitelist for showcase (`cli mcp list|call`); `MCP=off` default. Fallback if DCR refused: `claude -p` with MCP configured, documented.
- Non-functional: agent loop hard timeout 60 s; ≤6 tool calls; `sanitize()` on all market-derived strings; per-agent mutex; daily LLM budget pauses Coach/Sales at 80%, Treasurer at 90%, never Supervisor.

## Architecture
```
src/cold/llm.ts, agent.ts (primary + shadow paths), tools.ts, scheduler.ts, sanitize.ts, schemas.ts, ab.ts (agreement + pnl_1h back-fill job)
src/cold/agents/{commander,supervisor,treasurer,coach,sales}.ts
src/cold/mcp/{client,oauth,store}.ts   #
```
Commander schema (strict-compatible):
```ts
const LiqfadeParams = z.object({ windowMs: z.number().min(1000).max(5000).nullable(), minGapBps: z.number().min(2).max(30).nullable(), /* … every param nullable */ }).strict();
const EnginePatch = z.object({
  engine: z.enum(['liqfade','basis','convert','smmirror','cexdex','tokstock']),
  enabled: z.boolean().nullable(), paper: z.boolean().nullable(),
  symbols: z.array(z.enum(ALLOWED_SYMBOLS_ALL)).nullable(), sizeUsd: z.number().min(0).nullable(),
  params: z.union([LiqfadeParams, BasisParams, /* … */]).nullable(),
  rationale: z.string().max(300),
}).strict();
const CommanderOut = z.object({ regime: z.enum(['LOW_VOL','NORMAL','HIGH_VOL','ILLIQUID']), patches: z.array(EnginePatch).max(8), notes: z.string().max(500) }).strict();
```
Tool registry: `ledger.pnlByEngine`, `ledger.engineStats`, `ledger.latencyStats`, `ledger.recentVetoes`, `ledger.openOrders`, `ledger.llmCostToday`, `engines.get`, `engines.patch` (bounds + whitelist + promotion rule), `limits.tighten` (vs effective), `budget.set` (≤ engine cap, sum ≤ NAV), `kill.now` (Supervisor only), `pay.buy` , `pricing.set` , `mcp.*` read .

OpenRouter request: `{ model, models, messages, tools, tool_choice:'auto', temperature, max_tokens, response_format:{type:'json_schema', json_schema:{name, strict:true, schema}}, provider:{require_parameters:true, allow_fallbacks:true, ...}, usage:{include:true} }`; headers `Authorization`, `HTTP-Referer`, `X-OpenRouter-Title`.

## Related Code Files
- Create: `src/cold/{llm,agent,tools,scheduler,sanitize,schemas}.ts`, `src/cold/agents/*.ts`, `src/cold/mcp/*.ts`
- Create: `test/cold/{llm-parse,schemas-strict,tools-bounds,limits-tighten-effective,promotion-rule,sanitize,budget-cap}.test.ts` with fake OpenRouter server
- Modify: `src/main.ts`, `src/cli.ts` (`agent run`, `mcp`), `config/agents.yaml`

## Implementation Steps
1. `schemas.ts`: zod→JSON Schema with strict transform; test asserts required=all keys and `additionalProperties:false` recursively.
2. `llm.ts` as specified; cost from `usage.cost` else `config/models.yaml` price table (optional).
3. `agent.ts`: messages, tool loop ≤6, schema validation with one corrective retry; persist `agent_runs` + `events.kind='agent.run'`; emit `agent.decision`; shadow path with recorder tools; both runs share `run_id`.
3b. `ab.ts`: agreement per agent type; hourly job fills `pnl_1h_usd`; `abMetrics()` consumer.
4. `tools.ts`: reads; guarded writes (bounds, whitelist enum, promotion rule by mode, tighten vs effective, budget caps, kill role check).
5. Commander + Supervisor prompts (include latency reality and rule list); Treasurer; Coach, Sales.
6. `scheduler.ts` + `cli agent run <name>`.
7. `sanitize.ts` + tests.
8. MCP bridge + `cli mcp list|call`.
9. Wire scheduler when `OPENROUTER_API_KEY` present; otherwise cold lane disabled with warning.

## Success Criteria
- [ ] `cli agent run commander` with model A then `HYDRA_MODEL_COMMANDER=<B>` → `llm_calls.model` shows A then B; strict schema accepted by a real OpenAI-family endpoint (no 400) — GATED: needs OPENROUTER_API_KEY (offline fake-chat tests pass)
- [x] With `shadow_model` set, one run produces two `agent_runs` rows sharing `run_id`, shadow `applied=0`, `agreement_pct` populated; after the back-fill job `pnl_1h_usd` is non-null; editing `agents.yaml` swaps the shadow model on the next run without restart
- [x] Supervisor on crafted ledger (drawdown 3.8%) emits tighten overlay; at 4.1% emits kill → demo account flat; overlay looser than current effective rejected (test)
- [x] Commander patch with symbol outside whitelist or `paper:false` in live is rejected (tests)
- [x] Daily LLM cap pauses Coach/Sales at 80%; Supervisor keeps running (test)
- [ ] `cli mcp list` returns tools after OAuth, or documented skip — GATED: MCP OAuth unverified; documented skip implemented

## Risk Assessment
- Provider strict support varies → `require_parameters:true` + `models[]` fallback + schema validation + retry; failed run leaves config unchanged.
- MCP DCR unverified → nothing depends on it.
- Shadow doubles LLM spend → budget ordering (shadow paused first); shadow never blocks the primary (independent timeout).
- Cost runaway → `max_tokens`, daily cap, dashboard visibility.
