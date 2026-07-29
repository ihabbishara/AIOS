// test/onboarding-auth.test.ts — verifyToken: env set/restore + error surfacing (spec §2).
import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { verifyToken, pingEnv, pingFailure } from "../src/onboarding/auth.js";

const ORIG = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const ORIG_KEY = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (ORIG === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIG;
  if (ORIG_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIG_KEY;
});

describe("verifyToken", () => {
  it("rejects an empty token without pinging", async () => {
    let pinged = false;
    const r = await verifyToken("  ", async () => { pinged = true; });
    expect(r).toEqual({ ok: false, error: "token required" });
    expect(pinged).toBe(false);
  });

  it("keeps the env token on success", async () => {
    const r = await verifyToken("good-tok", async () => {});
    expect(r).toEqual({ ok: true });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("good-tok");
  });

  it("surfaces the ping error and restores the previous env value", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "old-tok";
    const r = await verifyToken("bad-tok", async () => { throw new Error("401 invalid x-api-key"); });
    expect(r).toEqual({ ok: false, error: "401 invalid x-api-key" });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("old-tok");
  });

  it("removes the env var on failure when none was set before", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    await verifyToken("bad-tok", async () => { throw new Error("nope"); });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  // A line break would let a pasted token write extra lines into .env via updateEnvFile.
  it("rejects a multi-line token without pinging or touching the env", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "old-tok";
    let pinged = false;
    const r = await verifyToken("sk-tok\nANTHROPIC_API_KEY=injected", async () => { pinged = true; });
    expect(r).toEqual({ ok: false, error: "token must be a single line" });
    expect(pinged).toBe(false);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("old-tok");
  });

  // An API key in the env would authenticate the ping by itself and vouch for a garbage token.
  it("hides ANTHROPIC_API_KEY from the ping, then puts it back", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-key";
    let seen: string | undefined = "not-run";
    const r = await verifyToken("good-tok", async () => { seen = process.env.ANTHROPIC_API_KEY; });
    expect(seen).toBeUndefined();
    expect(r).toEqual({ ok: true });
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("good-tok");
  });

  it("puts ANTHROPIC_API_KEY back when the ping fails too — bootMode reads it", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-key";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "old-tok";
    const r = await verifyToken("bad-tok", async () => { throw new Error("401 invalid"); });
    expect(r).toEqual({ ok: false, error: "401 invalid" });
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("old-tok");
  });

  it("leaves ANTHROPIC_API_KEY unset when it was unset before", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await verifyToken("good-tok", async () => {});
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("hands the trimmed token to the ping", async () => {
    let got: string | undefined;
    await verifyToken("  spaced-tok  ", async (t) => { got = t; });
    expect(got).toBe("spaced-tok");
  });
});

// The CLI falls back to stored credentials (~/.claude, keychain) when the env token is unusable,
// so a ping run in the daemon's own environment answers "pong" for a garbage token.
describe("pingEnv", () => {
  const BASE = { PATH: "/usr/bin", HOME: "/Users/someone", ANTHROPIC_API_KEY: "sk-key" } as NodeJS.ProcessEnv;

  it("makes the pasted token the only credential the CLI can see", () => {
    const env = pingEnv("tok", { ...BASE, ANTHROPIC_AUTH_TOKEN: "b", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
  });

  it("points CLAUDE_CONFIG_DIR at a fresh empty dir, one per call", () => {
    const a = pingEnv("tok", BASE);
    const b = pingEnv("tok", BASE);
    expect(a.CLAUDE_CONFIG_DIR).toBeTruthy();
    expect(a.CLAUDE_CONFIG_DIR).not.toBe(b.CLAUDE_CONFIG_DIR);
    expect(statSync(a.CLAUDE_CONFIG_DIR!).isDirectory()).toBe(true);
    expect(readdirSync(a.CLAUDE_CONFIG_DIR!)).toEqual([]);
  });

  it("keeps the rest of the environment — the CLI still needs PATH and HOME", () => {
    const env = pingEnv("tok", BASE);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/someone");
  });

  it("does not mutate the environment it was given", () => {
    const base = { ...BASE };
    pingEnv("tok", base);
    expect(base.ANTHROPIC_API_KEY).toBe("sk-key");
    expect(base.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

// A rejected token comes back as subtype "success" carrying is_error — the subtype alone lies.
describe("pingFailure", () => {
  it("passes a clean success", () => {
    expect(pingFailure({ subtype: "success", is_error: false, result: "pong" })).toBeNull();
  });

  it("fails a success that carries an API error, quoting the CLI's own words", () => {
    const msg = {
      subtype: "success", is_error: true, api_error_status: 401,
      result: "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
    };
    expect(pingFailure(msg)).toBe("Failed to authenticate. API Error: 401 OAuth access token is invalid.");
  });

  it("fails on api_error_status alone", () => {
    expect(pingFailure({ subtype: "success", is_error: false, api_error_status: 500, result: "" }))
      .toBe("auth check failed: the API rejected the token");
  });

  it("fails a non-success subtype", () => {
    expect(pingFailure({ subtype: "error_during_execution", is_error: true }))
      .toBe("auth check failed: error_during_execution");
  });
});
