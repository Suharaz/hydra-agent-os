import { expect, test } from "bun:test";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { createPayServer } from "../../src/pay/server.ts";
import { MockFacilitator } from "../../src/pay/facilitator.ts";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

test("official @x402 client interop", async () => {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  
  const clientSigner = {
    address: account.address,
    signTypedData: async (data: any) => account.signTypedData(data),
  };

  const scheme = new ExactEvmScheme(clientSigner);
  const client = new x402Client().register("eip155:84532", scheme);
  
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  const server = createPayServer({
    env: { mode: "demo", x402: "mock", x402Port: 0 },
    catalog: {
      network: "eip155:84532",
      asset: "USDC",
      price: () => 1,
      toJSON: () => ({}),
    } as any,
    facilitator: new MockFacilitator(),
    ledger: { insertPayment: () => 1 },
    feeds: { liquidation: () => ({ ok: true }), basis: () => ({}), contracts: () => ({}) },
    hostname: "127.0.0.1",
  });
  
  const { port } = server.start();
  try {
    const res = await fetchWithPay(`http://127.0.0.1:${port}/v1/signals/liquidation`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true });
  } finally {
    server.stop();
  }
});
