import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { loadConfig } from "../../src/core/config.ts";
import { openLedger } from "../../src/core/ledger.ts";
import { Catalog } from "../../src/pay/catalog.ts";
import { LocalSigner, PaymentRejected, x402fetch } from "../../src/pay/client.ts";
import { decodeHeader, MockFacilitator, type PaymentRequired } from "../../src/pay/facilitator.ts";
import { createPayServer, type PayServer } from "../../src/pay/server.ts";
import { cleanup, tempConfigDir } from "../core/helpers.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

let configDir: string;
let srv: PayServer;
let base: string;
const ledger = openLedger(":memory:");

beforeAll(() => {
  configDir = tempConfigDir();
  const catalog = new Catalog(loadConfig(configDir).pricing);
  srv = createPayServer({
    env: { mode: "demo", x402: "mock", x402Port: 0 },
    catalog,
    facilitator: new MockFacilitator(),
    ledger,
    feeds: { liquidation: () => ({ events: [1, 2] }), basis: () => ({ basis: 0.01 }), contracts: () => ({ contracts: [] }) },
    port: 0,
  });
  base = `http://127.0.0.1:${srv.start().port}`;
});

afterAll(() => {
  srv.stop();
  ledger.close();
  cleanup(configDir);
});

describe("x402 seller", () => {
  test("catalog is free; signals challenge with 402 + PAYMENT-REQUIRED", async () => {
    const cat = await fetch(`${base}/v1/catalog`);
    expect(cat.status).toBe(200);
    const catBody = (await cat.json()) as { routes: Array<{ path: string; price_usd: number }> };
    expect(catBody.routes.find((r) => r.path === "/v1/signals/liquidation")?.price_usd).toBe(0.05);

    const res = await fetch(`${base}/v1/signals/liquidation`);
    expect(res.status).toBe(402);
    const required = decodeHeader<PaymentRequired>(res.headers.get("PAYMENT-REQUIRED") ?? "");
    expect(required.x402Version).toBe(2);
    expect(required.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "50000", maxTimeoutSeconds: 60 });
  });

  test("LocalSigner pays via x402fetch: 200 + PAYMENT-RESPONSE, ledger row direction=in and out", async () => {
    const buyer = openLedger(":memory:");
    const signer = new LocalSigner(KEY);
    const res = await x402fetch(`${base}/v1/signals/liquidation`, undefined, signer, { ledger: buyer });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [1, 2] });
    expect(res.payment).toMatchObject({ success: true, network: "eip155:84532", payer: signer.address });
    expect(res.payment?.transaction).toMatch(/^0x[0-9a-f]{64}$/);

    const rows = ledger.db.query<{ direction: string; amount: number; counterparty: string; tx: string }, []>("SELECT direction, amount, counterparty, tx FROM payments").all();
    expect(rows).toEqual([{ direction: "in", amount: 0.05, counterparty: signer.address, tx: res.payment?.transaction ?? "" }]);
    expect(buyer.dataSpendToday()).toBe(0.05);
    buyer.close();
  });

  test("buyer refuses above its cap before signing", async () => {
    const signer = new LocalSigner(KEY);
    await expect(x402fetch(`${base}/v1/signals/contracts`, undefined, signer, { accept: (_r, usd) => (usd > 0.05 ? "too expensive" : null) })).rejects.toBeInstanceOf(PaymentRejected);
  });

  test("garbage PAYMENT-SIGNATURE is re-challenged, not served", async () => {
    const res = await fetch(`${base}/v1/signals/basis`, { headers: { "PAYMENT-SIGNATURE": "bm90LWpzb24" } });
    expect(res.status).toBe(402);
    expect(decodeHeader<PaymentRequired>(res.headers.get("PAYMENT-REQUIRED") ?? "").error).toBe("malformed PAYMENT-SIGNATURE");
  });

  test("no dashboard on the pay port", async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(404);
    expect((await fetch(`${base}/`)).status).toBe(404);
  });
});
