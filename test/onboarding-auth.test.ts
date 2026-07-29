// test/onboarding-auth.test.ts — verifyToken: env set/restore + error surfacing (spec §2).
import { describe, it, expect, afterEach } from "vitest";
import { verifyToken } from "../src/onboarding/auth.js";

const ORIG = process.env.CLAUDE_CODE_OAUTH_TOKEN;
afterEach(() => {
  if (ORIG === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIG;
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
});
