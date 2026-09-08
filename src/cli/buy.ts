// cli buy <path> [--max-usd n] [--url base] — demo buyer against the local x402 seller. Signs with
// X402_DEMO_PRIVATE_KEY or a throwaway key generated for this run.

import { loadEnv } from "../core/env.ts";
import { LocalSigner, PaymentRejected, randomPrivateKey, x402fetch } from "../pay/client.ts";

export const description = "Buy a signal from the local x402 seller as a demo buyer: buy <path> [--max-usd n] [--url base]";

export default async function buy(args: string[]): Promise<number> {
  let path: string | null = null;
  let maxUsd = 1;
  let base: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--max-usd") maxUsd = Number(args[++i]);
    else if (a === "--url") base = args[++i] ?? null;
    else if (path === null) path = a;
    else {
      console.error(`buy: unexpected argument ${a}`);
      return 2;
    }
  }
  if (path === null || !Number.isFinite(maxUsd)) {
    console.error("usage: hydra buy <path> [--max-usd n] [--url base]");
    return 2;
  }
  const env = loadEnv();
  const url = `${base ?? `http://127.0.0.1:${env.x402Port}`}${path.startsWith("/") ? path : `/${path}`}`;
  let key = env.x402DemoPrivateKey;
  if (key === null) {
    key = randomPrivateKey();
    console.error(`buy: X402_DEMO_PRIVATE_KEY unset; using throwaway key`);
  }
  const signer = new LocalSigner(key);
  try {
    const res = await x402fetch(url, undefined, signer, { accept: (_r, usd) => (usd > maxUsd ? `price ${usd} exceeds --max-usd ${maxUsd}` : null) });
    const text = await res.text();
    console.log(`HTTP ${res.status} ${url}`);
    if (res.payment !== undefined) console.log(`PAYMENT-RESPONSE ${JSON.stringify(res.payment)}`);
    console.log(text);
    return res.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof PaymentRejected) {
      console.error(`buy: refused: ${err.message}`);
      return 3;
    }
    console.error(`buy failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
