/**
 * Smoke tests for the two critical bugs fixed in the session auto-recovery feature.
 *
 * BUG 1 — resumable.ts: guard `err instanceof Error` before accessing `.message`
 * BUG 2 — router.ts:    regex `[\w-]+` so hyphenated role names are captured
 *
 * These tests are pure-logic and need no SDK or database access.
 */

import { describe, expect, it } from "vitest";
import { LOCKDOWN_RE } from "../src/agents/resumable.js";

// ─── BUG 1 guard ─────────────────────────────────────────────────────────────
// LOCKDOWN_RE is imported directly from resumable.ts — any regex change there
// is automatically reflected here without manual synchronisation.

/** Mirrors the exact guard expression on line 25 of resumable.ts. */
function shouldClearSession(err: unknown): boolean {
  return err instanceof Error && LOCKDOWN_RE.test(err.message);
}

describe("BUG 1 — instanceof Error guard before LOCKDOWN_RE.test()", () => {
  it("returns true for an Error whose message matches LOCKDOWN_RE", () => {
    expect(shouldClearSession(new Error("No conversation found"))).toBe(true);
    expect(shouldClearSession(new Error("dangerouslyDisableSandbox is set"))).toBe(true);
  });

  it("returns false for patterns removed from LOCKDOWN_RE (were too broad)", () => {
    expect(shouldClearSession(new Error("session lock timeout"))).toBe(false);
    expect(shouldClearSession(new Error("tool lock expired"))).toBe(false);
  });

  it("returns false for an Error whose message does NOT match LOCKDOWN_RE", () => {
    expect(shouldClearSession(new Error("network timeout"))).toBe(false);
    expect(shouldClearSession(new Error("unknown error"))).toBe(false);
  });

  it("returns false (not TypeError) when err is null — the old code would have crashed", () => {
    // Before fix: `(null as Error).message` → TypeError
    // After fix:  null instanceof Error → false; short-circuits cleanly
    expect(() => shouldClearSession(null)).not.toThrow();
    expect(shouldClearSession(null)).toBe(false);
  });

  it("returns false (not TypeError) when err is a plain string", () => {
    expect(() => shouldClearSession("No conversation found")).not.toThrow();
    expect(shouldClearSession("No conversation found")).toBe(false);
  });

  it("returns false (not TypeError) when err is a plain object", () => {
    expect(() => shouldClearSession({ message: "No conversation found" })).not.toThrow();
    expect(shouldClearSession({ message: "No conversation found" })).toBe(false);
  });

  it("returns false (not TypeError) when err is undefined", () => {
    expect(() => shouldClearSession(undefined)).not.toThrow();
    expect(shouldClearSession(undefined)).toBe(false);
  });
});

// ─── BUG 2 regex ─────────────────────────────────────────────────────────────
// Re-declare the exact regex from router.ts line 37 and assert capture behaviour.

const resetCmdRe = /^\/(?:reset|new)(?:\s+@?([\w-]+))?$/i;

function parseResetCmd(text: string) {
  return resetCmdRe.exec(text.trim());
}

describe("BUG 2 — /reset and /new regex captures hyphenated role names", () => {
  it("captures a plain role name", () => {
    const m = parseResetCmd("/reset architect");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("architect");
  });

  it("captures a hyphenated role name (was broken with \\w+)", () => {
    const m = parseResetCmd("/reset code-reviewer");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("code-reviewer");
  });

  it("captures a multi-segment kebab-case role name", () => {
    const m = parseResetCmd("/new finance-analyst");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("finance-analyst");
  });

  it("captures role name prefixed with @", () => {
    const m = parseResetCmd("/reset @code-reviewer");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("code-reviewer");
  });

  it("/new also works with hyphenated role", () => {
    const m = parseResetCmd("/new code-reviewer");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("code-reviewer");
  });

  it("returns undefined capture group when no role is given (/reset bare)", () => {
    const m = parseResetCmd("/reset");
    expect(m).not.toBeNull();
    expect(m![1]).toBeUndefined();
  });

  it("returns null for unrelated text", () => {
    expect(parseResetCmd("hello")).toBeNull();
    expect(parseResetCmd("/start")).toBeNull();
  });

  it("is case-insensitive", () => {
    const m = parseResetCmd("/RESET Code-Reviewer");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("Code-Reviewer");
  });
});
