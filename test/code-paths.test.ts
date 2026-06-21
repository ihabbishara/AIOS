// test/code-paths.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isUnder, isSecretPath, resolveReal } from "../src/code/paths.js";

describe("code path safety", () => {
  const root = mkdtempSync(join(tmpdir(), "paths-"));
  const jail = join(root, "jail");
  mkdirSync(jail, { recursive: true });

  it("isUnder true for a child (existing and not-yet-existing)", () => {
    expect(isUnder(join(jail, "a/b.txt"), jail)).toBe(true);
    writeFileSync(join(jail, "real.txt"), "x");
    expect(isUnder(join(jail, "real.txt"), jail)).toBe(true);
  });

  it("isUnder false for an escape via ..", () => {
    expect(isUnder(join(jail, "../outside.txt"), jail)).toBe(false);
  });

  it("isUnder false for a symlink that escapes the jail", () => {
    const link = join(jail, "escape");
    symlinkSync(root, link); // jail/escape -> root (parent)
    expect(isUnder(join(link, "x.txt"), jail)).toBe(false);
  });

  it("isSecretPath flags AIOS, ssh, env, tokens", () => {
    expect(isSecretPath("/Users/me/projects/AIOS/.env")).toBe(true);
    expect(isSecretPath("/Users/me/.ssh/id_rsa")).toBe(true);
    expect(isSecretPath("/Users/me/app/google-tokens.json")).toBe(true);
    expect(isSecretPath("/Users/me/app/src/main.ts")).toBe(false);
  });

  it("resolveReal collapses .. against an existing ancestor", () => {
    expect(resolveReal(join(jail, "..", "jail", "z"))).toBe(join(resolveReal(jail), "z"));
  });
});
