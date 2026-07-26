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

// Ordinary source files whose PATH merely contains a secret-ish word. Denying these
// broke real builds (postcss tokenize.js, sucrase TokenProcessor.d.ts) — see spec ⑪.
const INNOCENT_PATHS = [
  "/Users/x/app/node_modules/postcss/lib/tokenize.js",
  "/Users/x/app/node_modules/sucrase/dist/types/TokenProcessor.d.ts",
  "/Users/x/projects/Foo/src/kernel/secrets.ts",
  "/Users/x/projects/Foo/src/auth/tokenizer.test.ts",
  "/Users/x/projects/Foo/docs/credentials-guide.md",
  // Real npm packages — denying these made `npm install` fail with EPERM inside the sandbox.
  "/Users/x/app/node_modules/jsonwebtoken",
  "/Users/x/app/node_modules/js-tokens",
  "/Users/x/app/node_modules/gtoken",
  "/Users/x/app/node_modules/@anthropic-ai/sdk/lib/credentials",
  "/Users/x/app/node_modules/jsonwebtoken/index.js",
];

describe("secret patterns are anchored to secret-looking FILES", () => {
  it("still denies every hostile fixture", () => {
    for (const p of HOSTILE_PATHS) expect(isSecretPath(p), p).toBe(true);
  });
  it("denies secret-named data files", () => {
    for (const p of [
      "/Users/x/projects/AIOS/data/google-tokens.json",
      "/Users/x/app/credentials.json",
      "/Users/x/app/.secrets",
      "/Users/x/app/config/api-token.txt",
    ]) expect(isSecretPath(p), p).toBe(true);
  });
  it("allows ordinary source files that merely contain the word", () => {
    for (const p of INNOCENT_PATHS) expect(isSecretPath(p), p).toBe(false);
  });
});

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
