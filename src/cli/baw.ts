// cli baw pair — runs the agentic wallet's QR pairing in the foreground: `auth signin` prints the
// web URL and pairing code, `auth verify` blocks (<= 5 min) with inherited stdio until the user
// confirms in the Binance Wallet app, then `wallet status` is echoed as the truth.

import { loadEnv } from "../core/env.ts";
import { checkBawBin } from "../venues/onchain/baw-adapter.ts";

export const description = "Pair the agentic wallet binary (QR flow, foreground): baw pair";
export const subverbs = ["pair"] as const;

export default async function baw(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === undefined || !(subverbs as readonly string[]).includes(sub)) {
    console.error(`usage: hydra baw <${subverbs.join("|")}>`);
    return 2;
  }
  const env = loadEnv();
  if (env.bawBin === null) {
    console.error("baw pair: BAW_BIN is not set");
    return 2;
  }
  const bin = env.bawBin;
  try {
    checkBawBin(bin);
  } catch (err) {
    console.error(`baw pair: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const signin = Bun.spawnSync([bin, "auth", "signin", "--json"], { stdout: "pipe", stderr: "inherit", stdin: "ignore" });
  const out = new TextDecoder().decode(signin.stdout).trim();
  let info: Record<string, unknown>;
  try {
    const json = JSON.parse(out) as Record<string, unknown>;
    info = typeof json.data === "object" && json.data !== null ? (json.data as Record<string, unknown>) : json;
  } catch {
    console.error(`baw auth signin: unparseable output (exit ${signin.exitCode}): ${out.slice(0, 200)}`);
    return 1;
  }
  if (info.status === "ALREADY_CONNECTED") {
    console.log("baw: already connected");
  } else {
    const qr = info.qrCodeId;
    if (typeof qr !== "string") {
      console.error(`baw auth signin: no qrCodeId in ${out.slice(0, 200)}`);
      return 1;
    }
    console.log(`Open in a browser: ${String(info.urlForWeb ?? "")}`);
    console.log(`Pairing code: ${String(info.pairingCode ?? "")} (expires ${String(info.expireAt ?? "?")})`);
    console.log("Confirm in the Binance Wallet app; waiting up to 5 minutes...");
    const verify = Bun.spawnSync([bin, "auth", "verify", "--qrCodeId", qr], { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
    if (verify.exitCode !== 0) {
      console.error(`baw auth verify exited ${verify.exitCode}; restart with \`hydra baw pair\``);
      return 1;
    }
  }
  const status = Bun.spawnSync([bin, "wallet", "status", "--json"], { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  return status.exitCode === 0 ? 0 : 1;
}
