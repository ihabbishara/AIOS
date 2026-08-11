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
    // The dispatch bills the coordinator's turn, so the world it runs against has to carry a
    // bus and a registry — the router does this everywhere else, and calling handle() directly
    // means this endpoint owns the agent.start/agent.end pair itself.
    bus: { emit: () => {} },
    registry: { coordinator: "nova" },
    startWeb: () => {},
    ...over,
  } as unknown as BootedWorld;
}

/** A `handle` that parks until released. That window — a coordinator turn takes minutes — is
 *  where every state defect below lives, so the tests need to stand inside it. */
function deferredHandle() {
  const calls: string[] = [];
  let release!: (reply: string) => void;
  const gate = new Promise<string>((r) => { release = r; });
  return {
    calls,
    release: (reply: string) => release(reply),
    moderator: {
      handle: async (_c: string, _i: string, text: string) => {
        calls.push(text);
        return { text: await gate, attachments: [] };
      },
    } as unknown as BootedWorld["moderator"],
  };
}

/** The wizard as it stands when the user reaches this step: org on disk, step first-job.
 *  `seed` writes kv before the server reads it — how a previous process's leftovers arrive. */
async function start(over: Partial<SetupDeps> = {}, seed?: (s: ReturnType<typeof kv>) => void) {
  const dir = mkdtempSync(join(tmpdir(), "fj-"));
  const store = kv();
  store.kvSet("onboarding.step", "first-job");
  store.kvSet("onboarding.proposal", PROPOSAL);
  seed?.(store);
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

  it("bills the coordinator's turn — the user's first spend must not be invisible", async () => {
    // handle() only rides costUsd out; the ROUTER emits the pair everywhere else. Dispatching
    // directly here billed nobody, on the one screen meant to show the org working.
    const events: Array<Record<string, unknown>> = [];
    const { base } = await boot({
      bus: { emit: (e: Record<string, unknown>) => events.push(e) } as unknown as BootedWorld["bus"],
      registry: { coordinator: "nova" } as unknown as BootedWorld["registry"],
      moderator: {
        handle: async () => ({ text: "done", attachments: [], costUsd: 0.42 }),
      } as unknown as BootedWorld["moderator"],
    });
    await post(base, { request: "Draft the chaser." });
    await settle(base);
    expect(events).toEqual([
      { type: "agent.start", agent: "nova", context: "chat:web:onboarding" },
      { type: "agent.end", agent: "nova", context: "chat:web:onboarding", ok: true, costUsd: 0.42 },
    ]);
  });

  it("a failed turn still closes the pair, and a broken bus never wedges the dispatch", async () => {
    // Anything thrown out of the billing path skips `finally`, leaving `dispatching` up with
    // nothing running — every later POST then 409s against a job that will never settle.
    const { base } = await boot({
      bus: { emit: () => { throw new Error("bus down"); } } as unknown as BootedWorld["bus"],
      registry: { coordinator: "nova" } as unknown as BootedWorld["registry"],
    });
    await post(base, { request: "Draft the chaser." });
    const s = await settle(base);
    expect(s).toMatchObject({ status: "failed" });
    // Settled, so the flag came back down and a retry is accepted rather than 409'd.
    expect((await post(base, { request: "Again." })).status).toBe(200);
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

  // kv is durable, the flag that says "this process is dispatching" is not — which is exactly
  // what makes a leftover `running` recognisable as stale rather than live.
  it("reports a running job left behind by a dead process as failed, and takes a new one", async () => {
    const base = await start(
      { boot: async () => fakeWorld() },
      (s) => s.kvSet("onboarding.firstJob", JSON.stringify({ status: "running", request: "from a dead process" })),
    );
    const s = await get(base);
    expect(s.status).toBe("failed");
    expect(s.error).toContain("interrupted");
    expect(s.request).toBe("from a dead process");
    // Reconciling on read is only half of it: the step must still accept a fresh dispatch, or
    // the wizard is wedged in a different way than before.
    expect((await post(base, { request: "again" })).status).toBe(200);
    expect(await settle(base)).toMatchObject({ status: "done", request: "again" });
  });

  it("still reports a live dispatch as running", async () => {
    const d = deferredHandle();
    const { base } = await boot({ moderator: d.moderator });
    await post(base, { request: "A" });
    // The stale check must key on the flag, not on the status: healing every `running` would
    // report the job the user is watching as failed while it is still working.
    expect(await get(base)).toMatchObject({ status: "running", request: "A" });
    d.release("done at last");
    expect(await settle(base)).toMatchObject({ status: "done", reply: "done at last" });
  });

  it("refuses a second dispatch in flight, and the first settles onto its own state", async () => {
    const d = deferredHandle();
    const { base } = await boot({ moderator: d.moderator });
    expect((await post(base, { request: "A" })).status).toBe(200);

    const second = await post(base, { request: "B" });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe("a first job is already running");
    expect(d.calls).toEqual(["A"]);
    // The refusal left A's state alone — B never overwrote it.
    expect(await get(base)).toMatchObject({ status: "running", request: "A" });

    d.release("reply to A");
    // The point of the guard: A resolves onto A. Unguarded, A's reply landed on B's `running`
    // state and a UI that stops polling at `done` showed the answer to a superseded request.
    expect(await settle(base)).toMatchObject({ status: "done", request: "A", reply: "reply to A" });
  });

  it("lets only one of two POSTs that race across the boot through", async () => {
    const d = deferredHandle();
    // Nothing is booted, and the boot takes 25ms: both requests are parked inside
    // `await ensureBooted()` at the same time, so the check-and-set really is interleaved —
    // a guard placed before that await would let both dispatch.
    const base = await start({
      boot: async () => {
        await new Promise((r) => setTimeout(r, 25));
        return fakeWorld({ moderator: d.moderator });
      },
    });
    const [a, b] = await Promise.all([post(base, { request: "A" }), post(base, { request: "B" })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(d.calls.length).toBe(1);
    d.release("ok");
    await settle(base);
  });

  it("stays retryable when the initial running write fails", async () => {
    const m = new Map<string, string>([["onboarding.step", "first-job"]]);
    let failNext = true;
    const store = {
      kvGet: (k: string) => m.get(k),
      kvSet: (k: string, v: string) => {
        // The *first* write of the job state fails — the one the settlement test excludes.
        if (k === "onboarding.firstJob" && failNext) { failNext = false; throw new Error("SQLITE_BUSY"); }
        m.set(k, v);
      },
    };
    const base = await start({ store, boot: async () => fakeWorld() });

    expect((await post(base, { request: "go" })).status).toBe(500);
    // A write that failed started nothing, so GET must agree that nothing is running...
    expect(await get(base)).toMatchObject({ status: "idle" });
    // ...and the next attempt is a retry, not a duplicate. Refused here, POST would insist a job
    // is running while GET says idle, for the lifetime of the process.
    expect((await post(base, { request: "go" })).status).toBe(200);
    expect(await settle(base)).toMatchObject({ status: "done", request: "go" });
  });

  it("keeps the step usable when the settlement write itself fails", async () => {
    const m = new Map<string, string>([["onboarding.step", "first-job"]]);
    const store = {
      kvGet: (k: string) => m.get(k),
      kvSet: (k: string, v: string) => {
        // The dispatch records `running` fine; the write of the *result* is what fails, the way
        // a SQLITE_BUSY would. That is a throw from inside the settlement path itself.
        if (k === "onboarding.firstJob" && !v.includes(`"running"`)) throw new Error("SQLITE_BUSY");
        m.set(k, v);
      },
    };
    // Asserted here rather than left to vitest's "Errors" line, which the standing rule to read
    // the "Tests" line would walk straight past.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const base = await start({ store, boot: async () => fakeWorld() });
      expect((await post(base, { request: "go" })).status).toBe(200);
      // kv is stuck on `running`, so the flag must come down anyway — otherwise the read-path
      // reconcile never fires and every later POST 409s against a job that cannot finish.
      const s = await settle(base);
      expect(s.status).toBe("failed");
      expect(s.error).toContain("interrupted");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("records a coordinator that throws synchronously rather than stranding the job", async () => {
    const { base } = await boot({
      // Not reachable through today's async Moderator — the point is that the invariant
      // "a running job always settles" belongs to this code, not to Moderator's signature.
      moderator: { handle: () => { throw new Error("no session"); } } as unknown as BootedWorld["moderator"],
    });
    const r = await post(base, { request: "go" });
    expect(r.status).toBe(200);
    const s = await settle(base);
    expect(s.status).toBe("failed");
    expect(s.error).toContain("no session");
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
