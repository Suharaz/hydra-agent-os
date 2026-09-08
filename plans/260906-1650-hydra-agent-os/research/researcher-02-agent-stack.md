# Researcher 02 — Agent Stack (OpenRouter · AI SDK · Binance Skills Hub · x402/B402 · MCP client)

Date: 2026-09-06. Scope: inputs for HYDRA cold-path (LLM agents) and mainnet-only integrations. All claims cite a URL; unverified ones are marked **[UNVERIFIED]**.

---

## 1. OpenRouter API

**Endpoint.** `POST https://openrouter.ai/api/v1/chat/completions` — OpenAI-compatible, streaming (`text/event-stream`, `[DONE]` sentinel) or JSON. Errors: 401 (auth), 402 (credits), 403 (guardrail), 408 (timeout), 413, 422. Source: https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion

**Model id format.** `vendor/model[:variant]`, e.g. `openai/gpt-4o`, `google/gemini-3-flash-preview`, `meta-llama/llama-3.3-70b-instruct`. Variants: `:nitro` (sort by throughput + priority tier), `:floor` (sort by price + flex tier), `:free`, `:thinking`. Source: https://openrouter.ai/docs/guides/routing/provider-selection

**Headers.**
- `Authorization: Bearer <OPENROUTER_API_KEY>` (required)
- `HTTP-Referer: <app url>` — required only for app attribution/rankings; not required for the call itself.
- `X-OpenRouter-Title: <app name>` — new name; **`X-Title` is still accepted for backwards compatibility**. Localhost apps must send title too.
- Optional: `X-OpenRouter-Categories`, `X-OpenRouter-App-Visibility: hidden`, `X-OpenRouter-Metadata: enabled` (returns `openrouter_metadata` routing info).
Source: https://openrouter.ai/docs/app-attribution

**Tool calling.** Standard OpenAI shape: request `tools:[{type:'function',function:{name,description,parameters}}]`; response `choices[0].message.tool_calls[{id,type:'function',function:{name,arguments:string}}]`; reply with `{role:'tool', tool_call_id, content}`. `tools` must be resent on every turn. When `tools`/`tool_choice` present, OpenRouter best-effort routes only to tool-capable providers. Filter: https://openrouter.ai/models?supported_parameters=tools . Source: https://openrouter.ai/docs/guides/features/tool-calling

**Structured output.** `response_format: { type:'json_schema', json_schema:{ name, strict:true, schema:{...additionalProperties:false} } }`. Support is per-endpoint, not per-model; enforcement varies by provider (some treat as hint). To guarantee routing only to endpoints supporting it set `provider.require_parameters: true`. Source: https://openrouter.ai/docs/guides/features/structured-outputs

**Provider routing / fallback (`provider` object in body).** Fields: `order:[slugs]`, `allow_fallbacks` (default true), `require_parameters`, `data_collection:'deny'`, `zdr`, `only:[]`, `ignore:[]`, `quantizations`, `sort:'price'|'throughput'|'latency'` (or `{by,partition}`), `preferred_min_throughput`, `preferred_max_latency`, `max_price:{prompt,completion}`. Default = price-weighted load balancing with outage avoidance; `order`/`sort` disables balancing. Model-level fallback via `models:[primary, fallback...]` (auto-router docs). Source: https://openrouter.ai/docs/guides/routing/provider-selection

**Cheap + strong model ids for agent loops (2026).** Prices are $/1M tokens in·out. The OpenRouter models page is JS-rendered and could not be scraped; the figures below come from a third-party roundup that states it read the live OpenRouter models API on 2026-07-23 — treat every price as **[UNVERIFIED]** and confirm on https://openrouter.ai/models before committing.

| Model id | $/M in·out | Ctx | Role fit |
|---|---|---|---|
| `google/gemini-3.5-flash-lite` | 0.30 · 2.50 | 1M | Sub-agents (Coach/Sales); ~350 tok/s |
| `kwaipilot/kat-coder-air-v2.5` | 0.15 · 0.60 | 256K | Cheap tool-loop agent |
| `poolside/laguna-s-2.1` (`:free` variant exists) | 0.10 · 0.20 | 1M | Cheapest capable open-weight; free tier for demo |
| `meituan/longcat-2.0` | 0.30 · 1.20 | ~1M | Long-horizon agent, open weight |
| `openai/gpt-5.6-luna` | 1.00 · 6.00 | 1.05M | Commander (reliable tools+JSON) |
| `google/gemini-3.6-flash` | 1.50 · 7.50 | 1M | Risk Supervisor default |
| `x-ai/grok-4.5` | 2.00 · 6.00 | 500K | Strong workhorse; EU availability caveat |
| `poolside/laguna-xs-2.1` | 0.06 · 0.12 | 256K | Cheapest paid rung |

Source: https://www.digitalapplied.com/blog/openrouter-new-models-july-2026-roundup-pricing (third-party). Canonical: https://openrouter.ai/models , https://openrouter.ai/collections/tool-calling-models . Check `structured_outputs`/`tools` in each model's provider table before use.

**TS SDK note.** OpenRouter now ships `@openrouter/sdk` (`new OpenRouter({apiKey, httpReferer, appTitle})`, `openRouter.chat.send({chatRequest:{...}})`) — another option but adds a dependency for little gain over fetch.

---

## 2. Vercel AI SDK vs plain fetch

**Packages.** `ai` (core) + `@openrouter/ai-sdk-provider`. Current provider line targets **`ai@^7.0.0`, requires Node ≥22, ESM-only**. Legacy pins: `@openrouter/ai-sdk-provider@2.9.1` for AI SDK v6, `@1.5.4` for v5. Usage: `createOpenRouter({apiKey, headers, extraBody})` → `openrouter('vendor/model')` → `generateText({model, tools, messages})` / `generateObject` / `streamObject({schema})`. OpenRouter-specific body (`provider`, `reasoning`) goes via `providerOptions.openrouter` or `extraBody`. Source: https://github.com/OpenRouterTeam/ai-sdk-provider (README)

**Bun.** The provider README states Node 22+ only; Bun is not mentioned. AI SDK core is fetch-based and generally runs under Bun, but **[UNVERIFIED]** for `ai@7` + this provider. Version numbers of `ai@7.x` exact patch: **[UNVERIFIED]** (not fetched from npm).

**Recommendation: plain `fetch` wrapper.** Rationale for HYDRA:
- 5 agents × configurable model id, `tools`, `response_format`, `provider` routing — all first-class in the raw body; AI SDK would need `extraBody` escape hatches anyway.
- Zero dependency risk on Bun; `fetch` + `JSON.parse` is native; ~100 LOC (`callLLM({model, messages, tools?, schema?, provider?})` returning `{content, toolCalls, usage}`) and a tiny tool loop.
- Deterministic, auditable request logs for a trading system (judges/risk review).
- If typed schemas are wanted, use Zod v4 `z.toJSONSchema()` to produce the `json_schema` block and `schema.parse()` the result — no SDK required.
AI SDK is only worth it if streaming UI (`useChat`) is needed; HYDRA's cold path is batch/cron-style.

---

## 3. Binance Skills Hub (`binance/binance-skills-hub`)

**Shape.** Each skill = `SKILL.md` (frontmatter `name`, `description`, `metadata.openclaw.requires.bins:[baw]`, `install:{kind:node, package:'@binance/agentic-wallet', bins:[baw]}`) + `references/*.md` (per-command syntax). **No scripts/ dirs, no Python** in the two skills inspected — the skill is pure prompt-doc that instructs the agent to run the **`baw` CLI** (Node ≥18, `npm install -g @binance/agentic-wallet`, agentic-wallet skill v1.11.0 requires CLI ≥1.9.0; tracker requires ≥1.6.2). Every command supports `--json`.
Sources: https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/SKILL.md , https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-wallet-tracker/SKILL.md

**Authentication (`binance-agentic-wallet`).** No env API keys. QR/pairing flow:
1. `baw auth signin --json` → `{urlForWeb, qrCodeId, expireAt, pairingCode}` (or `status:'ALREADY_CONNECTED'`).
2. Open `urlForWeb` (https://web3.binance.com/en/agent-login?...) in a browser; user confirms `pairingCode` in Binance Wallet App.
3. `baw auth verify --qrCodeId <id> --json` — **blocking foreground call, ≤5 min**; must not be killed. Errors: `AUTH_REJECTED` (10002004) → restart from signin.
4. Truth = `baw wallet status --json` (`UNCONNECTED` vs connected). `baw auth signout`. Session (`agentSessionId`) persisted locally by the CLI; can expire silently → re-read after writes.
Source: https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/authentication.md

Key commands for HYDRA Treasurer: `wallet balance`, `wallet send`, `market-order quote|swap`, `limit-order buy|sell|list|cancel`, `wallet settings` (daily limit / devMode), `x402-payment preview|sign`, `defi deposit|redeem`. State-changing ops expect user confirmation per skill policy. BSC token addresses in SKILL.md (USDT `0x55d398326f99059fF775485246999027B3197955`, USDC `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`, U `0xcE24439F2D9C6a2289F741120FE202248B666666`, USD1 `0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d`).

**Realtime (`binance-wallet-tracker`).** `baw tracker ws --smy|--kol|--wallet BSC,SOL|--address <a> -c <chainId>|--following --duration <s> --json`. It subscribes to Binance's "WSP" push internally and **writes one JSON push message per line to stdout** — the WebSocket URL is *not* exposed; it is a CLI process, not a URL. `--duration` required unless unlimited. Chains: BSC `56`, Solana `CT_501`, Base `8453`, ETH `1`. Other reads: `tracker token query -c 56 --tag-type smy --json`, `tracker tx query ... --json` (`ts` in seconds).
Source: https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-wallet-tracker/SKILL.md

**How a TypeScript/Bun program invokes them.** Spawn the CLI: `Bun.spawn(['baw','tracker','ws','--smy','--json','--duration','0'], {stdout:'pipe'})` and parse NDJSON lines; for one-shot commands `Bun.spawnSync(['baw','wallet','balance','--json'])` → `JSON.parse(stdout)` and check `success`. There is no documented HTTP API for the wallet; the CLI is the contract. Mainnet-only (real wallet); the demo build should stub the spawn boundary behind an interface. `baw` on Windows: **[UNVERIFIED]** (npm package, presumably works; run via `npx`/global bin).

---

## 4. x402 protocol & Binance B402

**Packages (Coinbase `x402` monorepo, TypeScript).** `@x402/core` (client/server/facilitator primitives), `@x402/evm` (Exact scheme, EIP-3009/Permit2), `@x402/svm`, HTTP integrations `@x402/hono`, `@x402/express`, `@x402/fastify`, `@x402/next`, `@x402/fetch` (client wrapper), `@x402/axios`, `@x402/paywall`, `@x402/mcp`, `@x402/extensions` (Bazaar). The older unscoped `x402`, `x402-express`, `x402-hono` packages are the v1 line — superseded **[UNVERIFIED that they are deprecated on npm]**. Source: https://github.com/coinbase/x402/blob/main/typescript/README.md

**Seller flow (verify + settle via facilitator).**
```ts
import { Hono } from 'hono';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL, createAuthHeaders: async () => ({ verify: {...}, settle: {...} }) });
const server = new x402ResourceServer(facilitator).register('eip155:56', new ExactEvmScheme());
app.use(paymentMiddleware({ 'GET /signals': { accepts: { scheme:'exact', price:'$0.10', network:'eip155:56', payTo:'0x…' } } }, server));
```
The middleware: returns 402 + `PAYMENT-REQUIRED` requirements → client re-sends with `PAYMENT-SIGNATURE` (base64 JSON containing EIP-712 signature + `authorization{from,to,value,validAfter,validBefore,nonce}` for EIP-3009) → middleware calls facilitator `/verify` (off-chain signature/balance/nonce checks) → runs handler → calls `/settle` (facilitator broadcasts `transferWithAuthorization`, sponsors gas) → `PAYMENT-RESPONSE` header with txHash. Bun serves Hono natively (`Bun.serve({fetch: app.fetch})`). Source: https://github.com/coinbase/x402/blob/main/typescript/packages/http/hono/README.md . Public Coinbase facilitator `https://facilitator.x402.org` (Base Sepolia demo) — BSC support there **[UNVERIFIED]**.

**Buyer side via Binance wallet.** `baw x402-payment preview --paymentRequirements <b64|json>` → options (status `READY_TO_SIGN`, `assetTransferMethod` eip3009|permit2|spl-transfer) → `baw x402-payment sign --paymentId --selectedIndex` → `{paymentHeaderName:'PAYMENT-SIGNATURE', paymentHeaderValue, signatureExpiresAt}`; replay request with that header. Only x402 **v2**; BSC/Base/Solana. Source: https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/x402-payment.md

**Binance B402 (facilitator).**
- Marketing page: https://www.binance.com/binancex402 — "transaction verification and submission API", multi-token (USDT, USDC, U, USD1), gas sponsorship; sample payload uses `network: 'eip155:56'` and EIP-3009 `authorization`.
- Developer docs: https://developers.binance.com/en/docs/products/onchainpay-x402/introduction — B402 = Binance's x402 facilitator on BSC; endpoints `POST {BASE_URL}/papi/v2/b402/supported|verify|settle` (x402 v2 wire-compatible with CDP; V1 `/papi/v1/b402/*` legacy).
- **Facilitator URL is NOT public**: `{BASE_URL}` for Sandbox (BSC Testnet, chain 97) and Production (chain 56) is "contact us" — issued with merchant onboarding (clientId, RSA public key registration, IP whitelist). Requests must be RSA-SHA256 signed with `clientId`/`accessToken`. Apply: https://forms.gle/aUQvxUETfGMzyTky5 . Source: https://developers.binance.com/en/docs/products/onchainpay-x402/basics/4.base-urls
- Public no-auth discovery (Bazaar): `https://www.binance.com/bapi/ramp/v1/public/ramp/b402/bazaar/{resources,search,merchant}` (BAPI envelope, payload in `data`).
- Settle semantics: async; always HTTP 200; `success:true`+`transaction` = settled; `success:false`+`transaction:''` = terminal fail; `success:false`+hash = pending → poll `/settle` (idempotent per `(nonce,network,payer)`) at 3–5 s for ≥ `maxTimeoutSeconds` (backend reconciles ~30 min). Source: https://developers.binance.com/en/docs/products/onchainpay-x402/open-apis-v2/3.settle-payment
- Implication: B402 as facilitator via `HTTPFacilitatorClient` needs a custom `createAuthHeaders` implementing Binance RSA signing and path mapping (`/verify`→`/papi/v2/b402/verify`) — **[UNVERIFIED]** that `HTTPFacilitatorClient` path layout matches without a thin adapter.

**Chain / assets (BSC mainnet, `eip155:56`).**
| Token | Address | Methods |
|---|---|---|
| USDT | `0x55d398326f99059fF775485246999027B3197955` | permit2-exact, permit2-upto (**no eip3009**) |
| USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | permit2-exact, permit2-upto (**no eip3009**) |
| U | `0xcE24439F2D9C6a2289F741120FE202248B666666` | eip3009, permit2-* |
| USD1 | `0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d` | eip3009, permit2-* |
EIP-712 domain for B402 examples: USDC `{name:'USD Coin',version:'2'}`, USDT `{name:'Tether USD',version:'1'}`. Note the B402 settle example shows an `eip3009` USDC payload while the intro table says USDC is permit2-only — conflict; trust the table, treat USDC/USDT eip3009 on BSC as **[UNVERIFIED]**. Source: https://developers.binance.com/en/docs/products/onchainpay-x402/introduction

---

## 5. `@modelcontextprotocol` TypeScript client — StreamableHTTP + OAuth

**Packages.** SDK **v2** (stable, spec 2026-07-28) is split: `@modelcontextprotocol/client` and `@modelcontextprotocol/server`; explicitly runs on **Node, Bun, Deno** (`bun add @modelcontextprotocol/client`). v1 (`@modelcontextprotocol/sdk`) stays on the `v1.x` branch with ≥6 months of fixes; v1 import paths were `@modelcontextprotocol/sdk/client/index.js` and `.../client/streamableHttp.js`. Source: https://github.com/modelcontextprotocol/typescript-sdk (README)

**Minimal shape (v2), Bun process, remote OAuth MCP (e.g. `https://agent.binance.com/mcp/agentic`):**
```ts
import { Client, StreamableHTTPClientTransport, UnauthorizedError, IssuerMismatchError,
  type OAuthClientProvider, type OAuthTokens, type OAuthClientMetadata,
  type OAuthClientInformationMixed, type OAuthClientInformationContext, type OAuthDiscoveryState } from '@modelcontextprotocol/client';

class FileOAuthProvider implements OAuthClientProvider {
  private creds = new Map<string, OAuthClientInformationMixed>();
  private t?: OAuthTokens; private verifier?: string; private disc?: OAuthDiscoveryState; lastState?: string;
  readonly redirectUrl = 'http://localhost:8090/callback';
  readonly clientMetadata: OAuthClientMetadata = { client_name: 'HYDRA', redirect_uris: [this.redirectUrl], application_type: 'native' };
  clientInformation(ctx?: OAuthClientInformationContext) { return ctx ? this.creds.get(ctx.issuer) : undefined; }
  saveClientInformation(i: OAuthClientInformationMixed, ctx?: OAuthClientInformationContext) { if (ctx) this.creds.set(ctx.issuer, i); }
  tokens() { return this.t; }  saveTokens(t: OAuthTokens) { this.t = t; /* persist to disk/keychain */ }
  state() { this.lastState = crypto.randomUUID(); return this.lastState; }
  saveDiscoveryState(s: OAuthDiscoveryState) { this.disc = s; }  discoveryState() { return this.disc; }
  redirectToAuthorization(url: URL) { console.log('Open:', url.href); /* or Bun.spawn(['cmd','/c','start',url.href]) */ }
  saveCodeVerifier(v: string) { this.verifier = v; }  codeVerifier() { if (!this.verifier) throw new Error('no verifier'); return this.verifier; }
}

const url = new URL('https://agent.binance.com/mcp/agentic');
const provider = new FileOAuthProvider();
const client = new Client({ name: 'hydra', version: '0.1.0' });
let transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
try { await client.connect(transport); }
catch (e) {
  if (!(e instanceof UnauthorizedError)) throw e;
  // Bun.serve on :8090 receives /callback?code&state&iss
  const params = await waitForCallback();            // URLSearchParams
  if (params.get('state') !== provider.lastState) throw new Error('state mismatch');
  try { await transport.finishAuth(params); } catch (err) { if (err instanceof IssuerMismatchError) throw new Error('issuer mismatch'); throw err; }
  transport = new StreamableHTTPClientTransport(url, { authProvider: provider }); // fresh transport
  await client.connect(transport);
}
const { tools } = await client.listTools();
const res = await client.callTool({ name: tools[0].name, arguments: {} });
```
Flow: SDK does RFC 9728/8414 discovery, dynamic client registration (or reuses saved creds keyed by issuer), PKCE, RFC 8707 `resource` binding, redirects user; `connect()` throws `UnauthorizedError`; `finishAuth(params)` validates RFC 9207 `iss` and exchanges code; reconnect on a fresh transport. Persisted `tokens()` skip the browser on later runs. Source: https://ts.sdk.modelcontextprotocol.io/v2/clients/oauth.html . Whether Binance's MCP supports DCR vs. requiring a pre-registered client id: **[UNVERIFIED]** (sibling researcher covers Binance MCP specifics). `listTools`/`callTool` method names in v2 high-level client: **[UNVERIFIED]** (v1 names; check v2 API ref https://ts.sdk.modelcontextprotocol.io/v2/api/).

---

## Recommended LLM stack (one choice)

**Plain `fetch` → OpenRouter `/api/v1/chat/completions`**, with a ~100-line `llm.ts`: per-agent `{model, provider:{require_parameters:true, allow_fallbacks:true, order?}}`, `tools` array, `response_format` json_schema (Zod→JSON Schema), `HTTP-Referer` + `X-OpenRouter-Title` headers, `usage` capture for the Treasurer's cost ledger. Skip Vercel AI SDK (Node 22-only provider line, Bun unverified) and `@openrouter/sdk` (no added value). Default model matrix for demo: Commander `openai/gpt-5.6-luna`, Risk `google/gemini-3.6-flash`, Treasurer/Coach/Sales `google/gemini-3.5-flash-lite`, all overridable by env — prices [UNVERIFIED], confirm on openrouter.ai/models.