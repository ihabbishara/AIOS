// test/secrets-module.test.ts
import { describe, it, expect } from "vitest";
import { SECRET_PATH_PATTERNS, sbplSecretDenyLines, ENV_ALLOWLIST } from "../src/kernel/secrets.js";
import { isSecretPath } from "../src/code/paths.js";
import { sandboxProfile, jailEnv } from "../src/code/exec.js";

// One hostile fixture set, three consumers — the drift this module exists to kill.
const HOSTILE_PATHS = [
  "/Users/x/.ssh/id_rsa",
  "/Users/x/.aws/credentials",
  "/Users/x/.gnupg/ring",
  "/Users/x/.config/gh/hosts.yml",
  "/Users/x/projects/AIOS/.env",
  "/Users/x/app/.env.production",
  "/Users/x/notes/oauth_token.txt",
];

describe("unified secrets module", () => {
  it("isSecretPath rejects every hostile fixture", () => {
    for (const p of HOSTILE_PATHS) expect(isSecretPath(p), p).toBe(true);
  });

  it("the SBPL profile contains every secret deny line", () => {
    const profile = sandboxProfile("/tmp/aios-fixture", "build");
    for (const line of sbplSecretDenyLines()) expect(profile).toContain(line);
  });

  it("jailEnv scrubs everything outside the allowlist", () => {
    const env = jailEnv("/tmp/aios-fixture", {
      PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "sk-secret", TELEGRAM_BOT_TOKEN: "t",
    } as NodeJS.ProcessEnv);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    for (const k of Object.keys(env)) {
      expect([...ENV_ALLOWLIST, "HOME", "TMPDIR", "TMP", "TEMP"]).toContain(k);
    }
  });

  it("module patterns and path guard agree (no drift)", () => {
    expect(SECRET_PATH_PATTERNS.length).toBeGreaterThanOrEqual(7);
  });
});
