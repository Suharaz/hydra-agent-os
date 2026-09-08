#!/usr/bin/env bun
// scripts/apikey-check.ts — CLI wrapper for the live API-key permission check.
// Loads env, builds SpotRest from urlMatrix, calls checkApiKeyPermissions, prints results.
// Exit 0 if no problems; exit 1 if any problem found.
// Note: scripts/ is outside tsconfig include; bun-types globals (process, console) are available at runtime.

import { loadEnv } from "../src/core/env.ts";
import { SpotRest } from "../src/venues/binance/rest-spot.ts";
import { urlMatrix } from "../src/venues/binance/urls.ts";
import { checkApiKeyPermissions } from "../src/venues/binance/apikey-check.ts";

const env = loadEnv({ source: Bun.env });

if (env.keys.spot === null) {
  console.error("apikey-check: no spot API key configured (BINANCE_SPOT_API_KEY/SECRET absent)");
  process.exit(1);
}

const spotKey = env.keys.spot;
const urls = urlMatrix(env);
const spotRest = new SpotRest({
  baseUrl: urls.spotRest,
  key: spotKey.key,
  secret: spotKey.secret,
});

console.log("Checking API key permissions via /sapi/v1/account/apiRestrictions ...");
const result = await checkApiKeyPermissions(spotRest);

for (const w of result.warnings) console.warn(`WARN  ${w}`);
for (const p of result.problems) console.error(`FAIL  ${p}`);

if (result.problems.length > 0) {
  console.error(`\napikey-check: ${result.problems.length} problem(s) — fix before running live`);
  process.exit(1);
}

console.log("OK    API key permissions are acceptable for live trading");
if (result.warnings.length > 0) {
  console.log(`      ${result.warnings.length} warning(s) above — address before production`);
}
