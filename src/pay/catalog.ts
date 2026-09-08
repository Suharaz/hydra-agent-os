// Route price list from pricing.yaml. Sales moves a price inside its [min, max] band; the band
// itself is operator-only. `writePricing` persists a patch atomically (parse -> merge -> validate
// -> temp file -> rename), preserving comments.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { CONFIG_FILES, ConfigError, type PricingConfig, PricingSchema } from "../core/config.ts";

export interface CatalogRoute {
  path: string;
  priceUsd: number;
  min: number;
  max: number;
}

export class Catalog {
  readonly network: string;
  readonly asset: string;
  private readonly map = new Map<string, CatalogRoute>();

  constructor(pricing: PricingConfig) {
    this.network = pricing.network;
    this.asset = pricing.asset;
    for (const [path, r] of Object.entries(pricing.routes)) this.map.set(path, { path, priceUsd: r.price_usd, min: r.min, max: r.max });
  }

  routes(): CatalogRoute[] {
    return [...this.map.values()];
  }

  price(path: string): number | null {
    return this.map.get(path)?.priceUsd ?? null;
  }

  /** Reason `path` cannot be priced at `priceUsd`, or null when it can. */
  check(path: string, priceUsd: number): string | null {
    const r = this.map.get(path);
    if (r === undefined) return `unknown route ${path}`;
    if (!Number.isFinite(priceUsd) || priceUsd < r.min || priceUsd > r.max) return `${path}: ${priceUsd} outside [${r.min}, ${r.max}]`;
    return null;
  }

  set(path: string, priceUsd: number): void {
    const problem = this.check(path, priceUsd);
    if (problem !== null) throw new RangeError(problem);
    const r = this.map.get(path);
    if (r !== undefined) r.priceUsd = priceUsd;
  }

  toJSON(): { network: string; asset: string; routes: Array<{ path: string; price_usd: number; min: number; max: number }> } {
    return { network: this.network, asset: this.asset, routes: this.routes().map((r) => ({ path: r.path, price_usd: r.priceUsd, min: r.min, max: r.max })) };
  }
}

export type PricingPatch = { routes: Record<string, { price_usd?: number; min?: number; max?: number }>; network?: string; asset?: string };

/** Sales may only move `price_usd`; band and network/asset edits are the operator's. */
export function writePricing(configDir: string, patch: PricingPatch, actor: "sales" | "operator"): { changed: boolean } {
  const path = join(configDir, CONFIG_FILES.pricing);
  if (actor === "sales") {
    if (patch.network !== undefined || patch.asset !== undefined) throw new ConfigError(CONFIG_FILES.pricing, ["sales may only change price_usd"]);
    for (const [route, r] of Object.entries(patch.routes)) if (r.min !== undefined || r.max !== undefined) throw new ConfigError(CONFIG_FILES.pricing, [`${route}: sales may only change price_usd`]);
  }
  const doc = parseDocument(readFileSync(path, "utf8"));
  const before = JSON.stringify(doc.toJS());
  if (patch.network !== undefined) doc.setIn(["network"], patch.network);
  if (patch.asset !== undefined) doc.setIn(["asset"], patch.asset);
  for (const [route, r] of Object.entries(patch.routes)) {
    if (!doc.hasIn(["routes", route])) throw new ConfigError(CONFIG_FILES.pricing, [`${route}: unknown route`]);
    for (const k of ["price_usd", "min", "max"] as const) if (r[k] !== undefined) doc.setIn(["routes", route, k], r[k]);
  }
  const next = doc.toJS() as unknown;
  const parsed = PricingSchema.safeParse(next);
  if (!parsed.success) throw new ConfigError(CONFIG_FILES.pricing, parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`));
  if (JSON.stringify(next) === before) return { changed: false };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, doc.toString(), "utf8");
  renameSync(tmp, path);
  return { changed: true };
}
