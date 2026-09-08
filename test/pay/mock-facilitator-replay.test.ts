import { expect, test } from "bun:test";

import { LocalSigner } from "../../src/pay/client.ts";
import { assetInfo, decodeHeader, MockFacilitator, type PaymentPayload, type PaymentRequirements } from "../../src/pay/facilitator.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const usdc = assetInfo("eip155:84532", "USDC");
const REQS: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  asset: usdc.address,
  payTo: "0x000000000000000000000000000000000000dEaD",
  amount: "50000",
  maxTimeoutSeconds: 60,
  extra: { name: usdc.name, version: usdc.version },
};

test("same nonce twice: second verify is invalid", async () => {
  const fac = new MockFacilitator();
  const payload = decodeHeader<PaymentPayload>(await new LocalSigner(KEY).sign(REQS));
  const first = await fac.verify(payload, REQS);
  expect(first).toEqual({ isValid: true, payer: new LocalSigner(KEY).address });
  const second = await fac.verify(payload, REQS);
  expect(second).toEqual({ isValid: false, invalidReason: "nonce already used" });
  const settled = await fac.settle(payload, REQS);
  expect(settled.success).toBe(true);
  expect(settled.transaction).toMatch(/^0x[0-9a-f]{64}$/);
});

test("tampered authorization, wrong payee and short amount are rejected", async () => {
  const fac = new MockFacilitator();
  const signer = new LocalSigner(KEY);
  const payload = decodeHeader<PaymentPayload>(await signer.sign(REQS));
  const auth = payload.payload.authorization as Record<string, string>;
  const tampered: PaymentPayload = { ...payload, payload: { ...payload.payload, authorization: { ...auth, value: "60000" } } };
  expect((await fac.verify(tampered, REQS)).invalidReason).toBe("invalid signature");
  expect((await fac.verify(payload, { ...REQS, payTo: signer.address })).invalidReason).toBe("payTo mismatch");
  expect((await fac.verify(payload, { ...REQS, amount: "60000" })).invalidReason).toBe("insufficient amount");
  // Untouched by the rejections above: the genuine payload still verifies once.
  expect((await fac.verify(payload, REQS)).isValid).toBe(true);
});

test("concurrent settles of one nonce yield exactly one success", async () => {
  const fac = new MockFacilitator();
  const payload = decodeHeader<PaymentPayload>(await new LocalSigner(KEY).sign(REQS));
  const results = await Promise.all([fac.settle(payload, REQS), fac.settle(payload, REQS), fac.settle(payload, REQS)]);
  expect(results.filter((r) => r.success)).toHaveLength(1);
});

test("expired authorization is rejected", async () => {
  const past = () => Date.parse("2020-01-01T00:00:00Z");
  const payload = decodeHeader<PaymentPayload>(await new LocalSigner(KEY, past).sign(REQS));
  expect((await new MockFacilitator().verify(payload, REQS)).invalidReason).toBe("expired");
});
