import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { memoContextForDomain } from "../src/memory/memos.js";

function freshVault() {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const vault = new VaultWriter(root, "AIOS");
  vault.init();
  return { root, vault };
}

describe("memoContextForDomain", () => {
  it("loads profile + the given domain's memo + that domain's pending teachings only", () => {
    const { root, vault } = freshVault();
    const s = new Store(":memory:");
    vault.writeNote("memos/profile.md", "# Profile\nSara is my partner");
    vault.writeNote("memos/money.md", "# Money\napprove invoices under fifty");
    vault.writeNote("memos/inbox.md", "# Inbox\narchive newsletters");
    s.addTeaching({ text: "always CC Sara", domain: "money", kind: "preference" });
    s.addTeaching({ text: "ignore promos", domain: "inbox", kind: "preference" });
    const block = memoContextForDomain(s, vault, "money");
    expect(block).toContain("Sara is my partner");
    expect(block).toContain("approve invoices under fifty");
    expect(block).toContain("always CC Sara");
    expect(block).not.toContain("archive newsletters");
    expect(block).not.toContain("ignore promos");
    rmSync(root, { recursive: true, force: true });
  });
  it("returns '' when nothing relevant exists", () => {
    const { root, vault } = freshVault();
    expect(memoContextForDomain(new Store(":memory:"), vault, "code")).toBe("");
    rmSync(root, { recursive: true, force: true });
  });
});
