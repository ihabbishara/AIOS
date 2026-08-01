// test/onboarding-workspace.test.ts — workspace path resolution (spec §2).
import { describe, it, expect } from "vitest";
import { resolveWorkspace } from "../src/onboarding/workspace.js";

const HOME = "/Users/tester";

describe("resolveWorkspace", () => {
  it("defaults builtin to ~/AIOS/workspace with subdir AIOS", () => {
    const r = resolveWorkspace({ mode: "builtin" }, HOME);
    expect(r).toEqual({ ok: true, path: "/Users/tester/AIOS/workspace", subdir: "AIOS" });
  });

  it("expands a leading tilde in a custom path", () => {
    const r = resolveWorkspace({ mode: "custom", path: "~/Vaults/Brain", subdir: "AIOS" }, HOME);
    expect(r).toMatchObject({ ok: true, path: "/Users/tester/Vaults/Brain", subdir: "AIOS" });
  });

  it("requires a path in custom mode", () => {
    expect(resolveWorkspace({ mode: "custom", subdir: "AIOS" }, HOME))
      .toEqual({ ok: false, error: "a workspace path is required" });
  });

  it("rejects a relative custom path", () => {
    expect(resolveWorkspace({ mode: "custom", path: "notes/vault" }, HOME))
      .toEqual({ ok: false, error: "workspace path must be absolute or start with ~" });
  });

  it("defaults a blank subdir to AIOS rather than writing to the vault root", () => {
    const r = resolveWorkspace({ mode: "custom", path: "/data/vault", subdir: "  " }, HOME);
    expect(r).toMatchObject({ ok: true, subdir: "AIOS" });
  });

  it("rejects a subdir that would escape the vault", () => {
    expect(resolveWorkspace({ mode: "custom", path: "/data/vault", subdir: "../etc" }, HOME))
      .toEqual({ ok: false, error: "subdir must be a single folder name" });
  });

  it("warns on cloud-synced paths without blocking them", () => {
    for (const p of [
      "/Users/tester/Library/Mobile Documents/com~apple~CloudDocs/Vault",
      "/Users/tester/Dropbox/Vault",
      "/Users/tester/Google Drive/Vault",
      "/Users/tester/OneDrive/Vault",
    ]) {
      const r = resolveWorkspace({ mode: "custom", path: p }, HOME);
      expect(r.ok).toBe(true);
      expect((r as { warning?: string }).warning).toMatch(/sync/i);
    }
  });

  it("does not warn on an ordinary path", () => {
    const r = resolveWorkspace({ mode: "custom", path: "/Users/tester/Notes" }, HOME);
    expect(r).toEqual({ ok: true, path: "/Users/tester/Notes", subdir: "AIOS" });
  });
});
