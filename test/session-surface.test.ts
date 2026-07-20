// test/session-surface.test.ts
import { describe, it, expect } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Store } from "../src/store/db.js";
import { surfaceHash, resumeFor } from "../src/agents/resumable.js";

const opts = (o: Partial<Options>): Options => o as Options;

describe("surfaceHash", () => {
  it("is stable and order-insensitive", () => {
    const a = surfaceHash(opts({ allowedTools: ["B", "A"], mcpServers: { m1: {} as never, m2: {} as never }, permissionMode: "dontAsk" }));
    const b = surfaceHash(opts({ allowedTools: ["A", "B"], mcpServers: { m2: {} as never, m1: {} as never }, permissionMode: "dontAsk" }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes on tool add, server add, and mode change", () => {
    const base = opts({ allowedTools: ["A"], mcpServers: { m1: {} as never }, permissionMode: "dontAsk" });
    const h = surfaceHash(base);
    expect(surfaceHash(opts({ ...base, allowedTools: ["A", "B"] }))).not.toBe(h);
    expect(surfaceHash(opts({ ...base, mcpServers: { m1: {} as never, m2: {} as never } }))).not.toBe(h);
    expect(surfaceHash(opts({ ...base, permissionMode: "default" }))).not.toBe(h);
  });

  it("ignores systemPrompt and model", () => {
    const base = opts({ allowedTools: ["A"], permissionMode: "dontAsk" });
    const h = surfaceHash(base);
    expect(surfaceHash(opts({ ...base, systemPrompt: "different", model: "other" }))).toBe(h);
  });

  it("personaSurface changes the hash; omitting it matches today's callers", () => {
    const base = opts({ allowedTools: ["A"], permissionMode: "dontAsk" });
    const h = surfaceHash(base);
    expect(surfaceHash(base, "persona v1")).not.toBe(h);
    expect(surfaceHash(base, "persona v1")).toBe(surfaceHash(base, "persona v1")); // stable
    expect(surfaceHash(base, "persona v2")).not.toBe(surfaceHash(base, "persona v1")); // edit invalidates
  });

  it("skills change the hash, order-insensitively", () => {
    const base = opts({ allowedTools: ["A"], permissionMode: "dontAsk" });
    const h = surfaceHash(opts({ ...base, skills: ["s1", "s2"] }), "p");
    expect(surfaceHash(opts({ ...base, skills: ["s2", "s1"] }), "p")).toBe(h);
    expect(surfaceHash(opts({ ...base, skills: ["s1"] }), "p")).not.toBe(h);
  });
});

describe("resumeFor", () => {
  const key = "direct-session:test:web:ui";

  it("no hash param → stored id returned (legacy behavior)", () => {
    const store = new Store(":memory:");
    store.kvSet(key, "sess-1");
    expect(resumeFor(store, key, undefined)).toBe("sess-1");
  });

  it("hash param + no stored hash → undefined (fail-closed fresh)", () => {
    const store = new Store(":memory:");
    store.kvSet(key, "sess-1");
    expect(resumeFor(store, key, "abc")).toBeUndefined();
  });

  it("hash param matches stored hash → stored id returned", () => {
    const store = new Store(":memory:");
    store.kvSet(key, "sess-1");
    store.kvSet(`surface:${key}`, "abc");
    expect(resumeFor(store, key, "abc")).toBe("sess-1");
  });

  it("hash param differs from stored hash → undefined", () => {
    const store = new Store(":memory:");
    store.kvSet(key, "sess-1");
    store.kvSet(`surface:${key}`, "abc");
    expect(resumeFor(store, key, "def")).toBeUndefined();
  });

  it("no stored session id → undefined regardless of hash", () => {
    const store = new Store(":memory:");
    expect(resumeFor(store, key, "abc")).toBeUndefined();
    expect(resumeFor(store, key, undefined)).toBeUndefined();
  });
});
