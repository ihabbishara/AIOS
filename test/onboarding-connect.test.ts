// test/onboarding-connect.test.ts — the Connect step: Telegram/Slack/Gemini verification,
// chat-id capture, dual .env+process.env writes, and the injection/concurrency guards.
// These routes mutate process.env (that is the point — the hot boot reads it), so every
// touched key is snapshotted and restored or the suite goes order-dependent.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { startSetupServer, type SetupDeps } from "../src/onboarding/server.js";
import { grantMediaGen, type OrgProposal } from "../src/onboarding/proposal.js";

const ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS", "AIOS_PRIMARY_CHAT",
  "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "GEMINI_API_KEY", "AIOS_GEMINI_IMAGE_MODEL",
] as const;
let envSnapshot: Record<string, string | undefined> = {};
beforeEach(() => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

function kv() {
  const m = new Map<string, string>();
  return { kvGet: (k: string) => m.get(k), kvSet: (k: string, v: string) => void m.set(k, v) };
}

let server: Server;
afterEach(() => server?.close());

/** URL-substring-keyed fetch stub for the connect endpoints. */
function stubFetch(routes: Record<string, { status?: number; body: unknown }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [needle, r] of Object.entries(routes)) {
      if (url.includes(needle)) return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }
    throw new Error(`no stub for ${url}`);
  }) as typeof fetch;
}

async function boot(connectFetch?: typeof fetch, step = "connect", over: Partial<SetupDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "connect-"));
  writeFileSync(join(dir, "index.html"), "<html>wizard</html>");
  const envPath = join(dir, ".env");
  const store = kv();
  store.kvSet("onboarding.step", step);
  server = startSetupServer({
    store, envPath, uiDist: dir, port: 0, ping: async () => {},
    agentsDir: join(dir, "agents"), playbooksDir: join(dir, "playbooks"),
    templatesDir: join(process.cwd(), "templates"),
    ...(connectFetch ? { connectFetch } : {}),
    ...over,
  });
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, envPath, store };
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });

const GETME_OK = { "api.telegram.org": { body: { ok: true, result: { username: "aios_test_bot" } } } };

describe("connect: telegram", () => {
  it("verifies via getMe, writes .env AND process.env, does not advance", async () => {
    const { base, envPath, store } = await boot(stubFetch(GETME_OK));
    const r = await post(base, "/api/onboarding/connect/telegram", { token: "12:abc", allowedUserIds: "123, 456" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.telegram).toMatchObject({ connected: true, botUsername: "aios_test_bot", allowedUserIds: "123,456" });
    const env = readFileSync(envPath, "utf8");
    expect(env).toContain("TELEGRAM_BOT_TOKEN=12:abc");
    expect(env).toContain("TELEGRAM_ALLOWED_USER_IDS=123,456");
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("12:abc"); // the hot boot reads THIS
    expect(store.kvGet("onboarding.step")).toBe("connect"); // saves never advance
  });

  it("getMe rejection → 400, nothing written", async () => {
    const { base, envPath } = await boot(stubFetch({
      "api.telegram.org": { body: { ok: false, description: "Unauthorized" } },
    }));
    const r = await post(base, "/api/onboarding/connect/telegram", { token: "bad" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/Unauthorized/);
    expect(existsSync(envPath)).toBe(false);
    expect(process.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it("multi-line token → 400 (env-injection guard), no network call", async () => {
    const { base, envPath } = await boot((async () => { throw new Error("network touched"); }) as never);
    const r = await post(base, "/api/onboarding/connect/telegram", { token: "a\nEVIL=1" });
    expect(r.status).toBe(400);
    expect(existsSync(envPath)).toBe(false);
  });

  it("non-numeric allowedUserIds → 400 before any write", async () => {
    const { base, envPath } = await boot(stubFetch(GETME_OK));
    const r = await post(base, "/api/onboarding/connect/telegram", { token: "12:abc", allowedUserIds: "abc" });
    expect(r.status).toBe(400);
    expect(existsSync(envPath)).toBe(false);
  });
});

describe("connect: capture → primary", () => {
  it("captures a chat id from getUpdates and primary writes AIOS_PRIMARY_CHAT + auto-allows the sender", async () => {
    const { base, envPath } = await boot(stubFetch({
      "/getMe": { body: { ok: true, result: { username: "b" } } },
      "/getUpdates": { body: { ok: true, result: [
        { update_id: 7, message: { chat: { id: 12345, type: "private" }, from: { id: 999, first_name: "Ihab" }, text: "hi" } },
      ] } },
    }));
    await post(base, "/api/onboarding/connect/telegram", { token: "12:abc" });
    let r = await post(base, "/api/onboarding/connect/telegram/capture", {});
    expect(r.status).toBe(200);
    expect((await r.json()).captured).toMatchObject({ chatId: "12345", chatType: "private", from: "Ihab", fromId: "999" });
    r = await post(base, "/api/onboarding/connect/telegram/primary", { chatId: "12345", userId: "999" });
    expect(r.status).toBe(200);
    const env = readFileSync(envPath, "utf8");
    expect(env).toContain("AIOS_PRIMARY_CHAT=telegram:12345");
    expect(env).toContain("TELEGRAM_ALLOWED_USER_IDS=999");
    expect(process.env.AIOS_PRIMARY_CHAT).toBe("telegram:12345");
  });

  it("empty poll → captured null; Telegram 409 → our 409 with a stop-the-other-bot message", async () => {
    const { base } = await boot(stubFetch({
      "/getMe": { body: { ok: true, result: { username: "b" } } },
      "/getUpdates": { body: { ok: true, result: [] } },
    }));
    await post(base, "/api/onboarding/connect/telegram", { token: "12:abc" });
    let r = await post(base, "/api/onboarding/connect/telegram/capture", {});
    expect((await r.json()).captured).toBeNull();

    const { base: base2 } = await boot(stubFetch({
      "/getMe": { body: { ok: true, result: { username: "b" } } },
      "/getUpdates": { status: 409, body: { ok: false } },
    }));
    await post(base2, "/api/onboarding/connect/telegram", { token: "12:abc" });
    r = await post(base2, "/api/onboarding/connect/telegram/capture", {});
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/another process/);
  });

  it("capture without a saved token → 400", async () => {
    const { base } = await boot(stubFetch({}));
    const r = await post(base, "/api/onboarding/connect/telegram/capture", {});
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/token first/);
  });

  it("a second capture while one is in flight → 409", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { base } = await boot((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/getMe")) return new Response(JSON.stringify({ ok: true, result: { username: "b" } }));
      await gate; // hold the long-poll open
      return new Response(JSON.stringify({ ok: true, result: [] }));
    }) as typeof fetch);
    await post(base, "/api/onboarding/connect/telegram", { token: "12:abc" });
    const first = post(base, "/api/onboarding/connect/telegram/capture", {});
    await new Promise((r) => setTimeout(r, 30)); // let the first request take the flag
    const second = await post(base, "/api/onboarding/connect/telegram/capture", {});
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });
});

describe("connect: slack", () => {
  it("one token only → 400 with the both-required rule", async () => {
    const { base, envPath } = await boot(stubFetch({}));
    const r = await post(base, "/api/onboarding/connect/slack", { botToken: "xoxb-1" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/both tokens/);
    expect(existsSync(envPath)).toBe(false);
  });

  it("auth.test failure → 400 nothing written; both passing → both keys land", async () => {
    const bad = await boot(stubFetch({ "auth.test": { body: { ok: false, error: "invalid_auth" } } }));
    let r = await post(bad.base, "/api/onboarding/connect/slack", { botToken: "xoxb-1", appToken: "xapp-1" });
    expect(r.status).toBe(400);
    expect(existsSync(bad.envPath)).toBe(false);
    server.close();

    const good = await boot(stubFetch({
      "auth.test": { body: { ok: true, team: "Acme", user: "aios" } },
      "apps.connections.open": { body: { ok: true, url: "wss://x" } },
    }));
    r = await post(good.base, "/api/onboarding/connect/slack", { botToken: "xoxb-1", appToken: "xapp-1" });
    expect(r.status).toBe(200);
    expect((await r.json()).slack).toMatchObject({ connected: true, team: "Acme", botUser: "aios" });
    const env = readFileSync(good.envPath, "utf8");
    expect(env).toContain("SLACK_BOT_TOKEN=xoxb-1");
    expect(env).toContain("SLACK_APP_TOKEN=xapp-1");
  });
});

describe("connect: image (gemini)", () => {
  it("models GET failure → 400; success writes the key, model only when supplied", async () => {
    const bad = await boot(stubFetch({
      "generativelanguage.googleapis.com": { status: 403, body: { error: { message: "API key not valid" } } },
    }));
    let r = await post(bad.base, "/api/onboarding/connect/image", { apiKey: "k1" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/not valid/);
    server.close();

    const good = await boot(stubFetch({ "generativelanguage.googleapis.com": { body: { name: "models/x" } } }));
    r = await post(good.base, "/api/onboarding/connect/image", { apiKey: "k1" });
    expect(r.status).toBe(200);
    const env = readFileSync(good.envPath, "utf8");
    expect(env).toContain("GEMINI_API_KEY=k1");
    expect(env).not.toContain("AIOS_GEMINI_IMAGE_MODEL"); // config default stays authoritative
    expect((await (await fetch(`${good.base}/api/onboarding/connect`)).json()).image.connected).toBe(true);
  });

  it("bad model charset → 400 with no network call", async () => {
    const { base } = await boot((async () => { throw new Error("network touched"); }) as never);
    const r = await post(base, "/api/onboarding/connect/image", { apiKey: "k1", model: "../evil" });
    expect(r.status).toBe(400);
  });
});

describe("connect: step semantics", () => {
  it("POSTs from the wrong step → 400", async () => {
    const { base } = await boot(stubFetch(GETME_OK), "welcome");
    const r = await post(base, "/api/onboarding/connect/telegram", { token: "12:abc" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/connect step/);
  });

  it("whole-step skip: generic advance moves to interview with .env never created", async () => {
    const { base, envPath } = await boot(stubFetch({}));
    const r = await post(base, "/api/onboarding/advance", { from: "connect" });
    expect((await r.json()).step).toBe("interview");
    expect(existsSync(envPath)).toBe(false);
  });

  it("GET status never contains a token substring", async () => {
    const { base } = await boot(stubFetch(GETME_OK));
    await post(base, "/api/onboarding/connect/telegram", { token: "12:secret-token" });
    const text = JSON.stringify(await (await fetch(`${base}/api/onboarding/connect`)).json());
    expect(text).not.toContain("secret-token");
  });
});

describe("media-gen proposal grant", () => {
  const proposal: OrgProposal = {
    source: { kind: "interview" },
    departments: [],
    agents: [
      { name: "a", department: "d", kind: "worker", title: "t", charter: "c", persona: "p", prompt: "pr", capabilities: ["research"], skills: [] },
      { name: "b", department: "d", kind: "lead", title: "t", charter: "c", persona: "p", prompt: "pr", capabilities: [], skills: [] },
      { name: "c", department: "d", kind: "critic", title: "t", charter: "c", persona: "p", prompt: "pr", capabilities: [], skills: [] },
      { name: "n", department: "d", kind: "coordinator", title: "t", charter: "c", persona: "p", prompt: "pr", capabilities: [], skills: [] },
    ],
    firstJob: "f",
  };

  it("grantMediaGen: workers and leads gain media-gen once; critics and the coordinator never", () => {
    const out = grantMediaGen(grantMediaGen(proposal)); // idempotent
    const caps = Object.fromEntries(out.agents.map((a) => [a.name, a.capabilities]));
    expect(caps.a).toEqual(["research", "media-gen"]);
    expect(caps.b).toEqual(["media-gen"]);
    expect(caps.c).toEqual([]);
    expect(caps.n).toEqual([]);
  });

  it("template pick applies the grant only when GEMINI_API_KEY is present", async () => {
    // without the key
    let ctx = await boot(stubFetch({}), "interview");
    await post(ctx.base, "/api/onboarding/template", { name: "starter" });
    let stored = JSON.parse(ctx.store.kvGet("onboarding.proposal")!) as OrgProposal;
    expect(stored.agents.some((a) => a.capabilities.includes("media-gen"))).toBe(false);
    server.close();

    // with the key
    process.env.GEMINI_API_KEY = "k1";
    ctx = await boot(stubFetch({}), "interview");
    await post(ctx.base, "/api/onboarding/template", { name: "starter" });
    stored = JSON.parse(ctx.store.kvGet("onboarding.proposal")!) as OrgProposal;
    const workers = stored.agents.filter((a) => a.kind === "worker" || a.kind === "lead");
    expect(workers.length).toBeGreaterThan(0);
    expect(workers.every((a) => a.capabilities.includes("media-gen"))).toBe(true);
    expect(stored.agents.filter((a) => a.kind === "coordinator").every((a) => !a.capabilities.includes("media-gen"))).toBe(true);
  });
});
