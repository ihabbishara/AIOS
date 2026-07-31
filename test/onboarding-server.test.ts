// test/onboarding-server.test.ts — wizard HTTP walk: welcome → auth → workspace (spec §1-2).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { connect } from "node:net";
import { startSetupServer, type SetupDeps } from "../src/onboarding/server.js";

function kv() {
  const m = new Map<string, string>();
  return { kvGet: (k: string) => m.get(k), kvSet: (k: string, v: string) => void m.set(k, v) };
}

let server: Server;
afterEach(() => server?.close());

async function boot(ping: () => Promise<void>, over: Partial<SetupDeps> = {}, step?: string) {
  const dir = mkdtempSync(join(tmpdir(), "setup-"));
  writeFileSync(join(dir, "index.html"), "<html>wizard</html>");
  const envPath = join(dir, ".env");
  const store = kv();
  if (step) store.kvSet("onboarding.step", step);
  server = startSetupServer({
    store, envPath, uiDist: dir, port: 0, ping,
    agentsDir: join(dir, "agents"), playbooksDir: join(dir, "playbooks"),
    templatesDir: join(process.cwd(), "templates"),
    ...over,
  });
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, envPath, store };
}

describe("setup server", () => {
  it("walks welcome → auth → workspace over HTTP, persisting the token", async () => {
    const { base, envPath } = await boot(async () => {});
    let r = await fetch(`${base}/api/state`);
    expect(await r.json()).toEqual({ mode: "setup", step: "welcome" });

    r = await fetch(`${base}/api/onboarding/advance`, {
      method: "POST", body: JSON.stringify({ from: "welcome" }),
    });
    expect((await r.json()).step).toBe("auth");

    r = await fetch(`${base}/api/onboarding/auth`, {
      method: "POST", body: JSON.stringify({ token: "tok-123" }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("workspace");
    expect(readFileSync(envPath, "utf8")).toContain("CLAUDE_CODE_OAUTH_TOKEN=tok-123");
  });

  it("surfaces ping failure as 400 and does not advance or write env", async () => {
    const { base, envPath } = await boot(async () => { throw new Error("401 bad token"); });
    await fetch(`${base}/api/onboarding/advance`, { method: "POST", body: JSON.stringify({ from: "welcome" }) });
    const r = await fetch(`${base}/api/onboarding/auth`, {
      method: "POST", body: JSON.stringify({ token: "bad" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("401 bad token");
    const s = await (await fetch(`${base}/api/state`)).json();
    expect(s.step).toBe("auth");
    expect(() => readFileSync(envPath, "utf8")).toThrow(); // never written
  });

  it("refuses to skip auth via the generic advance", async () => {
    const { base } = await boot(async () => {});
    await fetch(`${base}/api/onboarding/advance`, { method: "POST", body: JSON.stringify({ from: "welcome" }) });
    const r = await fetch(`${base}/api/onboarding/advance`, { method: "POST", body: JSON.stringify({ from: "auth" }) });
    expect(r.status).toBe(400);
  });

  it("serves the SPA with index.html fallback", async () => {
    const { base } = await boot(async () => {});
    expect(await (await fetch(`${base}/`)).text()).toContain("wizard");
    expect(await (await fetch(`${base}/some/route`)).text()).toContain("wizard");
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  // A junk `from`/`to` must be rejected by the route, not by a Wizard throw — the wizard's
  // error is the fallback, not the validation layer.
  it("rejects a body whose step is not a wizard step", async () => {
    const { base } = await boot(async () => {});
    const adv = await fetch(`${base}/api/onboarding/advance`, {
      method: "POST", body: JSON.stringify({ from: "../../etc/passwd" }),
    });
    expect(adv.status).toBe(400);
    expect((await adv.json()).error).toContain("wizard step");
    const back = await fetch(`${base}/api/onboarding/back`, {
      method: "POST", body: JSON.stringify({ to: 7 }),
    });
    expect(back.status).toBe(400);
    expect((await back.json()).error).toContain("wizard step");
  });

  it("goes back to an earlier step", async () => {
    const { base } = await boot(async () => {});
    await fetch(`${base}/api/onboarding/advance`, { method: "POST", body: JSON.stringify({ from: "welcome" }) });
    const r = await fetch(`${base}/api/onboarding/back`, { method: "POST", body: JSON.stringify({ to: "welcome" }) });
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("welcome");
  });

  // verifyToken mutates process-global env, so two verifications must never interleave.
  it("rejects a second concurrent auth with 409 while one is in flight", async () => {
    let enteredPing!: () => void;
    let releasePing!: () => void;
    const entered = new Promise<void>((r) => { enteredPing = r; });
    const released = new Promise<void>((r) => { releasePing = r; });
    const { base } = await boot(async () => { enteredPing(); await released; });

    await fetch(`${base}/api/onboarding/advance`, { method: "POST", body: JSON.stringify({ from: "welcome" }) });
    const first = fetch(`${base}/api/onboarding/auth`, { method: "POST", body: JSON.stringify({ token: "tok-1" }) });
    await entered; // the server is now inside verifyToken

    const second = await fetch(`${base}/api/onboarding/auth`, { method: "POST", body: JSON.stringify({ token: "tok-2" }) });
    expect(second.status).toBe(409);

    releasePing();
    const done = await first;
    expect(done.status).toBe(200);
    expect((await done.json()).step).toBe("workspace");
  });

  // No auth token guards this server, so a no-cors POST from any open page would otherwise
  // reach the auth endpoint and get an attacker's token verified and written to .env.
  it("refuses a cross-origin API request and still serves its own", async () => {
    const { base, envPath } = await boot(async () => {});
    await fetch(`${base}/api/onboarding/advance`, { method: "POST", body: JSON.stringify({ from: "welcome" }) });

    const evil = await fetch(`${base}/api/onboarding/auth`, {
      method: "POST",
      headers: { origin: "http://evil.example" },
      body: JSON.stringify({ token: "tok-123" }),
    });
    expect(evil.status).toBe(403);
    expect(() => readFileSync(envPath, "utf8")).toThrow(); // never verified, never written

    const own = await fetch(`${base}/api/state`, { headers: { origin: base } });
    expect(own.status).toBe(200);
    expect((await own.json()).step).toBe("auth");
  });

  it("answers a re-submitted auth with 409 and the step the wizard is actually on", async () => {
    const { base } = await boot(async () => {});
    await fetch(`${base}/api/onboarding/advance`, { method: "POST", body: JSON.stringify({ from: "welcome" }) });
    const first = await fetch(`${base}/api/onboarding/auth`, { method: "POST", body: JSON.stringify({ token: "tok-123" }) });
    expect(first.status).toBe(200);

    const again = await fetch(`${base}/api/onboarding/auth`, { method: "POST", body: JSON.stringify({ token: "tok-123" }) });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ step: "workspace" });
  });

  // llhttp accepts request targets `new URL` rejects, and this parse runs in the request
  // listener — a throw there is an uncaughtException, i.e. a silently dead daemon.
  it("answers a malformed request target without dying", async () => {
    const { base } = await boot(async () => {});
    const port = Number(new URL(base).port);
    // Origin-form, a bad escape, and absolute-form — all accepted by llhttp, all rejected by `new URL`.
    for (const target of ["//[", "//%zz", "http://[/"]) {
      const head = await new Promise<string>((resolve, reject) => {
        const sock = connect(port, "127.0.0.1", () => sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`));
        let buf = "";
        sock.on("data", (d: Buffer) => {
          buf += d.toString("utf8");
          if (buf.includes("\r\n\r\n")) { sock.destroy(); resolve(buf); }
        });
        sock.on("error", reject);
        sock.on("close", () => resolve(buf));
      });
      expect(head, `target ${target}`).toContain("400");
    }

    // The process is still alive and still serving — the point of the whole test.
    const after = await fetch(`${base}/api/state`);
    expect(after.status).toBe(200);
    expect((await after.json()).step).toBe("welcome");
  });

  it("logs an unexpected fault and answers 500", async () => {
    const lines: string[] = [];
    const { base } = await boot(async () => {}, {
      store: { kvGet: () => { throw new Error("db is gone"); }, kvSet: () => {} },
      log: (l) => lines.push(l),
    });
    const r = await fetch(`${base}/api/state`);
    expect(r.status).toBe(500);
    expect((await r.json()).error).toContain("db is gone");
    expect(lines.some((l) => l.includes("setup error /api/state") && l.includes("db is gone"))).toBe(true);
  });
});

const noop = async () => {};
const postJson = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });

describe("template gallery and provisioning", () => {
  it("lists the shipped templates", async () => {
    const { base } = await boot(noop);
    const r = await fetch(`${base}/api/onboarding/templates`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { templates: Array<{ name: string }> };
    expect(body.templates.map((t) => t.name)).toContain("starter");
  });

  it("selecting a template stores a proposal and advances to review", async () => {
    const { base, store } = await boot(noop, {}, "interview");
    const r = await postJson(base, "/api/onboarding/template", { name: "starter" });
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("review");
    expect(store.kvGet("onboarding.proposal")).toContain("starter");
  });

  it("refuses an unknown template", async () => {
    const { base } = await boot(noop, {}, "interview");
    const r = await postJson(base, "/api/onboarding/template", { name: "nope" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'unknown template "nope"' });
  });

  it("refuses template selection from the wrong step", async () => {
    const { base } = await boot(noop, {}, "welcome");
    const r = await postJson(base, "/api/onboarding/template", { name: "starter" });
    expect(r.status).toBe(400);
  });

  it("serves the stored proposal back for the review screen", async () => {
    const { base } = await boot(noop, {}, "interview");
    await postJson(base, "/api/onboarding/template", { name: "starter" });
    const r = await fetch(`${base}/api/onboarding/proposal`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { proposal: { agents: unknown[] } };
    expect(body.proposal.agents.length).toBeGreaterThan(0);
  });

  it("404s the proposal before one is chosen", async () => {
    const { base } = await boot(noop, {}, "interview");
    expect((await fetch(`${base}/api/onboarding/proposal`)).status).toBe(404);
  });

  it("provisions from review and lands on first-job", async () => {
    const calls: unknown[] = [];
    const { base } = await boot(noop, {
      provisionFn: (p) => {
        calls.push(p);
        return { ok: true as const, departments: ["operations"], agents: ["nova"], playbooks: [] };
      },
    }, "interview");
    await postJson(base, "/api/onboarding/template", { name: "starter" });
    const r = await postJson(base, "/api/onboarding/provision", {});
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("first-job");
    expect(calls).toHaveLength(1);
  });

  it("returns card errors and stays on review when provisioning is rejected", async () => {
    const { base, store } = await boot(noop, {
      provisionFn: () => ({
        ok: false as const,
        errors: [{ scope: "agent" as const, name: "nova", error: 'unknown capability "telepathy"' }],
      }),
    }, "interview");
    await postJson(base, "/api/onboarding/template", { name: "starter" });
    const r = await postJson(base, "/api/onboarding/provision", {});
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; errors: Array<{ name: string }> };
    expect(body.errors[0].name).toBe("nova");
    // `error` must be present too: ui2's shared request() reads only that key off a failure.
    expect(body.error).toContain("telepathy");
    expect(store.kvGet("onboarding.step")).toBe("review");
  });

  it("refuses to provision with no proposal stored", async () => {
    const { base } = await boot(noop, {}, "review");
    const r = await postJson(base, "/api/onboarding/provision", {});
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "no proposal to provision" });
  });

  it("a resumed wizard stuck on the provision step finishes without provisioning twice", async () => {
    let runs = 0;
    const { base } = await boot(noop, {
      provisionFn: () => { runs++; return { ok: true as const, departments: [], agents: [], playbooks: [] }; },
      orgExists: () => true, // a crash between the two advances left a real org on disk
    }, "provision");
    const r = await postJson(base, "/api/onboarding/provision", {});
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("first-job");
    expect(runs).toBe(0);
  });
});

describe("the interview", () => {
  const proposal = {
    departments: [{ department: "operations", mission: "Front door.", memoDomain: "general", lead: "nova", capabilities: [], playbooks: [] }],
    agents: [{
      name: "nova", department: "operations", kind: "coordinator", title: "Coordinator",
      charter: "Route.", persona: "Brief.", prompt: "You route.", capabilities: [], skills: [],
    }],
    firstJob: "Say hello.",
  };

  it("asks a question and keeps the wizard on the interview step", async () => {
    const { base, store } = await boot(noop, {
      architect: async () => ({ done: false, question: "What do you do?" }),
    }, "interview");
    const r = await postJson(base, "/api/onboarding/interview", { message: "I run a bakery" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ done: false, question: "What do you do?" });
    expect(store.kvGet("onboarding.step")).toBe("interview");
  });

  it("replays the whole transcript on the next turn", async () => {
    const prompts: string[] = [];
    const { base } = await boot(noop, {
      architect: async (_s, p) => { prompts.push(p); return { done: false, question: "and then?" }; },
    }, "interview");
    await postJson(base, "/api/onboarding/interview", { message: "first thing" });
    await postJson(base, "/api/onboarding/interview", { message: "second thing" });
    expect(prompts[1]).toContain("first thing");
    expect(prompts[1]).toContain("and then?");
    expect(prompts[1]).toContain("second thing");
  });

  it("stores the proposal and advances to review when the Architect is done", async () => {
    const { base, store } = await boot(noop, {
      architect: async () => ({ done: true, proposal }),
    }, "interview");
    const r = await postJson(base, "/api/onboarding/interview", { message: "that's everything" });
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("review");
    expect(store.kvGet("onboarding.proposal")).toContain("nova");
    expect(store.kvGet("onboarding.proposal")).toContain("interview");
  });

  it("serves the transcript back so a reload resumes mid-interview", async () => {
    const { base } = await boot(noop, {
      architect: async () => ({ done: false, question: "What do you do?" }),
    }, "interview");
    await postJson(base, "/api/onboarding/interview", { message: "I run a bakery" });
    const r = await fetch(`${base}/api/onboarding/interview`);
    const body = (await r.json()) as { turns: Array<{ role: string; text: string }> };
    expect(body.turns.map((t) => t.role)).toEqual(["user", "architect"]);
    expect(body.turns[0].text).toBe("I run a bakery");
  });

  it("surfaces an Architect failure as 400 without advancing", async () => {
    const { base, store } = await boot(noop, {
      architect: async () => { throw new Error("api_error_status 401"); },
    }, "interview");
    const r = await postJson(base, "/api/onboarding/interview", { message: "hi" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("401");
    expect(store.kvGet("onboarding.step")).toBe("interview");
  });

  it("rejects a proposal that fails the structural gate, and stays put", async () => {
    const twoCoordinators = { ...proposal, agents: [proposal.agents[0], { ...proposal.agents[0], name: "nova2" }] };
    const { base, store } = await boot(noop, {
      architect: async () => ({ done: true, proposal: twoCoordinators }),
    }, "interview");
    const r = await postJson(base, "/api/onboarding/interview", { message: "go" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("exactly one coordinator");
    expect(store.kvGet("onboarding.step")).toBe("interview");
    expect(store.kvGet("onboarding.proposal")).toBeUndefined();
  });

  it("refuses an empty message", async () => {
    const { base } = await boot(noop, { architect: async () => ({ done: false, question: "?" }) }, "interview");
    const r = await postJson(base, "/api/onboarding/interview", { message: "   " });
    expect(r.status).toBe(400);
  });

  it("refuses interview turns from the wrong step", async () => {
    const { base } = await boot(noop, { architect: async () => ({ done: false, question: "?" }) }, "welcome");
    expect((await postJson(base, "/api/onboarding/interview", { message: "hi" })).status).toBe(400);
  });

  it("restart clears the transcript", async () => {
    const { base, store } = await boot(noop, {
      architect: async () => ({ done: false, question: "q" }),
    }, "interview");
    await postJson(base, "/api/onboarding/interview", { message: "hi" });
    expect(store.kvGet("onboarding.transcript")).toContain("hi");
    const r = await postJson(base, "/api/onboarding/interview/restart", {});
    expect(r.status).toBe(200);
    expect(JSON.parse(store.kvGet("onboarding.transcript") ?? "[]")).toEqual([]);
  });
});
