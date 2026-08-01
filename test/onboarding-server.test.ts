// test/onboarding-server.test.ts — wizard HTTP walk: welcome → auth → workspace (spec §1-2).
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { startSetupServer, type SetupDeps } from "../src/onboarding/server.js";
import type { BootedWorld } from "../src/boot.js";

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
    // Strict shape on purpose: bootError is absent until a hot boot has actually failed.
    expect(await r.json()).toEqual({ mode: "setup", step: "welcome", booted: false });

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

describe("editing the proposal", () => {
  async function atReview(over = {}) {
    const b = await boot(noop, over, "interview");
    await postJson(b.base, "/api/onboarding/template", { name: "starter" });
    return b;
  }

  it("edits a prose field on one agent", async () => {
    const { base } = await atReview();
    const r = await fetch(`${base}/api/onboarding/proposal`, {
      method: "PATCH", body: JSON.stringify({ agent: "nova", field: "charter", value: "Rewritten charter." }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { proposal: { agents: Array<{ name: string; charter: string }> } };
    expect(body.proposal.agents.find((a) => a.name === "nova")!.charter).toBe("Rewritten charter.");
  });

  it("persists the edit for the next read", async () => {
    const { base } = await atReview();
    await fetch(`${base}/api/onboarding/proposal`, {
      method: "PATCH", body: JSON.stringify({ agent: "nova", field: "title", value: "Chief of Staff" }),
    });
    const r = await fetch(`${base}/api/onboarding/proposal`);
    const body = (await r.json()) as { proposal: { agents: Array<{ name: string; title: string }> } };
    expect(body.proposal.agents.find((a) => a.name === "nova")!.title).toBe("Chief of Staff");
  });

  it("replaces capability and skill chips", async () => {
    const { base } = await atReview();
    await fetch(`${base}/api/onboarding/proposal`, {
      method: "PATCH", body: JSON.stringify({ agent: "scout", capabilities: ["web"] }),
    });
    const r = await fetch(`${base}/api/onboarding/proposal`);
    const body = (await r.json()) as { proposal: { agents: Array<{ name: string; capabilities: string[] }> } };
    expect(body.proposal.agents.find((a) => a.name === "scout")!.capabilities).toEqual(["web"]);
  });

  it("edits firstJob", async () => {
    const { base } = await atReview();
    const r = await fetch(`${base}/api/onboarding/proposal`, {
      method: "PATCH", body: JSON.stringify({ firstJob: "Do the thing." }),
    });
    expect(((await r.json()) as { proposal: { firstJob: string } }).proposal.firstJob).toBe("Do the thing.");
  });

  it("refuses an unknown agent", async () => {
    const { base } = await atReview();
    const r = await fetch(`${base}/api/onboarding/proposal`, {
      method: "PATCH", body: JSON.stringify({ agent: "ghost", field: "title", value: "x" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("ghost");
  });

  it("refuses a field that is not editable", async () => {
    const { base } = await atReview();
    // Renaming an agent here would orphan the department lead and any playbook role naming it.
    const r = await fetch(`${base}/api/onboarding/proposal`, {
      method: "PATCH", body: JSON.stringify({ agent: "nova", field: "name", value: "hacked" }),
    });
    expect(r.status).toBe(400);
  });

  it("refuses an empty prose value", async () => {
    const { base } = await atReview();
    const r = await fetch(`${base}/api/onboarding/proposal`, {
      method: "PATCH", body: JSON.stringify({ agent: "nova", field: "charter", value: "  " }),
    });
    expect(r.status).toBe(400);
  });

  it("404s when there is no proposal to edit", async () => {
    const { base } = await boot(noop, {}, "interview");
    const r = await fetch(`${base}/api/onboarding/proposal`, {
      method: "PATCH", body: JSON.stringify({ firstJob: "x" }),
    });
    expect(r.status).toBe(404);
  });
});

describe("redraft endpoint", () => {
  it("replaces one agent in the stored proposal", async () => {
    const { base } = await boot(noop, {
      architect: async () => ({
        done: true,
        proposal: {
          departments: [{ department: "operations", mission: "m", memoDomain: "general", capabilities: [], playbooks: [] }],
          agents: [{
            name: "nova", department: "operations", kind: "coordinator", title: "Coordinator",
            charter: "c", persona: "Warm and unhurried.", prompt: "p", capabilities: [], skills: [],
          }],
          firstJob: "f",
        },
      }),
    }, "interview");
    await postJson(base, "/api/onboarding/template", { name: "starter" });
    const r = await postJson(base, "/api/onboarding/redraft", { agent: "nova", note: "warmer" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { proposal: { agents: Array<{ name: string; persona: string }> } };
    expect(body.proposal.agents.find((a) => a.name === "nova")!.persona).toBe("Warm and unhurried.");
    // The other agents are untouched.
    expect(body.proposal.agents).toHaveLength(3);
  });

  it("surfaces a redraft failure as 400 leaving the proposal alone", async () => {
    const { base } = await boot(noop, { architect: async () => { throw new Error("model unavailable"); } }, "interview");
    await postJson(base, "/api/onboarding/template", { name: "starter" });
    const r = await postJson(base, "/api/onboarding/redraft", { agent: "nova", note: "warmer" });
    expect(r.status).toBe(400);
    const after = await (await fetch(`${base}/api/onboarding/proposal`)).json() as { proposal: { agents: unknown[] } };
    expect(after.proposal.agents).toHaveLength(3);
  });
});

describe("regenerate", () => {
  const drafted = (persona: string) => ({
    done: true,
    proposal: {
      departments: [{ department: "operations", mission: "m", memoDomain: "general", capabilities: [], playbooks: [] }],
      agents: [{
        name: "nova", department: "operations", kind: "coordinator", title: "Coordinator",
        charter: "c", persona, prompt: "p", capabilities: [], skills: [],
      }],
      firstJob: "f",
    },
  });

  it("re-runs the last turn against the same answers and replaces the proposal", async () => {
    let call = 0;
    const { base } = await boot(noop, {
      architect: async () => drafted(++call === 1 ? "First draft." : "Second draft."),
    }, "interview");
    await postJson(base, "/api/onboarding/interview", { message: "that's everything" });
    const r = await postJson(base, "/api/onboarding/regenerate", {});
    expect(r.status).toBe(200);
    const body = (await r.json()) as { proposal: { agents: Array<{ persona: string }> } };
    expect(body.proposal.agents[0].persona).toBe("Second draft.");
  });

  it("keeps the user's answers — that is what separates it from restart", async () => {
    const prompts: string[] = [];
    const { base, store } = await boot(noop, {
      architect: async (_s, p) => { prompts.push(p); return drafted("x"); },
    }, "interview");
    await postJson(base, "/api/onboarding/interview", { message: "I run a bakery" });
    await postJson(base, "/api/onboarding/regenerate", {});
    expect(prompts[1]).toContain("I run a bakery");
    expect(store.kvGet("onboarding.transcript")).toContain("I run a bakery");
  });

  it("400s with no transcript to re-run", async () => {
    const { base } = await boot(noop, { architect: async () => drafted("x") }, "review");
    expect((await postJson(base, "/api/onboarding/regenerate", {})).status).toBe(400);
  });
});

describe("the capability catalog before provision", () => {
  // seedCapabilities plants agents/_capabilities.yaml at PROVISION, but the interview runs
  // before that. Reading only the user's agents dir therefore hands the Architect an empty
  // catalog on every fresh install, and it drafts agents with no capabilities at all — which is
  // to say, agents with no tools. Observed live during the plan-2b smoke.
  it("offers the product catalog to the Architect on a fresh install", async () => {
    let seenSystem = "";
    const { base } = await boot(noop, {
      architect: async (s) => { seenSystem = s; return { done: false, question: "?" }; },
    }, "interview");
    await postJson(base, "/api/onboarding/interview", { message: "hi" });
    // Slice the capability section out: the worked examples further down also mention "web",
    // so asserting on the whole prompt would pass even with an empty catalog.
    const section = seenSystem.slice(
      seenSystem.indexOf("CAPABILITIES YOU MAY USE"), seenSystem.indexOf("SKILLS YOU MAY ATTACH"));
    expect(section).toContain("web");
    expect(section).toContain("coordination");
  });

  it("serves the same catalog to the review screen's chips", async () => {
    const { base } = await boot(noop, {}, "interview");
    const r = await fetch(`${base}/api/onboarding/catalog`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { capabilities: string[]; skills: string[] };
    expect(body.capabilities).toContain("web");
    expect(body.capabilities.length).toBeGreaterThan(5);
  });
});

/** Minimum shape the setup server actually touches. Cast once, here, so the tests below
 *  read as real usage rather than as a pile of `as any`. */
const FAKE_VAULT_ROOT = "/tmp/fake-vault/AIOS";

function fakeWorld(over: Partial<BootedWorld> = {}): BootedWorld {
  return {
    moderator: { handle: async () => ({ text: "done", attachments: [] }) },
    store: { listGoals: () => [], listNodes: () => [] },
    // Only `root` is used off it, but it is present because the real BootedWorld always has a
    // VaultWriter — the done screen reads the folder the daemon is genuinely writing into, and
    // a double that omitted it would make that read look optional when the type says it is not.
    vault: { root: FAKE_VAULT_ROOT },
    startWeb: () => {},
    ...over,
  } as unknown as BootedWorld;
}

describe("hot boot", () => {
  /** Land on review with a proposal actually stored. Starting the wizard on "review" with an
   *  empty store makes provision 400 with "no proposal to provision" — which would make every
   *  assertion below about a boot that never happened. */
  async function reviewWithProposal(over: Partial<SetupDeps>) {
    // orgExists defaults true because provisionFn is faked here and writes no agents to disk;
    // after a real provision the org is there, which is what the retry endpoint's guard reads.
    const b = await boot(noop, { orgExists: () => true, ...over }, "interview");
    await postJson(b.base, "/api/onboarding/template", { name: "starter" });
    return b;
  }

  it("boots after a successful provision and reports booted", async () => {
    let booted = 0;
    const { base } = await reviewWithProposal({
      provisionFn: () => ({ ok: true, departments: ["ops"], agents: ["nova"], playbooks: [] }),
      boot: async () => { booted++; return fakeWorld(); },
    });

    const r = await fetch(`${base}/api/onboarding/provision`, { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("first-job");
    expect(booted).toBe(1);

    const s = await (await fetch(`${base}/api/state`)).json();
    expect(s).toMatchObject({ mode: "setup", step: "first-job", booted: true });
  });

  it("keeps the provisioned org when boot throws, and reports the error", async () => {
    const { base } = await reviewWithProposal({
      provisionFn: () => ({ ok: true, departments: ["ops"], agents: ["nova"], playbooks: [] }),
      boot: async () => { throw new Error("registry exploded"); },
    });

    const r = await fetch(`${base}/api/onboarding/provision`, { method: "POST", body: "{}" });
    // The org IS created — boot failing is a separate fault and must not roll it back.
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("first-job");

    const s = await (await fetch(`${base}/api/state`)).json();
    expect(s.booted).toBe(false);
    expect(s.bootError).toContain("registry exploded");
  });

  it("retries a failed boot through /api/onboarding/boot", async () => {
    let attempts = 0;
    const { base } = await reviewWithProposal({
      provisionFn: () => ({ ok: true, departments: ["ops"], agents: ["nova"], playbooks: [] }),
      boot: async () => {
        attempts++;
        if (attempts === 1) throw new Error("first attempt fails");
        return fakeWorld();
      },
    });

    await fetch(`${base}/api/onboarding/provision`, { method: "POST", body: "{}" });
    const r = await fetch(`${base}/api/onboarding/boot`, { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    expect((await r.json()).booted).toBe(true);
    expect(attempts).toBe(2);

    // The first attempt's error must be cleared on success, or the UI renders booted: true
    // next to a stale "first attempt fails".
    const s = await (await fetch(`${base}/api/state`)).json();
    expect(s.booted).toBe(true);
    expect(s.bootError).toBeUndefined();
  });

  it("never boots twice when provision and retry race", async () => {
    let attempts = 0;
    const { base } = await reviewWithProposal({
      provisionFn: () => ({ ok: true, departments: ["ops"], agents: ["nova"], playbooks: [] }),
      boot: async () => {
        attempts++;
        await new Promise((r) => setTimeout(r, 20));
        return fakeWorld();
      },
    });

    const [prov, retry] = await Promise.all([
      fetch(`${base}/api/onboarding/provision`, { method: "POST", body: "{}" }),
      fetch(`${base}/api/onboarding/boot`, { method: "POST", body: "{}" }),
    ]);
    // Both requests must have gone down the boot path — otherwise "exactly one world" is
    // a claim about a race that never happened.
    expect(prov.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(attempts).toBe(1);
  });

  // The crash-resume branch is a second, separate call site for ensureBooted: it answers through
  // transition() rather than json(), and the existing resume test injects no `boot` at all, so
  // deleting the await there used to leave the suite green.
  it("boots on a crash-resume that finds the org already written", async () => {
    let booted = 0;
    const { base } = await boot(noop, {
      orgExists: () => true, // a crash between the two advances left a real org on disk
      boot: async () => { booted++; return fakeWorld(); },
    }, "provision");

    const r = await postJson(base, "/api/onboarding/provision", {});
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("first-job");
    expect(booted).toBe(1);
    expect((await (await fetch(`${base}/api/state`)).json()).booted).toBe(true);
  });

  it("still finishes a crash-resume when the boot fails", async () => {
    const { base } = await boot(noop, {
      orgExists: () => true,
      boot: async () => { throw new Error("resume boot exploded"); },
    }, "provision");

    const r = await postJson(base, "/api/onboarding/provision", {});
    // Same rule as the provision path: the org is on disk and valid, so a boot failure is
    // recorded, never a reason to strand the wizard on the provision step.
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("first-job");
    const s = await (await fetch(`${base}/api/state`)).json();
    expect(s.booted).toBe(false);
    expect(s.bootError).toContain("resume boot exploded");
  });

  it("refuses to boot before an org exists", async () => {
    let attempts = 0;
    const { base } = await boot(noop, {
      orgExists: () => false,
      boot: async () => { attempts++; return fakeWorld(); },
    }, "review");

    const r = await fetch(`${base}/api/onboarding/boot`, { method: "POST", body: "{}" });
    expect(r.status).toBe(409);
    // The status is not the point. bootNormal succeeds against an empty registry — loadRegistry
    // only throws when there are agents but no coordinator — so reaching it at all would latch
    // `world` to a zero-agent daemon that the provision-time boot then short-circuits on.
    expect(attempts).toBe(0);
    expect((await (await fetch(`${base}/api/state`)).json()).booted).toBe(false);
  });
});

/** The last response the wizard ever sends, and the only copy of any of it the browser gets. */
type Handover = {
  step: string; uiToken: string; departments: string[]; agents: string[]; workspace: string;
};

describe("done handover", () => {
  // AIOS_UI_TOKEN is a process global that bootNormal writes, so these tests set it directly.
  // Saved and restored in hooks rather than deleted at the end of a body: a failing assertion
  // skips the rest of the body, and a token left standing would leak into whatever runs next.
  let priorToken: string | undefined;
  beforeEach(() => { priorToken = process.env.AIOS_UI_TOKEN; });
  afterEach(() => {
    if (priorToken === undefined) delete process.env.AIOS_UI_TOKEN;
    else process.env.AIOS_UI_TOKEN = priorToken;
  });

  /**
   * Land on first-job the way a user does: a real proposal stored, then provisioned. Starting the
   * wizard on "review" with an empty store 400s on "no proposal to provision" and leaves it there,
   * which would make every assertion below about a handover that never ran.
   */
  async function atFirstJob(over: Partial<SetupDeps> = {}) {
    const b = await boot(noop, {
      orgExists: () => true,
      provisionFn: () => ({ ok: true, departments: ["operations"], agents: ["nova"], playbooks: [] }),
      boot: async () => fakeWorld(),
      ...over,
    }, "interview");
    await postJson(b.base, "/api/onboarding/template", { name: "starter" });
    const r = await postJson(b.base, "/api/onboarding/provision", {});
    // The handover only exists from first-job; assert we got there rather than assume it.
    expect((await r.json()).step).toBe("first-job");
    return b;
  }

  const waitFor = async (ok: () => boolean, what: string, ms = 3000) => {
    const until = Date.now() + ms;
    while (!ok() && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    if (!ok()) throw new Error(`timed out waiting for ${what}`);
  };

  it("answers with the UI token and the whole org summary, starting mission control exactly once", async () => {
    let started = 0;
    process.env.AIOS_UI_TOKEN = "tok-ui-abc";
    const { base } = await atFirstJob({
      boot: async () => fakeWorld({ startWeb: () => { started++; } }),
    });

    const r = await postJson(base, "/api/onboarding/advance", { from: "first-job" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Handover;
    expect(body.step).toBe("done");
    // The only moment the browser is ever handed this: afterwards every /api/ route is gated.
    expect(body.uiToken).toBe("tok-ui-abc");
    // And everything the done screen confirms, for the same reason — it names the departments,
    // the agents and the folder their work lands in, and by the time it could ask for any of it
    // this server is gone.
    expect(body.agents).toEqual(["nova", "scout", "scribe"]);
    expect(body.departments).toEqual(["operations", "studio"]);
    // Read off the booted daemon's own VaultWriter, which is the object actually doing the
    // writing — not re-derived from env, which is a second copy that can disagree with it.
    expect(body.workspace).toBe(FAKE_VAULT_ROOT);

    await waitFor(() => started > 0, "mission control to be started");
    expect(started).toBe(1);
    // `close` fires after `finish` on a healthy response too, so without the once-flag this whole
    // teardown runs twice — a second mission control racing for the same port.
    await new Promise((r2) => setTimeout(r2, 60));
    expect(started).toBe(1);
  });

  // The other half of the workspace answer: "Skip for now" past a failed boot reaches the
  // handover with no world at all, and the screen still has to name a folder. Env is what the
  // workspace step wrote and what a later boot would read, so it is the right fallback — and
  // resolving it to one string here rather than in the browser is the point of the field.
  it("names the workspace from env when no daemon ever booted", async () => {
    process.env.AIOS_UI_TOKEN = "tok-ui-noboot";
    const saved = { p: process.env.AIOS_VAULT_PATH, s: process.env.AIOS_VAULT_SUBDIR };
    process.env.AIOS_VAULT_PATH = "/tmp/chosen-vault";
    process.env.AIOS_VAULT_SUBDIR = "Brain";
    try {
      const { base } = await atFirstJob({ boot: async () => { throw new Error("boot exploded"); } });
      const r = await postJson(base, "/api/onboarding/advance", { from: "first-job" });
      const body = (await r.json()) as Handover;
      expect(body.workspace).toBe(join("/tmp/chosen-vault", "Brain"));
      // The rest of the summary is unaffected by the failed boot — it comes off the proposal.
      expect(body.departments).toEqual(["operations", "studio"]);
    } finally {
      for (const [k, v] of [["AIOS_VAULT_PATH", saved.p], ["AIOS_VAULT_SUBDIR", saved.s]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  /**
   * A client that walks away mid-response must still hand the port over. Read the comment before
   * trusting this one: on node 23 it passes through `finish`, which fires even for a response
   * whose socket has already been destroyed — so it does NOT exercise the `close` listener or the
   * `res.destroyed` check that were added for I-2, and it passes with both of them deleted. It is
   * here as the invariant those two insure, not as their coverage. The genuinely dangerous
   * window — the client vanishing while this handler awaits the request body, where `close` is
   * emitted before the listeners exist and `finish` never fires — is one microtask wide and
   * cannot be scheduled from a black-box HTTP test; it was verified by direct probe instead.
   */
  it("hands the port over when the client dies mid-response", async () => {
    let started = 0;
    process.env.AIOS_UI_TOKEN = "tok-ui-aborted";
    const { base, store } = await atFirstJob({
      boot: async () => fakeWorld({ startWeb: () => { started++; } }),
    });
    // The same ~4 MB roster as the flush test, so the response is provably still being written
    // when the client vanishes rather than long since gone.
    const names = Array.from({ length: 40_000 }, (_, i) => `agent-${i}-${"x".repeat(90)}`);
    store.kvSet("onboarding.proposal", JSON.stringify({ agents: names.map((name) => ({ name })) }));

    // Raw socket, not fetch + AbortController: abort tears down before the request is even sent,
    // so the server never reaches the handover and there is nothing to have gone wrong.
    const sock = connect(Number(new URL(base).port), "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    const body = JSON.stringify({ from: "first-job" });
    sock.write(
      "POST /api/onboarding/advance HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    // The first byte means the wizard has already advanced and the token has already been
    // written, and only then does the client vanish.
    await new Promise((r) => sock.once("data", r));
    sock.destroy();

    await waitFor(() => started > 0, "mission control to be started after a dead client");
    expect(started).toBe(1);
  });

  it("hands the port over only once the setup server has genuinely let go of it", async () => {
    process.env.AIOS_UI_TOKEN = "tok-ui-late";
    let port = 0;
    let listeningAtHandover: boolean | null = null;
    let rebind: Promise<string> | null = null;
    const { base } = await atFirstJob({
      boot: async () => fakeWorld({
        startWeb: () => {
          listeningAtHandover = server.listening;
          // The invariant itself, not a proxy for it: mission control binds this exact port, so
          // a handover scheduled one tick too early shows up here as EADDRINUSE.
          rebind = new Promise<string>((resolve) => {
            const probe = createServer();
            probe.once("error", (e) => resolve((e as NodeJS.ErrnoException).code ?? "error"));
            probe.listen(port, "127.0.0.1", () => probe.close(() => resolve("bound")));
          });
        },
      }),
    });
    port = Number(new URL(base).port);

    await postJson(base, "/api/onboarding/advance", { from: "first-job" });
    await waitFor(() => rebind !== null, "the port handover");
    expect(listeningAtHandover).toBe(false);
    expect(await rebind!).toBe("bound");
  });

  it("hands the port over even while the browser holds a second connection open", async () => {
    let started = 0;
    process.env.AIOS_UI_TOKEN = "tok-ui-held";
    const { base } = await atFirstJob({
      boot: async () => fakeWorld({ startWeb: () => { started++; } }),
    });

    // A browser keeps more than one socket to an origin — a preconnect, a second tab, the poll
    // this screen was running. close() waits for every one of them, so without a deliberate
    // teardown the handover does not merely lag: it never happens, and mission control never
    // comes up. This socket sends nothing, which is exactly what makes it a trap.
    const held = connect(Number(new URL(base).port), "127.0.0.1");
    await new Promise((r) => held.once("connect", r));
    try {
      await postJson(base, "/api/onboarding/advance", { from: "first-job" });
      await waitFor(() => started > 0, "mission control to be started");
    } finally {
      held.destroy();
    }
  });

  it("hands the port over to a daemon that finishes booting after the handover", async () => {
    let started = 0;
    let attempts = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    process.env.AIOS_UI_TOKEN = "tok-ui-slow";
    const { base } = await atFirstJob({
      boot: async () => {
        attempts++;
        if (attempts === 1) throw new Error("first attempt fails");
        await held; // still booting when the user gives up waiting on it
        return fakeWorld({ startWeb: () => { started++; } });
      },
    });

    try {
      // The retry the failed-boot screen offers, deliberately not awaited...
      const retry = postJson(base, "/api/onboarding/boot", {}).catch(() => null);
      await waitFor(() => attempts === 2, "the retry boot to start");

      // ...and "skip for now" — never disabled, so this is a click the user can really make —
      // while that boot is still in flight. Reading the `world` latch alone sees null here.
      const r = await postJson(base, "/api/onboarding/advance", { from: "first-job" });
      expect((await r.json()).step).toBe("done");
      expect(started).toBe(0); // nothing to hand the port to yet, so nothing has been handed

      // The daemon lands seconds later, perfectly healthy. Dropping the promise it came from is
      // what would leave it bound to nothing and the user needing a restart.
      release();
      await retry;
      await waitFor(() => started > 0, "mission control to be started after the late boot");
      expect(started).toBe(1);
    } finally {
      release();
    }
  });

  it("flushes the whole response before tearing the connection down", async () => {
    let started = 0;
    process.env.AIOS_UI_TOKEN = "tok-ui-big";
    const { base, store } = await atFirstJob({
      boot: async () => fakeWorld({ startWeb: () => { started++; } }),
    });
    // ~4 MB, and the size is the whole point. The teardown destroys this very connection, so a
    // body that has not drained by then arrives truncated — Content-Length turns that into a
    // socket error rather than a quietly short list. Small payloads cannot show this: measured on
    // this machine, res.end() gets anything up to ~300 KB into the kernel in one go and it
    // survives even a teardown that never waited for the flush, while 1 MB already fails. The
    // margin is for a machine whose socket buffers are larger than this one's.
    const names = Array.from({ length: 40_000 }, (_, i) => `agent-${i}-${"x".repeat(90)}`);
    store.kvSet("onboarding.proposal", JSON.stringify({ agents: names.map((name) => ({ name })) }));

    const r = await postJson(base, "/api/onboarding/advance", { from: "first-job" });
    const body = (await r.json()) as Handover;
    expect(body.step).toBe("done");
    expect(body.uiToken).toBe("tok-ui-big");
    expect(body.agents).toHaveLength(names.length);
    expect(body.agents[names.length - 1]).toBe(names[names.length - 1]);
    await waitFor(() => started > 0, "mission control to be started");
  });

  it("keeps the setup server up when there is no daemon to take the port", async () => {
    process.env.AIOS_UI_TOKEN = "tok-ui-orphan";
    // The way out of a failed hot boot: "skip for now" advances from first-job with world null.
    // Closing anyway would leave nothing listening at all — a dead port and no wizard either.
    const { base } = await atFirstJob({ boot: async () => { throw new Error("boot exploded"); } });

    const r = await postJson(base, "/api/onboarding/advance", { from: "first-job" });
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("done");

    await new Promise((r2) => setTimeout(r2, 60));
    expect(server.listening).toBe(true);
    expect((await (await fetch(`${base}/api/state`)).json()).step).toBe("done");
  });

  it("still hands over when the stored proposal cannot be read", async () => {
    let started = 0;
    process.env.AIOS_UI_TOKEN = "tok-ui-corrupt";
    const { base, store } = await atFirstJob({
      boot: async () => fakeWorld({ startWeb: () => { started++; } }),
    });
    store.kvSet("onboarding.proposal", "{not json");

    const r = await postJson(base, "/api/onboarding/advance", { from: "first-job" });
    const body = (await r.json()) as Handover;
    // An org we cannot name is a nameless done screen, never a lost handover. The workspace
    // still lands: it comes off the booted daemon, not off the proposal that will not parse.
    expect(body).toEqual({
      step: "done", uiToken: "tok-ui-corrupt", departments: [], agents: [], workspace: FAKE_VAULT_ROOT,
    });
    await waitFor(() => started > 0, "mission control to be started");
  });

  it("hands out no token and keeps the port on every other advance", async () => {
    process.env.AIOS_UI_TOKEN = "tok-ui-nope";
    const { base } = await boot(noop, {}, "welcome");

    const r = await postJson(base, "/api/onboarding/advance", { from: "welcome" });
    expect(await r.json()).toEqual({ step: "auth" });
    // The wizard has six more steps to serve — a handover here would end it on step two.
    await new Promise((r2) => setTimeout(r2, 60));
    expect(server.listening).toBe(true);
    expect((await (await fetch(`${base}/api/state`)).json()).step).toBe("auth");
  });

  it("refuses a stale advance from first-job without handing anything over", async () => {
    let started = 0;
    process.env.AIOS_UI_TOKEN = "tok-ui-stale";
    const { base } = await boot(noop, {
      orgExists: () => true,
      boot: async () => fakeWorld({ startWeb: () => { started++; } }),
    }, "review");

    const r = await postJson(base, "/api/onboarding/advance", { from: "first-job" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("stale advance");
    await new Promise((r2) => setTimeout(r2, 60));
    expect(started).toBe(0);
    expect(server.listening).toBe(true);
  });
});
