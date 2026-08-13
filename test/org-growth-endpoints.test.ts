// test/org-growth-endpoints.test.ts — the two growth routes, over real HTTP.
//
// growthTurn, draftDepartment and provision(grow) are covered directly elsewhere. What only a
// request can reach is the wiring between them: that the routes hand the architect the LIVE
// roster (a stale one is how the model proposes a name that is taken), that a rejected proposal
// answers 400 instead of 500, that nothing is written until apply, and that apply reloads the
// registry so the running daemon sees the new agents without a restart.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer, type WebDeps } from "../src/web/server.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import type { Architect } from "../src/onboarding/architect.js";

const TOKEN = "grow-token";
let root: string, agentsDir: string, playbooksDir: string, templatesDir: string;
let server: Server, port: number, reloads: number, prevToken: string | undefined;

/** A real two-department org on disk, so the routes resolve a real registry. */
function writeOrg(): void {
  for (const [dept, lead, kind] of [["ops", "nova", "coordinator"], ["research", "delve", "lead"]] as const) {
    mkdirSync(join(agentsDir, dept), { recursive: true });
    writeFileSync(join(agentsDir, dept, "department.yaml"),
      `department: ${dept}\nmission: Do ${dept}.\nlead: ${lead}\nmemoDomain: general\ncapabilities: []\nplaybooks: []\n`);
    writeFileSync(join(agentsDir, dept, `${lead}.yaml`),
      `name: ${lead}\ntitle: T\ndepartment: ${dept}\ncharter: c.\npersona: p.\nprompt: x.\nkind: ${kind}\ncapabilities: []\n`);
  }
  cpSync(join(process.cwd(), "templates", "_capabilities.yaml"), join(agentsDir, "_capabilities.yaml"));
}

function boot(architect: Architect): void {
  const registry = loadRegistry(agentsDir, playbooksDir);
  const deps = {
    store: {}, goals: {}, vault: {}, bus: {}, router: {}, gate: {}, mailbox: {},
    voice: { available: () => false },
    registry,
    config: { dbPath: ":memory:", agentsDir, playbooksDir, templatesDir },
    architect,
    reloadPacks: () => { reloads++; },
    envPath: "", uiDist: "", log: () => {},
  } as unknown as WebDeps;
  server = startWebServer(deps, 0);
}

const post = (path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Replies in order, so one architect can drive a whole conversation. */
const replies = (...out: unknown[]): Architect => {
  let i = 0;
  return async () => out[Math.min(i++, out.length - 1)];
};

const AGENT = {
  name: "midas", department: "finance", kind: "lead", title: "Finance Lead",
  charter: "Owns the books.", persona: "p", prompt: "x", capabilities: [], skills: [],
};
const DEPT = {
  department: "finance", mission: "Own the numbers.", memoDomain: "money",
  capabilities: [], playbooks: [],
};
const DONE = { done: true, proposal: { departments: [DEPT], agents: [AGENT], firstJob: "" } };

beforeEach(() => {
  prevToken = process.env.AIOS_UI_TOKEN;
  process.env.AIOS_UI_TOKEN = TOKEN;
  root = mkdtempSync(join(tmpdir(), "grow-ep-"));
  agentsDir = join(root, "agents");
  playbooksDir = join(root, "playbooks");
  templatesDir = join(root, "templates");
  mkdirSync(playbooksDir, { recursive: true });
  mkdirSync(templatesDir, { recursive: true });
  writeOrg();
  reloads = 0;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (prevToken === undefined) delete process.env.AIOS_UI_TOKEN;
  else process.env.AIOS_UI_TOKEN = prevToken;
});

async function listen(architect: Architect): Promise<void> {
  boot(architect);
  if (!server.listening) await once(server, "listening");
  port = (server.address() as AddressInfo).port;
}

describe("POST /api/org/grow", () => {
  it("is token-gated like every other mutation", async () => {
    await listen(replies(DONE));
    const res = await fetch(`http://127.0.0.1:${port}/api/org/grow`, {
      method: "POST", body: JSON.stringify({ turns: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("passes a question through, then the finished proposal", async () => {
    await listen(replies({ done: false, question: "What is going unserved?" }, DONE));
    const asked = await (await post("/api/org/grow", { turns: [] })).json();
    expect(asked).toEqual({ done: false, question: "What is going unserved?" });

    const done = await (await post("/api/org/grow", {
      turns: [{ role: "user", text: "nobody tracks spend" }],
    })).json() as { done: boolean; proposal: { agents: Array<{ name: string }> } };
    expect(done.done).toBe(true);
    expect(done.proposal.agents.map((a) => a.name)).toEqual(["midas"]);
    // Still only a proposal — the org on disk is untouched.
    expect(existsSync(join(agentsDir, "finance"))).toBe(false);
  });

  it("hands the architect the live roster, which is what stops a name collision", async () => {
    let seenSystemAndContext = "";
    await listen(async (system) => { seenSystemAndContext = system; return DONE; });
    await post("/api/org/grow", { turns: [] });
    for (const needle of ["nova", "delve", "ops", "research"]) {
      expect(seenSystemAndContext).toContain(needle);
    }
  });

  it("answers 400 with the broken rule when the model returns something unusable", async () => {
    // A second coordinator is the one that would make the registry unloadable.
    await listen(replies({
      done: true,
      proposal: { departments: [DEPT], agents: [{ ...AGENT, kind: "coordinator" }], firstJob: "" },
    }));
    const res = await post("/api/org/grow", { turns: [] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/already has one/);
  });
});

describe("POST /api/org/draft-department", () => {
  it("refuses an empty description without calling the architect", async () => {
    let calls = 0;
    await listen(async () => { calls++; return DONE; });
    const res = await post("/api/org/draft-department", { description: "   " });
    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });

  it("returns one department and its staff", async () => {
    await listen(replies(DONE));
    const body = await (await post("/api/org/draft-department", { description: "invoices" }))
      .json() as { proposal: { departments: Array<{ department: string }>; agents: Array<{ name: string }> } };
    expect(body.proposal.departments.map((d) => d.department)).toEqual(["finance"]);
    expect(body.proposal.agents.map((a) => a.name)).toEqual(["midas"]);
  });

  it("400s rather than 500s when the architect asks a question it cannot be asked", async () => {
    await listen(replies({ done: false, question: "which one?" }));
    const res = await post("/api/org/draft-department", { description: "something" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/did not draft a department/);
  });
});

describe("POST /api/org/grow/apply", () => {
  it("writes the org and reloads it, so a running daemon sees it without a restart", async () => {
    await listen(replies(DONE));
    const res = await post("/api/org/grow/apply", { proposal: DONE.proposal });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, departments: ["finance"], agents: ["midas"] });
    expect(existsSync(join(agentsDir, "finance", "midas.yaml"))).toBe(true);
    expect(reloads).toBe(1);
    // And the result actually loads — the check provision itself makes before returning ok.
    const reg = loadRegistry(agentsDir, playbooksDir);
    expect(reg.agents.get("midas")?.department).toBe("finance");
    expect(reg.coordinator).toBe("nova");
  });

  it("requires a proposal", async () => {
    await listen(replies(DONE));
    expect((await post("/api/org/grow/apply", {})).status).toBe(400);
  });

  it("reports the refusal and leaves the disk alone", async () => {
    await listen(replies(DONE));
    const res = await post("/api/org/grow/apply", {
      proposal: { departments: [], agents: [{ ...AGENT, name: "delve", department: "research" }], firstJob: "" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: Array<{ error: string }> }).errors[0]!.error)
      .toMatch(/agent "delve" already exists/);
    expect(reloads).toBe(0);
  });

  it("ignores a template source, which would drag that template's playbooks in", async () => {
    await listen(replies(DONE));
    const res = await post("/api/org/grow/apply", {
      proposal: { ...DONE.proposal, source: { kind: "template", template: "studio" } },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ playbooks: [] });
  });
});
