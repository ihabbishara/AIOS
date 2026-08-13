// test/onboarding-artifacts.test.ts — what the first job left in the vault.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vaultSnapshot, newFiles } from "../src/onboarding/artifacts.js";

function vault(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  for (const f of files) {
    const full = join(root, f);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "x");
  }
  return root;
}

describe("first-job artifacts", () => {
  it("reports files the job wrote and ignores what the heartbeat owns", () => {
    // The wiki maintainer and the brief anchors both wrote during the real run this comes from.
    // Attributing their output to the user's job would be a confident lie on the one screen that
    // is meant to tell them what their org just made.
    const before = vaultSnapshot(vault(["index.md", "log.md"]));
    const after = vaultSnapshot(vault([
      "index.md", "log.md",
      "research/basel-iv-europe-august-2026.md",
      "briefs/2026-08-12-morning.md",
      "wiki/concepts/Basel IV.md",
      "daily/2026-08-12.md",
      "CLAUDE.md",
    ]));
    expect(newFiles(before, after)).toEqual(["research/basel-iv-europe-august-2026.md"]);
  });

  it("is empty when the job wrote nothing, and survives a missing vault", () => {
    const root = vault(["knowledge/a.md"]);
    expect(newFiles(vaultSnapshot(root), vaultSnapshot(root))).toEqual([]);
    expect(vaultSnapshot(join(root, "nope")).size).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("sorts, so the screen does not reshuffle between polls", () => {
    const before = vaultSnapshot(vault([]));
    const after = vaultSnapshot(vault(["notes/z.md", "knowledge/a.md", "research/m.md"]));
    expect(newFiles(before, after)).toEqual(["knowledge/a.md", "notes/z.md", "research/m.md"]);
  });
});
