import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { memoContext } from "../src/memory/memos.js";

function freshVault() {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const vault = new VaultWriter(root, "AIOS");
  vault.init();
  return { root, vault };
}

describe("memoContext", () => {
  it("returns '' when there are no memos or teachings", () => {
    const { root, vault } = freshVault();
    expect(memoContext(new Store(":memory:"), vault)).toBe("");
    rmSync(root, { recursive: true, force: true });
  });
  it("includes profile + general/inbox memos and unconsolidated teachings", () => {
    const { root, vault } = freshVault();
    const s = new Store(":memory:");
    vault.writeNote("memos/profile.md", "# Profile\nSara is my partner");
    vault.writeNote("memos/money.md", "# Money\napprove under fifty"); // money NOT injected by default
    vault.writeNote("memos/inbox.md", "# Inbox\narchive newsletters");
    s.addTeaching({ text: "always CC Sara", domain: "money", kind: "preference" });
    const block = memoContext(s, vault);
    expect(block).toContain("Learned preferences & profile");
    expect(block).toContain("Sara is my partner");
    expect(block).toContain("archive newsletters");
    expect(block).toContain("always CC Sara"); // pending teaching
    expect(block).not.toContain("approve under fifty"); // money memo not in the default set
    rmSync(root, { recursive: true, force: true });
  });
  it("returns a block when only pending teachings exist (no memo files)", () => {
    const { root, vault } = freshVault();
    const s = new Store(":memory:");
    s.addTeaching({ text: "prefer morning meetings", domain: "general", kind: "preference" });
    const block = memoContext(s, vault);
    expect(block).toContain("Learned preferences & profile");
    expect(block).toContain("prefer morning meetings");
    rmSync(root, { recursive: true, force: true });
  });
  it("truncates past the cap", () => {
    const { root, vault } = freshVault();
    vault.writeNote("memos/profile.md", "x".repeat(5000));
    const block = memoContext(new Store(":memory:"), vault);
    expect(block.length).toBeLessThan(3200);
    expect(block).toContain("(more in memos/)");
    rmSync(root, { recursive: true, force: true });
  });
});

// buildCuratePrompt died with the prose-merge distiller (memory-v2 §4) — the fact-diff
// prompts are pinned via test/distiller.test.ts behavior instead.
