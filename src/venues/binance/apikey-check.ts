// Live API-key permission check: refuses over-privileged keys, warns on missing IP whitelist.
// /sapi has no testnet equivalent; called for every key attached to an actual live CEX venue.

import { z } from "zod";
import type { SpotRest } from "./rest-spot.ts";

const PermissionSchema = z.object({
  enableWithdrawals: z.boolean(),
  permitsUniversalTransfer: z.boolean(),
  enableInternalTransfer: z.boolean(),
  ipRestrict: z.boolean(),
});

export interface ApiKeyCheckResult {
  ok: boolean;
  problems: string[];
  warnings: string[];
  raw: unknown;
}

/**
 * Calls `GET /sapi/v1/account/apiRestrictions` via the provided REST client and evaluates:
 *   - PROBLEM  if `enableWithdrawals` is true
 *   - PROBLEM  if `permitsUniversalTransfer` is true
 *   - WARNING  if `ipRestrict` is false (key has no IP whitelist)
 */
export async function checkApiKeyPermissions(
  rest: Pick<SpotRest, "apiRestrictions">,
): Promise<ApiKeyCheckResult> {
  let raw: unknown;
  let restrictions: z.infer<typeof PermissionSchema>;

  try {
    raw = await rest.apiRestrictions();
    const parsed = PermissionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, problems: ["API permission response is incomplete or malformed; refusing live boot"], warnings: [], raw };
    restrictions = parsed.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      problems: [`apikey-check: cannot reach /sapi/v1/account/apiRestrictions: ${msg}`],
      warnings: [],
      raw: null,
    };
  }

  const problems: string[] = [];
  const warnings: string[] = [];

  if (restrictions.enableWithdrawals) {
    problems.push("API key has withdrawal permission enabled — revoke before going live");
  }
  if (restrictions.permitsUniversalTransfer) {
    problems.push("API key permits universal transfer — revoke before going live");
  }
  if (restrictions.enableInternalTransfer) {
    problems.push("API key has internal transfer permission enabled — revoke before going live");
  }
  if (!restrictions.ipRestrict) {
    warnings.push("API key has no IP whitelist (ipRestrict=false) — restrict to your server IP");
  }

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    raw,
  };
}
