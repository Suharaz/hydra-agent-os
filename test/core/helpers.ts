import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO_CONFIG = resolve(import.meta.dir, "../../config");

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hydra-"));
}

/** Fresh temp dir seeded with a copy of the repo's config/*.yaml. */
export function tempConfigDir(): string {
  const dir = tempDir();
  cpSync(REPO_CONFIG, dir, { recursive: true });
  return dir;
}

export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold a handle briefly after a watcher/db close; temp dir leak is harmless.
  }
}

/** Resolves when `fn` first returns true, polling every 20 ms; rejects after `timeoutMs`. */
export function until(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const { promise, resolve: done, reject } = Promise.withResolvers<void>();
  const start = Date.now();
  const tick = () => {
    if (fn()) done();
    else if (Date.now() - start > timeoutMs) reject(new Error(`condition not met within ${timeoutMs} ms`));
    else setTimeout(tick, 20);
  };
  tick();
  return promise;
}
