import { expect, test } from "bun:test";
import { encodeQuery, signWsApiParams, signedQuery } from "../../src/venues/binance/sign.ts";

const SECRET = "hydra-test-secret";

test("signedQuery: insertion order, recvWindow, offset-adjusted timestamp, fixed HMAC vector", () => {
  const q = signedQuery({ symbol: "BTCUSDT", side: "BUY", price: undefined }, SECRET, 1500, 1_700_000_000_000);
  expect(q).toBe(
    "symbol=BTCUSDT&side=BUY&recvWindow=5000&timestamp=1700000001500&signature=7151fc40965cacbfd828c1c1f8b8ef99bfd40289f7f9b93b479f989ce20b70fe",
  );
});

test("signedQuery: negative offset and empty params", () => {
  const q = signedQuery({}, SECRET, -250, 1_700_000_000_000);
  expect(q.startsWith("recvWindow=5000&timestamp=1699999999750&signature=")).toBe(true);
  expect(q.length).toBe("recvWindow=5000&timestamp=1699999999750&signature=".length + 64);
});

test("encodeQuery URL-encodes and skips null/undefined", () => {
  expect(encodeQuery({ a: "x y", b: null, c: undefined, d: 1, e: true })).toBe("a=x%20y&d=1&e=true");
});

test("signWsApiParams sorts keys and omits recvWindow", () => {
  expect(signWsApiParams({ timestamp: 1_700_000_000_000, apiKey: "k1" }, SECRET)).toBe("3141ba3dab46fe66d3d715485fa31ca69bee045690d6025b5396e3da0901b2f7");
});
