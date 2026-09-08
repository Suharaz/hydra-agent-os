# Researcher 01 — Binance API surface for HYDRA (demo + mainnet)

Date: 2026-09-06. All claims cite URLs; unverified items are marked **[UNVERIFIED]**.

---

## 1. USDⓈ-M Futures demo (demo-fapi.binance.com / demo-fstream.binance.com)

### Base URLs (official)
- REST testnet/demo: `https://demo-fapi.binance.com`; WebSocket: `wss://demo-fstream.binance.com` — https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info ("Testnet API Information").
- Mainnet REST `https://fapi.binance.com`; mainnet streams `wss://fstream.binance.com`; mainnet WS-API `wss://ws-fapi.binance.com/ws-fapi/v1` (connector constants: https://raw.githubusercontent.com/binance/binance-connector-js/master/common/src/constants.ts).
- The legacy futures testnet host `testnet.binancefuture.com` is still hard-coded as `*_TESTNET_URL` in the official JS connector, and `demo-fapi.binance.com` is exposed as `DERIVATIVES_TRADING_USDS_FUTURES_REST_API_DEMO_URL` (same constants file). There is **no** WS-streams/WS-API DEMO constant in the connector; pass `wsURL: 'wss://demo-fstream.binance.com'` manually. Whether `wss://demo-fstream.binance.com` honours the new `/public` `/market` `/private` routed paths: **[UNVERIFIED]** — test both `wss://demo-fstream.binance.com/ws/<stream>` and `/market/ws/<stream>` at startup.

### IMPORTANT: mainnet WS base-URL split (applies to fstream; probably demo)
Source: https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Important-WebSocket-Change-Notice and .../websocket-market-streams/Connect
- `/public` — high-frequency public data: `<symbol>@bookTicker`, `!bookTicker`, `<symbol>@depth<levels>[@500ms|@100ms]`, `<symbol>@depth[@500ms|@100ms]`.
- `/market` — regular market data: `<symbol>@aggTrade`, `<symbol>@markPrice` / `<symbol>@markPrice@1s`, `!markPrice@arr[@1s]`, `<symbol>@kline_<interval>`, `<symbol>@miniTicker`, `!miniTicker@arr`, `<symbol>@ticker`, `!ticker@arr`, **`<symbol>@forceOrder`**, **`!forceOrder@arr`**, `<symbol>@compositeIndex`, `!contractInfo`, `!assetIndex@arr`.
- `/private` — user data: `wss://fstream.binance.com/private/ws?listenKey=<lk>&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE` or `/private/stream?listenKey=..&events=..&listenKey=..&events=..`.
- Access modes: `ws` (`/ws/<s1>/<s2>`) and `stream` (`/stream?streams=<s1>/<s2>`); combined payload `{"stream":"<name>","data":<raw>}`; symbols lowercase.
- Unrouted URLs (`/ws`, `/stream`) only deliver `/public` streams now and are decommissioned **2026-04-23**. E.g. `wss://fstream.binance.com/ws/btcusdt@markPrice` no longer pushes data.

### Exact stream names HYDRA needs
| Need | Stream | Routed endpoint |
|---|---|---|
| Per-symbol liquidations | `btcusdt@forceOrder` | `/market` |
| All-market liquidations | `!forceOrder@arr` | `/market` |
| Diff depth 100ms | `btcusdt@depth@100ms` | `/public` |
| Agg trades | `btcusdt@aggTrade` | `/market` |
| Mark price 1s | `btcusdt@markPrice@1s` | `/market` |

Recommended connections (per the notice): one `/public` socket for depth, one `/market` socket for aggTrade+markPrice+forceOrder, one `/private` socket for user data.

### WS connection limits (Connect page)
- Connection valid 24h; server pings every 3 min, must pong within 10 min; unsolicited pongs allowed.
- **10 incoming messages/sec per connection**; **1024 streams per connection**; violators disconnected, repeat offenders IP-banned.

### REST rate limits (general-info)
- Limits are per IP (weight) and per account (orders); headers `X-MBX-USED-WEIGHT-1M`, `X-MBX-ORDER-COUNT-1M`; 429 → back off, 418 = IP ban 2 min–3 days. Concrete numbers come from `GET /fapi/v1/exchangeInfo.rateLimits`; mainnet defaults are 2400 weight/min, 1200 orders/min, 300 orders/10s **[UNVERIFIED — not re-fetched this session; read exchangeInfo at boot]**.
- `-1008` system-throttle: reduce-only/close-position orders exempt; 503 variants and retry semantics documented in general-info.
- `recvWindow` default 5000, keep ≤5000.

### User-data stream listenKey on demo
- Endpoint `POST /fapi/v1/listenKey` (USER_STREAM, API key header only), keepalive `PUT`, close `DELETE`, key lasts 60 min and must be extended — this is the long-standing contract; the specific doc page (…/user-data-streams/Connect) did not render in this session, so treat as **[UNVERIFIED on demo]**; general-info says "Most of the endpoints can be used in the testnet platform". Connector README also exposes it via `client.restAPI` for whatever `basePath` you set.

### API key types on demo
- Demo keys are created at https://demo.binance.com/en/my/settings/api-management (**Create API**) — Binance FAQ https://www.binance.com/en/support/faq/detail/ab78f9a1b8824cf0a106b4229c76496d (updated 2025-10-06). Quick-start: https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/quick-start.
- **HMAC-SHA256**: verified (general-info signing examples). **RSA**: verified (general-info has RSA PKCS#8 example). **Ed25519**: the FAQ links the Ed25519 key-pair guide from the demo section and the official connector supports `privateKey` RSA/ED25519 for `/fapi`, but the futures general-info page shows only HMAC/RSA examples → Ed25519 on demo-fapi is **[UNVERIFIED]**. Safe default: HMAC for the futures hot path.

---

## 2. Spot testnet (testnet.binance.vision)

Sources: https://developers.binance.com/en/docs/products/spot/testnet/rest-api , https://developers.binance.com/en/docs/products/spot/testnet/web-socket-api , https://developers.binance.com/en/docs/products/spot/user-data-stream

- REST base: `https://testnet.binance.vision/api`; WS-API: `wss://ws-api.testnet.binance.vision/ws-api/v3` (alt port 9443); streams: `wss://stream.testnet.binance.vision` (connector constant). Keys via GitHub login on testnet.binance.vision ("Generate HMAC_SHA256 Key" or "Register Public Key" for RSA/Ed25519). HMAC, RSA, Ed25519 all supported; docs recommend Ed25519. Testnet resets ~monthly.
- **User data stream**: the Spot user-data-stream page now says "Subscribe via the WebSocket API using an API Key". Two methods on the WS-API:
  - `userDataStream.subscribe` — requires an authenticated session via `session.logon`, which **requires Ed25519 keys**.
  - `userDataStream.subscribe.signature` — works in any session with `apiKey`+`timestamp`+`signature` (any key type). Weight 2; up to 1,000 active subs per session; events arrive as `{subscriptionId, event}`.
  - The testnet REST doc contains **no `listenKey` endpoints** (grep of the full page: 0 hits for `listenKey`/`userDataStream`), i.e. `POST /api/v3/userDataStream` is gone from Spot testnet docs. Use the WS-API subscription. (Removal changelog date **[UNVERIFIED]**.)
- **`POST /api/v3/order` `newOrderRespType`**: `ACK`, `RESULT`, or `FULL`; MARKET/LIMIT default to FULL, others default to ACK — verified in testnet REST doc (New order params table + "Response - RESULT" example). Same param on `order.place` in WS-API.
- **Convert (`/sapi/v1/convert/*`)**: `/sapi/*` has no testnet — stated in the (deprecated) official TS connector README: "While `/sapi/*` endpoints don't have testnet environment yet, `/api/*` endpoints can be tested in Spot Testnet" (https://github.com/binance/binance-connector-typescript). Testnet base is `/api` only. → Treasurer's Convert must be mainnet-only or mocked in demo mode.
- New observation: connector constants also define Spot **DEMO** URLs `https://demo-api.binance.com`, `wss://demo-ws-api.binance.com/ws-api/v3`, `wss://demo-stream.binance.com:9443` — live status **[UNVERIFIED]**; stick with testnet.binance.vision as specified.
- Spot WS-API rate limits (example in doc): ORDERS 50/10s, 160000/day; REQUEST_WEIGHT 6000/min; server pings every 20s, pong within 1 min.

---

## 3. Sub-accounts on mainnet

Sources: https://www.binance.com/en/support/faq/detail/360020632811 , https://developers.binance.com/en/docs/agent-native/mcp-server/agentic , https://developers.binance.com/legacy-docs/binance_link/exchange-link/account/Create-Api-Key-for-Sub-Account (search hit)

- Normal sub-accounts (email, virtual-email, or 3rd-party custodian) are created by the master (regular users: max 5; KYC + 2FA required). **Virtual-email subs can only be operated via API and cannot log in**; the master creates their API keys.
- **API keys for sub-accounts are created by the master in Dashboard → Sub Accounts → API Management; up to 30 keys per sub-account** (FAQ). A sub-account with a real email can also log in and create its own keys in its own API Management **[UNVERIFIED — FAQ describes master-side creation only]**.
- Programmatic key creation `POST /sapi/v1/sub-account/subAccountApi` ("Create Api Key for Sub Account") is documented only under **Binance Link / Exchange Link (broker)** docs, not for retail masters. Retail master endpoints under `/sapi/v*/sub-account/subAccountApi/ipRestriction` manage IP restriction of existing sub keys (page did not render this session; **[UNVERIFIED]**).
- **Agentic virtual sub** (created by the MCP onboarding): the MCP doc lists exactly four UI actions (Transfer, View permissions, Disconnect agents, Emergency stop). It does **not** document API-key creation for Agentic subs; access is via OAuth scopes through the MCP server only. Whether an HMAC/Ed25519 API key can be issued for an Agentic virtual sub: **[UNVERIFIED — not found anywhere]**. Funding is manual via Sub-account → Asset Management → Transfer; the agent cannot pull from the master.

---

## 4. Official TypeScript/JS SDKs

Sources: https://github.com/binance/binance-connector-typescript , https://github.com/binance/binance-connector-js , https://raw.githubusercontent.com/binance/binance-connector-js/master/clients/derivatives-trading-usds-futures/README.md , constants.ts (above)

- `@binance/connector-typescript` — **DEPRECATED** (README banner); Spot `/api` + `/sapi` only, no `/fapi`. Do not use.
- `binance-connector-js` — current, auto-generated (OpenAPI Generator), Node ≥ 22.12, MIT, one npm package per product:
  - `@binance/spot` (REST `/api`, WS-API, WS streams), `@binance/derivatives-trading-usds-futures` (`/fapi`, WS-API, WS streams), `@binance/convert`, `@binance/sub-account`, `@binance/wallet`, `@binance/margin-trading`, etc.
  - Config: `configurationRestAPI: { apiKey, apiSecret | privateKey (RSA/ED25519), basePath, timeout(1000ms default), retries(3), backoff, keepAlive, compression, httpsAgent, proxy }`; `configurationWebsocketAPI: { wsURL, mode: 'single'|'pool', poolSize, reconnectDelay }`; `configurationWebsocketStreams: { wsURL, mode, poolSize }`.
  - `basePath`/`wsURL` are free-form → point at `https://demo-fapi.binance.com` and `wss://demo-fstream.binance.com`. Exported constants: `DERIVATIVES_TRADING_USDS_FUTURES_REST_API_DEMO_URL`, `SPOT_REST_API_TESTNET_URL`, `SPOT_WS_API_TESTNET_URL`, `SPOT_WS_STREAMS_TESTNET_URL` (from `@binance/common`). Futures WS constants still point at `testnet.binancefuture.com`/`fstream.binancefuture.com` (stale for demo).
  - WS streams client: `client.websocketStreams.connect().then(conn => conn.allBookTickersStream() / aggTradeStreams(...) ...)`, `stream.on('message', …)`. Whether the generated stream client already emits the new `/public|/market` routed paths: **[UNVERIFIED]** — for the <100 ms hot path, a raw Bun `WebSocket` to the exact routed URL is simpler and avoids Node-only deps (`ws`, axios). Bun compatibility of the connector (it targets Node ≥22.12): **[UNVERIFIED]**.

---

## 5. Binance MCP server

Source: https://developers.binance.com/en/docs/agent-native/mcp-server/agentic (raw .md fetched)

- Endpoint: `https://agent.binance.com/mcp/agentic`; transport **HTTP (Streamable HTTP)**; auth **OAuth** with a Binance "Agentic Account Access" consent screen; trades inside a dedicated **Agentic virtual sub-account**; **no withdrawal scope**; every write (order/cancel/transfer) is confirm-before-execute. Mainnet only.
- Scopes chosen at connect: Market data (public), Account (sub balance/positions/bills + optional read-only main), Trade (spot, margin, convert, USDⓈ-M, COIN-M), Transfer (intra-sub wallet moves only).
- **Tool names are NOT listed** in the doc (only capability categories: tickers, order books, candles, funding; balances; place/cancel orders; wallet transfers). → **[UNVERIFIED]**; enumerate via `tools/list` after connecting.
- Client setup / OAuth client ids:
  - Claude Code: `claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic` (no client id → implies dynamic client registration or a pre-registered Claude client).
  - Codex CLI / ChatGPT-Codex desktop: `codex mcp add binance-mcp-server --url https://agent.binance.com/mcp/agentic --oauth-client-id codex`.
  - Grok Bot: `oauth_client_id = "grok"`.
  - Claude Desktop (custom connector URL), ChatGPT web (Developer Mode plugin), VS Code (HTTP MCP server) — URL only.
  - "Other" platforms: contact support. So documented client ids are `codex` and `grok`; Claude/VS Code/ChatGPT use their built-in flows.
- **TS MCP client**: `@modelcontextprotocol/client` (SDK v2; v1 = `@modelcontextprotocol/sdk`) — `new StreamableHTTPClientTransport(url, { authProvider })` with an `OAuthClientProvider` implementing `clientInformation/saveClientInformation/tokens/saveTokens/redirectToAuthorization/codeVerifier/state/discoveryState`; `connect()` throws `UnauthorizedError` after redirect, then `transport.finishAuth(params)` and reconnect on a fresh transport. Docs: https://ts.sdk.modelcontextprotocol.io/v2/clients/oauth.html . The SDK performs discovery + dynamic client registration (DCR) automatically. Whether Binance's AS permits DCR for arbitrary clients, or requires a pre-registered `client_id` (`codex`/`grok`), is **[UNVERIFIED]** — try DCR first; fall back to supplying `clientInformation()` returning `{ client_id: 'codex' }` **[UNVERIFIED hack]**. Warning in the doc: do not open the endpoint in a browser or paste it into chat.
- Agentic Wallet skills (github.com/binance/binance-skills-hub): `skills/binance-web3/binance-agentic-wallet/` with references for authentication, market/limit orders, send, external-sign, and `x402-payment.md`; install via `npx skills add https://github.com/binance/binance-skills-hub`; credentials via env/.env. Contents of x402/B402 reference not read this session **[UNVERIFIED details]**.

---

## Implications for HYDRA plan
1. Futures hot path: three raw WebSockets (`/public` depth@100ms; `/market` aggTrade+markPrice@1s+forceOrder; `/private` listenKey) against `wss://demo-fstream.binance.com`; verify routed-path support on demo at boot and fall back to `/ws`.
2. Spot demo path: REST `testnet.binance.vision/api` for orders (`newOrderRespType=RESULT`), WS-API `userDataStream.subscribe.signature` (HMAC OK) for fills; no listenKey.
3. Convert/Treasurer + MCP + Agentic wallet + x402 = mainnet-only feature flags; demo mode must stub them.
4. Prefer HMAC keys for demo (guaranteed), Ed25519 optional for Spot testnet WS-API `session.logon`.
5. SDK: `@binance/spot` + `@binance/derivatives-trading-usds-futures` for cold-path REST convenience; raw fetch/WebSocket in Bun for the hot path.