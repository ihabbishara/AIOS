// test/google-auth.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleAccounts, type TokensFile } from "../src/senses/google/auth.js";

function tokensFile(dir: string, content: unknown): string {
  const p = join(dir, "google-tokens.json");
  writeFileSync(p, JSON.stringify(content));
  return p;
}

const VALID: TokensFile = {
  clientId: "id", clientSecret: "secret",
  accounts: {
    personal: { email: "p@x.com", refreshToken: "rt1" },
    work: { email: "w@y.com", refreshToken: "rt2" },
  },
};

describe("GoogleAccounts", () => {
  it("disabled when the tokens file is missing", () => {
    const ga = GoogleAccounts.load(join(mkdtempSync(join(tmpdir(), "ga-")), "nope.json"));
    expect(ga.enabled()).toBe(false);
    expect(ga.accounts()).toHaveLength(0);
    expect(ga.disabledReason()).toContain("google-tokens.json");
  });

  it("disabled when the file has no accounts", () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-"));
    const ga = GoogleAccounts.load(tokensFile(dir, { clientId: "i", clientSecret: "s", accounts: {} }));
    expect(ga.enabled()).toBe(false);
  });

  it("loads accounts and builds clients", () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-"));
    const ga = GoogleAccounts.load(tokensFile(dir, VALID));
    expect(ga.enabled()).toBe(true);
    const accounts = ga.accounts();
    expect(accounts.map((a) => a.name)).toEqual(["personal", "work"]);
    expect(accounts[0].email).toBe("p@x.com");
    expect(accounts[0].gmail).toBeTruthy();
    expect(accounts[0].calendar).toBeTruthy();
  });

  it("tracks degraded accounts", () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-"));
    const ga = GoogleAccounts.load(tokensFile(dir, VALID));
    ga.markDegraded("work", "invalid_grant");
    expect(ga.degraded()).toEqual([{ name: "work", reason: "invalid_grant" }]);
    expect(ga.isDegraded("work")).toBe(true);
    expect(ga.isDegraded("personal")).toBe(false);
    ga.clearDegraded("work");
    expect(ga.degraded()).toHaveLength(0);
  });

  it("rejects malformed json gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-"));
    const p = join(dir, "google-tokens.json");
    writeFileSync(p, "not json{");
    const ga = GoogleAccounts.load(p);
    expect(ga.enabled()).toBe(false);
    expect(ga.disabledReason()).toContain("parse");
  });
});
