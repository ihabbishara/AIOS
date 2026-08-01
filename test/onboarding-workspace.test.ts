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

  // The separator clause alone catches "../etc", so these separator-free forms are what prove
  // the guard is an allowlist. "." is the dangerous one: join(vault, ".") is the vault root.
  it("rejects separator-free subdirs that are not a plain folder name", () => {
    for (const subdir of [".", " . ", "..", " .. ", "~", ".hidden", "-flag", "a\0b"]) {
      expect(resolveWorkspace({ mode: "custom", path: "/data/vault", subdir }, HOME))
        .toStrictEqual({ ok: false, error: "subdir must be a single folder name" });
    }
  });

  it("keeps a caller-supplied subdir instead of always writing to AIOS", () => {
    expect(resolveWorkspace({ mode: "custom", path: "/data/vault", subdir: "Brain" }, HOME))
      .toStrictEqual({ ok: true, path: "/data/vault", subdir: "Brain" });
    expect(resolveWorkspace({ mode: "builtin", subdir: "Brain" }, HOME))
      .toStrictEqual({ ok: true, path: "/Users/tester/AIOS/workspace", subdir: "Brain" });
  });

  it("allows ordinary folder names with spaces, dots, digits and dashes", () => {
    for (const subdir of ["My Vault", "notes-2026", "v1.2", "AIOS"]) {
      expect(resolveWorkspace({ mode: "custom", path: "/data/vault", subdir }, HOME))
        .toStrictEqual({ ok: true, path: "/data/vault", subdir });
    }
  });

  it("expands a bare tilde to the home directory", () => {
    expect(resolveWorkspace({ mode: "custom", path: "~" }, HOME))
      .toStrictEqual({ ok: true, path: "/Users/tester", subdir: "AIOS" });
  });

  it("refuses ~user forms rather than inventing a path under our own home", () => {
    for (const path of ["~user/foo", "~x", "~~"]) {
      expect(resolveWorkspace({ mode: "custom", path }, HOME))
        .toStrictEqual({ ok: false, error: "only ~/ is supported — write the full path instead" });
    }
  });

  it("warns on cloud-synced paths without blocking them", () => {
    for (const p of [
      "/Users/tester/Library/Mobile Documents/com~apple~CloudDocs/Vault",
      "/Users/tester/Dropbox/Vault",
      "/Users/tester/Google Drive/Vault",
      "/Users/tester/OneDrive/Vault",
      // Since Ventura macOS mounts Drive and Box here; "GoogleDrive-" has no space, so the
      // "Google Drive" alternative alone does not see them.
      "/Users/tester/Library/CloudStorage/GoogleDrive-a@b.com/My Drive/Vault",
      "/Users/tester/Library/CloudStorage/Box-Box/Vault",
    ]) {
      const r = resolveWorkspace({ mode: "custom", path: p }, HOME);
      expect(r.ok).toBe(true);
      expect((r as { warning?: string }).warning).toMatch(/sync/i);
    }
  });

  // toStrictEqual, not toEqual: toEqual ignores undefined-valued keys, so it would pass against
  // `warning: undefined` and fail to pin the "no warning key at all" contract Task 3 reads.
  it("does not warn on an ordinary path", () => {
    const r = resolveWorkspace({ mode: "custom", path: "/Users/tester/Notes" }, HOME);
    expect(r).toStrictEqual({ ok: true, path: "/Users/tester/Notes", subdir: "AIOS" });
  });
});
