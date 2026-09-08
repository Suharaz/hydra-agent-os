// On-chain token audit results (Skills Hub `audit`), keyed by token. Fed by SkillsHttp (Phase 2);
// read by kernel rule 9. `fresh()` is the only hot-path call: one Map lookup, no allocation.

export interface AuditEntry {
  pass: boolean;
  risk: string;
  /** Wall ms at which the audit was fetched. */
  tsMs: number;
}

export class AuditCache {
  private readonly entries = new Map<string, AuditEntry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  set(token: string, entry: AuditEntry): void {
    this.entries.set(token, entry);
  }

  get(token: string): AuditEntry | null {
    return this.entries.get(token) ?? null;
  }

  /** True when an audit exists, passed, and is younger than `ttlSec`. */
  fresh(token: string, ttlSec: number): boolean {
    const e = this.entries.get(token);
    return e !== undefined && e.pass && this.now() - e.tsMs < ttlSec * 1000;
  }

  get size(): number {
    return this.entries.size;
  }
}
