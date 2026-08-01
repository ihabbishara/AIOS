// test/onboarding-first-job.test.ts — first-job dispatch through the coordinator (spec §3).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { startSetupServer, type SetupDeps } from "../src/onboarding/server.js";
import type { BootedWorld } from "../src/boot.js";

function kv() {
  const m = new Map<string, string>();
  return { kvGet: (k: string) => m.get(k), kvSet: (k: string, v: string) => void m.set(k, v) };
}

let server: Server;
afterEach(() => server?.close());

const PROPOSAL = JSON.stringify({
  source: { kind: "interview" },
  departments: [{ department: "ops", mission: "m", memoDomain: "d", capabilities: [], playbooks: [] }],
  agents: [{ name: "nova", department: "ops", kind: "coordinator", title: "t", charter: "c",
             persona: "p", prompt: "pr", capabilities: [], skills: [] }],
  firstJob: "Draft a chaser email for the oldest unpaid invoice.",
});

/** Minimum shape the first-job endpoints touch: a moderator to dispatch through and a store
 *  to read goals from. Cast once, here, so the tests read as real usage. */
function fakeWorld(over: Partial<BootedWorld> = {}): BootedWorld {
  return {
    moderator: { handle: async () => ({ text: "done", attachments: [] }) },
    store: { listGoals: () => [], listNodes: () => [] },
    startWeb: () => {},
    ...over,
  } as unknown as BootedWorld;
}

/** The wizard as it stands when the user reaches this step: org on disk, step first-job. */
async function start(over: Partial<SetupDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fj-"));
  const store = kv();
  store.kvSet("onboarding.step", "first-job");
  store.kvSet("onboarding.proposal", PROPOSAL);
  server = startSetupServer({
    store, envPath: join(dir, ".env"), uiDist: dir, port: 0, ping: async () => {},
    agentsDir: join(dir, "agents"), playbooksDir: join(dir, "playbooks"),
    templatesDir: join(process.cwd(), "templates"),
    // A real run arrives here having provisioned; the default probe would read the empty temp
    // agents dir and refuse the pre-boot below, quietly moving every test onto the lazy path.
    orgExists: () => true,
    ...over,
  });
  await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function boot(world: Partial<BootedWorld>, over: Partial<SetupDeps> = {}) {
  const base = await start({ boot: async () => fakeWorld(world), ...over });
  const r = await fetch(`${base}/api/onboarding/boot`, { method: "POST", body: "{}" });
  // Asserted, not assumed: a refused pre-boot leaves `world` null, and the tests below would
  // then be exercising the on-demand path instead of the one they name.
  expect(r.status).toBe(200);
  return { base };
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/api/onboarding/first-job`, { method: "POST", body: JSON.stringify(body) });

const get = async (base: string) =>
  (await (await fetch(`${base}/api/onboarding/first-job`)).json()) as
    { status: string; request?: string; reply?: string; error?: string; goals: Array<{ slug: string }> };

/** Poll until the dispatch settles — handle() resolves on its own clock. */
async function settle(base: string) {
  for (let i = 0; i < 100; i++) {
    const s = await get(base);
    if (s.status !== "running") return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("first job never settled");
}

describe("first job", () => {
  it("is idle before anything is dispatched", async () => {
    const { base } = await boot({});
    expect(await get(base)).toMatchObject({ status: "idle", goals: [] });
  });

  it("hands the request to the coordinator on the onboarding origin and stores the reply", async () => {
    const seen: string[][] = [];
    const { base } = await boot({
      moderator: {
        handle: async (ch: string, id: string, text: string) => {
          seen.push([ch, id, text]);
          return { text: "I drafted it.", attachments: [] };
        },
      } as unknown as BootedWorld["moderator"],
    });
    const r = await post(base, { request: "Draft the chaser." });
    expect(r.status).toBe(200);
    const s = await settle(base);
    // The origin tuple is asserted, not just the text: it is the correlation key the goals
    // view filters on, so a drifted channel/chatId would silently empty that list.
    expect(seen).toEqual([["web", "onboarding", "Draft the chaser."]]);
    expect(s).toMatchObject({ status: "done", request: "Draft the chaser.", reply: "I drafted it." });
  });

  it("records a coordinator failure without wedging the wizard", async () => {
    const { base } = await boot({
      moderator: { handle: async () => { throw new Error("model unavailable"); } } as unknown as BootedWorld["moderator"],
    });
    await post(base, { request: "go" });
    const s = await settle(base);
    expect(s.status).toBe("failed");
    expect(s.error).toContain("model unavailable");
  });

  it("returns only goals whose origin is the onboarding chat", async () => {
    const rows = [
      { id: "g1", slug: "mine", title: "Mine", request: "", department: "ops", lead: "nova",
        origin_channel: "web", origin_chat_id: "onboarding", status: "running", project_dir: null,
        goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, spawned_by_mail: null,
        created_at: "t", updated_at: "t" },
      { id: "g2", slug: "other", title: "Other", request: "", department: "ops", lead: "nova",
        origin_channel: "telegram", origin_chat_id: "123", status: "running", project_dir: null,
        goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, spawned_by_mail: null,
        created_at: "t", updated_at: "t" },
      // Same channel, different chat: the pair must match, not either half.
      { id: "g3", slug: "other-web-chat", title: "Other web", request: "", department: "ops", lead: "nova",
        origin_channel: "web", origin_chat_id: "ui", status: "running", project_dir: null,
        goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, spawned_by_mail: null,
        created_at: "t", updated_at: "t" },
    ];
    const { base } = await boot({
      moderator: { handle: async () => ({ text: "ok", attachments: [] }) } as unknown as BootedWorld["moderator"],
      store: { listGoals: () => rows, listNodes: () => [] } as unknown as BootedWorld["store"],
    });
    await post(base, { request: "go" });
    const s = await settle(base);
    expect(s.goals.map((g) => g.slug)).toEqual(["mine"]);
  });

  it("400s with the boot error when the daemon cannot start", async () => {
    const base = await start({ boot: async () => { throw new Error("nope"); } });
    const r = await post(base, { request: "go" });
    expect(r.status).toBe(400);
    // The message matters: "request required" and "body must be JSON" are 400s from this same
    // endpoint, so the status alone would not say which guard answered.
    expect(((await r.json()) as { error: string }).error).toContain("nope");
  });

  /**
   * D-1: the POST must AWAIT ensureBooted(). Dropping the await hands `w` a pending promise —
   * truthy, so the null check passes — and the dispatch then reads `.moderator` off it. This is
   * the only test where the boot is still in flight when the request needs the world, so it is
   * the one that dies (500, and the coordinator never called) if the await goes away.
   */
  it("boots on demand and waits for the world before dispatching", async () => {
    const seen: string[] = [];
    let booted = 0;
    const base = await start({
      boot: async () => {
        booted++;
        await new Promise((r) => setTimeout(r, 25));
        return fakeWorld({
          moderator: { handle: async (_c: string, _i: string, t: string) => {
            seen.push(t);
            return { text: "late but here", attachments: [] };
          } } as unknown as BootedWorld["moderator"],
        });
      },
    });
    // Nothing has booted yet: this POST is what triggers it, which is what makes the await race.
    expect(booted).toBe(0);
    const r = await post(base, { request: "go" });
    expect(r.status).toBe(200);
    expect(booted).toBe(1);
    const s = await settle(base);
    expect(seen).toEqual(["go"]);
    expect(s).toMatchObject({ status: "done", reply: "late but here" });
  });

  it("refuses to dispatch before an org exists, without booting", async () => {
    let attempts = 0;
    const base = await start({
      orgExists: () => false,
      boot: async () => { attempts++; return fakeWorld(); },
    });
    const r = await post(base, { request: "go" });
    expect(r.status).toBe(409);
    // Same rule as /api/onboarding/boot: reaching bootNormal with no org latches `world` to a
    // zero-agent daemon, and every later job then runs against an empty registry.
    expect(attempts).toBe(0);
    expect((await get(base)).status).toBe("idle");
  });

  it("refuses an empty request", async () => {
    const { base } = await boot({
      moderator: { handle: async () => ({ text: "ok", attachments: [] }) } as unknown as BootedWorld["moderator"],
    });
    const r = await post(base, { request: "   " });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("request required");
    // Nothing was dispatched, so the step stays offerable rather than latching to running.
    expect((await get(base)).status).toBe("idle");
  });
});
