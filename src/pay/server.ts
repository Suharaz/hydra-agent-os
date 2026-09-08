// Public x402 seller on its own port: `/v1/catalog` free, `/v1/signals/*` behind 402. Nothing
// else is mounted here — no dashboard, no `/api/*`. Verify -> handler -> settle; a settled
// payment lands in `payments(direction='in')` and the tx rides back in PAYMENT-RESPONSE.

import type { Server } from "bun";
import { Hono } from "hono";
import type { Env } from "../core/env.ts";
import type { Ledger } from "../core/ledger.ts";
import { logger } from "../core/log.ts";
import type { Module } from "../main.ts";
import type { Catalog } from "./catalog.ts";
import { assetInfo, decodeHeader, encodeHeader, type Facilitator, Eip3009AuthorizationSchema } from "./facilitator.ts";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, Network } from "@x402/core/types";

const log = logger("pay.server");

export const RATE_LIMIT_PER_SEC = 10;
export const PAYMENT_TIMEOUT_SEC = 60;
/** Demo payee; live modes must pass `payTo` (X402_PAY_TO). */
export const DEMO_PAY_TO = "0x000000000000000000000000000000000000dEaD";

export interface PayFeeds {
  liquidation(): unknown;
  basis(): unknown;
  contracts(): unknown;
}

export interface PayServerDeps {
  env: Pick<Env, "mode" | "x402" | "x402Port">;
  catalog: Catalog;
  facilitator: Facilitator;
  ledger: Pick<Ledger, "insertPayment">;
  feeds: PayFeeds;
  port?: number;
  hostname?: string;
  payTo?: string;
  now?: () => number;
}

export interface PayServer {
  app: Hono<{ Bindings: { ip: string } }>;
  start(): { port: number };
  stop(): void;
  module: Module;
}

export function createPayServer(deps: PayServerDeps): PayServer {
  const now = deps.now ?? Date.now;
  const payTo = deps.payTo ?? (deps.env.x402 === "mock" ? DEMO_PAY_TO : null);
  if (payTo === null) throw new Error(`X402=${deps.env.x402} requires X402_PAY_TO`);
  const asset = assetInfo(deps.catalog.network, deps.catalog.asset);
  const app = new Hono<{ Bindings: { ip: string } }>();
  let server: Server<unknown> | null = null;
  let origin = "";

  const buckets = new Map<string, { sec: number; n: number }>();
  app.use("*", async (c, next) => {
    const ip = c.env?.ip ?? "local";
    const sec = Math.floor(now() / 1000);
    const b = buckets.get(ip);
    if (b === undefined || b.sec !== sec) buckets.set(ip, { sec, n: 1 });
    else if (++b.n > RATE_LIMIT_PER_SEC) return c.json({ error: "rate limited" }, 429);
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.sec !== sec) buckets.delete(k);
    await next();
  });

  app.get("/v1/catalog", (c) => c.json({ ...deps.catalog.toJSON(), payTo, scheme: "exact" }));

  const requirementsFor = (priceUsd: number): PaymentRequirements => ({
    scheme: "exact",
    network: deps.catalog.network as Network,
    asset: asset.address,
    payTo,
    amount: BigInt(Math.round(priceUsd * 10 ** asset.decimals)).toString(),
    maxTimeoutSeconds: PAYMENT_TIMEOUT_SEC,
    extra: { name: asset.name, version: asset.version },
  });

  const paid = (path: string, body: () => unknown) => {
    app.get(path, async (c) => {
      const priceUsd = deps.catalog.price(path);
      if (priceUsd === null) return c.json({ error: "not for sale" }, 404);
      const reqs = requirementsFor(priceUsd);
      const challenge = (error?: string) => {
        const required: PaymentRequired = {
          x402Version: 2,
          resource: {
            url: `${origin}${path}`,
            description: `HYDRA signal ${path}`,
            mimeType: "application/json"
          },
          accepts: [reqs],
          ...(error !== undefined ? { error } : {})
        };
        c.header("PAYMENT-REQUIRED", encodeHeader(required));
        return c.json(required, 402);
      };
      const sig = c.req.header("PAYMENT-SIGNATURE");
      if (sig === undefined) return challenge();
      let payload: PaymentPayload;
      try {
        payload = decodeHeader<PaymentPayload>(sig);
      } catch {
        return challenge("malformed PAYMENT-SIGNATURE");
      }
      const v = await deps.facilitator.verify(payload, reqs);
      if (!v.isValid) return challenge(v.invalidReason ?? "invalid payment");
      const data = body();
      const s = await deps.facilitator.settle(payload, reqs);
      if (!s.success) {
        log.warn("settle failed", { path, payer: v.payer, pending: s.pending === true });
        return challenge(s.pending === true ? "settlement pending" : "settlement failed");
      }
      const authParsed = Eip3009AuthorizationSchema.safeParse(payload.payload.authorization);
      const authFrom = authParsed.success ? authParsed.data.from : "";
      const payer = s.payer ?? v.payer ?? authFrom;
      deps.ledger.insertPayment({ direction: "in", counterparty: payer, amount: priceUsd, asset: asset.address, network: s.network, tx: s.transaction, meta: { resource: path, facilitator: deps.facilitator.kind } });
      c.header("PAYMENT-RESPONSE", encodeHeader({ success: true, transaction: s.transaction, network: s.network, payer }));
      return c.json(data);
    });
  };
  paid("/v1/signals/liquidation", deps.feeds.liquidation);
  paid("/v1/signals/basis", deps.feeds.basis);
  paid("/v1/signals/contracts", deps.feeds.contracts);

  const start = (): { port: number } => {
    if (server !== null) return { port: server.port ?? 0 };
    const hostname = deps.hostname ?? (deps.env.mode === "live" ? "0.0.0.0" : "127.0.0.1");
    server = Bun.serve({
      hostname,
      port: deps.port ?? deps.env.x402Port,
      fetch: (req, srv) => app.fetch(req, { ip: srv.requestIP(req)?.address ?? "unknown" }),
    });
    const port = server.port ?? 0;
    origin = `http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${port}`;
    log.info("x402 seller listening", { hostname, port, facilitator: deps.facilitator.kind, network: deps.catalog.network });
    return { port };
  };
  const stop = (): void => {
    server?.stop(true);
    server = null;
  };

  return {
    app,
    start,
    stop,
    module: {
      name: "x402",
      order: "agents",
      start: () => {
        start();
      },
      stop,
    },
  };
}
