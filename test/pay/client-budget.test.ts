import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { buildTools } from "../../src/cold/tools.ts";
import { loadConfig } from "../../src/core/config.ts";
import { openLedger } from "../../src/core/ledger.ts";
import { Catalog, writePricing } from "../../src/pay/catalog.ts";
import { LocalSigner } from "../../src/pay/client.ts";
import { MockFacilitator } from "../../src/pay/facilitator.ts";
import { createPayServer, type PayServer } from "../../src/pay/server.ts";
import { type Rig, rig } from "../cold/rig.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

let r: Rig;
let srv: PayServer;
let base: string;
let sellerDir: string;
const sellerLedger = openLedger(":memory:");

beforeAll(() => {
  r = rig();
  sellerDir = r.configDir;
  const catalog = new Catalog(loadConfig(sellerDir).pricing);
  srv = createPayServer({
    env: { mode: "demo", x402: "mock", x402Port: 0 },
    catalog,
    facilitator: new MockFacilitator(),
    ledger: sellerLedger,
    feeds: { liquidation: () => ({ ok: 1 }), basis: () => ({ ok: 2 }), contracts: () => ({ ok: 3 }) },
    port: 0,
  });
  base = `http://127.0.0.1:${srv.start().port}`;
  r.toolDeps.signer = new LocalSigner(KEY);
  r.toolDeps.catalog = catalog;
});

afterAll(() => {
  srv.stop();
  sellerLedger.close();
  r.dispose();
});

describe("pay.buy budget", () => {
  test("refuses when dataSpendToday + price exceeds data_daily_budget_usd (risk.yaml: $1)", async () => {
    // Prior outbound spend of $0.97 leaves $0.03 < the $0.05 route price.
    r.toolDeps.ledger.insertPayment({ direction: "out", counterparty: "x", amount: 0.97, asset: "USDC", network: "eip155:84532", tx: "0x1" });
    const tools = buildTools(r.toolDeps, "treasurer", "apply");
    const res = await tools.call("pay.buy", { url: `${base}/v1/signals/liquidation`, max_usd: 1 });
    expect(res.ok).toBe(false);
    expect(res.rejected).toMatch(/data budget/);
    expect(r.toolDeps.ledger.dataSpendToday()).toBe(0.97);
    // Record mode applies the same gate without paying.
    const shadow = buildTools(r.toolDeps, "treasurer", "record");
    expect((await shadow.call("pay.buy", { url: `${base}/v1/signals/liquidation`, max_usd: 1 })).rejected).toMatch(/data budget/);
  });

  test("refuses above max_usd; buys within both caps and records direction=out", async () => {
    const tools = buildTools(r.toolDeps, "treasurer", "apply");
    expect((await tools.call("pay.buy", { url: `${base}/v1/signals/liquidation`, max_usd: 0.01 })).rejected).toMatch(/max_usd/);
    // Fresh ledger: nothing spent yet.
    const fresh = rig();
    fresh.toolDeps.signer = new LocalSigner(KEY);
    const ok = await buildTools(fresh.toolDeps, "treasurer", "apply").call("pay.buy", { url: `${base}/v1/signals/liquidation`, max_usd: 0.1 });
    expect(ok.ok).toBe(true);
    expect(ok.result).toMatchObject({ status: 200, body: { ok: 1 }, payment: { success: true } });
    expect(fresh.toolDeps.ledger.dataSpendToday()).toBe(0.05);
    fresh.dispose();
  });

  test("only the treasurer may buy", async () => {
    expect((await buildTools(r.toolDeps, "sales", "apply").call("pay.buy", { url: `${base}/v1/catalog`, max_usd: 1 })).rejected).toMatch(/write scope/);
  });
});

describe("pricing.set", () => {
  test("sales moves a price inside its band and pricing.yaml follows; outside the band is refused", async () => {
    const tools = buildTools(r.toolDeps, "sales", "apply");
    expect((await tools.call("pricing.set", { route: "/v1/signals/basis", price_usd: 0.9 })).rejected).toMatch(/outside/);
    expect((await tools.call("pricing.set", { route: "/v1/nope", price_usd: 0.1 })).rejected).toMatch(/unknown route/);
    const ok = await tools.call("pricing.set", { route: "/v1/signals/basis", price_usd: 0.2 });
    expect(ok.ok).toBe(true);
    expect(loadConfig(sellerDir).pricing.routes["/v1/signals/basis"]?.price_usd).toBe(0.2);
    // The live server now charges the new price.
    const res = await fetch(`${base}/v1/signals/basis`);
    expect(((await res.json()) as { accepts: Array<{ amount: string }> }).accepts[0]?.amount).toBe("200000");
    expect((await buildTools(r.toolDeps, "treasurer", "apply").call("pricing.set", { route: "/v1/signals/basis", price_usd: 0.2 })).rejected).toMatch(/write scope/);
  });

  test("writePricing refuses band edits from sales", () => {
    expect(() => writePricing(sellerDir, { routes: { "/v1/signals/basis": { max: 5 } } }, "sales")).toThrow(/only change price_usd/);
    expect(writePricing(sellerDir, { routes: { "/v1/signals/basis": { max: 5 } } }, "operator").changed).toBe(true);
  });
});
