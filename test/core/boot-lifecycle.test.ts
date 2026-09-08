import { describe, expect, test } from "bun:test";
import { boot, type Module } from "../../src/main.ts";
import { cleanup, tempConfigDir, tempDir } from "./helpers.ts";

describe("runtime module ownership", () => {
  test("successive boots do not restart a previous runtime's modules", async () => {
    const configDir = tempConfigDir();
    const stateDir = tempDir();
    const actions: string[] = [];
    const module = (name: string): Module => ({ name, order: "feed", start() { actions.push(`start:${name}`); }, stop() { actions.push(`stop:${name}`); } });
    const opts = { configDir, stateDir, ledgerPath: ":memory:", env: { HYDRA_MODE: "demo", DASHBOARD_TOKEN: "test" }, out: () => {} };
    try {
      const first = await boot({ ...opts, modules: () => [module("first")] });
      await first.shutdown();
      const second = await boot({ ...opts, modules: () => [module("second")] });
      await second.shutdown();
      await second.shutdown();
      expect(actions).toEqual(["start:first", "stop:first", "start:second", "stop:second"]);
    } finally { cleanup(configDir); cleanup(stateDir); }
  });

  test("failed startup releases the failing module before earlier modules", async () => {
    const configDir = tempConfigDir();
    const stateDir = tempDir();
    const released: string[] = [];
    try {
      await expect(boot({ configDir, stateDir, ledgerPath: ":memory:", env: { DASHBOARD_TOKEN: "test" }, out: () => {}, modules: () => [
        { name: "feed", order: "feed", start() {}, stop() { released.push("feed"); } },
        { name: "executor", order: "executor", start() { throw new Error("startup rejected"); }, stop() { released.push("executor"); } },
      ] })).rejects.toThrow("startup rejected");
      expect(released).toEqual(["executor", "feed"]);
    } finally { cleanup(configDir); cleanup(stateDir); }
  });
});
