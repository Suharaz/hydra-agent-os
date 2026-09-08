import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Bus, EVENT_NAMES, type EventName } from "../../src/core/bus.ts";
import type { Veto } from "../../src/core/types.ts";

const veto = (rule: number): Veto => ({ intentId: "i", engine: "liqfade", rule, detail: "", tsNs: 0 });

describe("Bus", () => {
  test("listeners run in registration order, synchronously", () => {
    const b = new Bus();
    const order: string[] = [];
    b.on("kernel.veto", () => order.push("a"));
    b.on("kernel.veto", () => order.push("b"));
    b.on("kernel.veto", () => order.push("c"));
    b.emit("kernel.veto", veto(1));
    order.push("after");
    expect(order).toEqual(["a", "b", "c", "after"]);
  });

  test("off removes only that listener; disposer from on() works; once fires once", () => {
    const b = new Bus();
    const hits: number[] = [];
    const a = (v: Veto) => hits.push(v.rule * 10);
    const dispose = b.on("kernel.veto", a);
    b.on("kernel.veto", (v) => hits.push(v.rule));
    b.once("kernel.veto", (v) => hits.push(-v.rule));
    b.emit("kernel.veto", veto(1));
    b.off("kernel.veto", a);
    b.emit("kernel.veto", veto(2));
    dispose(); // already removed; must be a no-op
    b.emit("kernel.veto", veto(3));
    expect(hits).toEqual([10, 1, -1, 2, 3]);
    expect(b.listenerCount("kernel.veto")).toBe(1);
  });

  test("an off() inside a listener does not skip siblings; a throwing listener does not block others", () => {
    const b = new Bus();
    const hits: string[] = [];
    const first = () => {
      hits.push("first");
      b.off("kernel.veto", first);
    };
    b.on("kernel.veto", first);
    b.on("kernel.veto", () => {
      hits.push("boom");
      throw new Error("boom");
    });
    b.on("kernel.veto", () => hits.push("third"));
    expect(() => b.emit("kernel.veto", veto(1))).toThrow("boom");
    expect(hits).toEqual(["first", "boom", "third"]);
    expect(b.listenerCount("kernel.veto")).toBe(2);
  });
});

describe("registry", () => {
  test("EVENT_NAMES has no duplicates", () => {
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
  });

  test("every `.emit(\"<name>\"` in src/** is a declared event", async () => {
    const srcDir = resolve(import.meta.dir, "../../src");
    const declared: ReadonlySet<string> = new Set<string>(EVENT_NAMES);
    const re = /\.emit\(\s*(["'])([^"']+)\1/g;
    const undeclared: string[] = [];
    let seen = 0;
    for await (const rel of new Bun.Glob("**/*.ts").scan({ cwd: srcDir })) {
      const text = readFileSync(resolve(srcDir, rel), "utf8");
      for (const m of text.matchAll(re)) {
        seen++;
        const name = m[2] as EventName;
        if (!declared.has(name)) undeclared.push(`${rel}: ${name}`);
      }
    }
    expect(seen).toBeGreaterThan(0); // state.ts and config.ts emit reload events
    expect(undeclared).toEqual([]);
  });
});
