// test/org-growth.test.ts — extending an org that already runs.
//
// Every rule here is a first-run rule turned around, so the risk is not that growth is rejected —
// it is that growth is ACCEPTED and writes something the loader then cannot read, which lands
// after the files are on disk and takes the daemon down with it.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { growthShape } from "../src/onboarding/proposal.js";
import { provision } from "../src/onboarding/provision.js";
import { growthTurn, renderExistingOrg } from "../src/onboarding/architect.js";
import { loadRegistry } from "../src/agents/registry/loader.js";

const EXISTING = { departments: new Set(["ops", "research"]), agents: new Set(["nova", "delve"]) };

const agent = (over: Record<string, unknown> = {}) => ({
  name: "quill", department: "research", kind: "worker", title: "T",
  charter: "c", persona: "p", prompt: "x", capabilities: [], skills: [], ...over,
});

/** A real, minimal org on disk: one coordinator in ops, one worker in research. */
function org(): { agentsDir: string; playbooksDir: string; templatesDir: string } {
  const root = mkdtempSync(join(tmpdir(), "grow-"));
  const agentsDir = join(root, "agents");
  for (const [dept, lead] of [["ops", "nova"], ["research", "delve"]] as const) {
    mkdirSync(join(agentsDir, dept), { recursive: true });
    writeFileSync(join(agentsDir, dept, "department.yaml"),
      `department: ${dept}\nmission: Do ${dept}.\nlead: ${lead}\nmemoDomain: general\ncapabilities: []\nplaybooks: []\n`);
    writeFileSync(join(agentsDir, dept, `${lead}.yaml`),
      `name: ${lead}\ntitle: T\ndepartment: ${dept}\ncharter: c.\npersona: p.\nprompt: x.\n${lead === "nova" ? "kind: coordinator\n" : "kind: lead\n"}capabilities: []\n`);
  }
  writeFileSync(join(agentsDir, "_capabilities.yaml"), "reading: { tools: [Read] }\n");
  const playbooksDir = join(root, "playbooks");
  mkdirSync(playbooksDir, { recursive: true });
  // Deliberately EMPTY. Growth must not need product template data to add one agent — an org
  // carries its own capability catalog, and reaching for the templates dir turned a missing
  // product file into "capability catalog missing" on a perfectly healthy install.
  const templatesDir = join(root, "templates");
  mkdirSync(templatesDir, { recursive: true });
  return { agentsDir, playbooksDir, templatesDir };
}

const grow = (dirs: ReturnType<typeof org>, proposal: Record<string, unknown>) =>
  provision(
    { source: { kind: "interview" }, firstJob: "", departments: [], agents: [], ...proposal } as never,
    { ...dirs, loadRegistry },
    { mode: "grow" },
  );

describe("growthShape", () => {
  it("refuses a second coordinator, which would make the whole registry unloadable", () => {
    const r = growthShape({ departments: [], agents: [agent({ kind: "coordinator" })] }, EXISTING);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/already has one/);
  });

  it("accepts a new agent in a department that already exists, with no new departments", () => {
    // The common case, and the one proposalShape cannot express: it requires at least one
    // department and that every agent name one the PROPOSAL creates.
    const r = growthShape({ departments: [], agents: [agent()] }, EXISTING);
    expect(r.ok).toBe(true);
  });

  it("refuses names the org already uses", () => {
    const dupAgent = growthShape({ departments: [], agents: [agent({ name: "delve" })] }, EXISTING);
    expect(!dupAgent.ok && dupAgent.error).toMatch(/agent "delve" already exists/);
    const dupDept = growthShape({
      departments: [{ department: "ops", mission: "m", memoDomain: "general", capabilities: [], playbooks: [] }],
      agents: [agent()],
    }, EXISTING);
    expect(!dupDept.ok && dupDept.error).toMatch(/department "ops" already exists/);
  });

  it("refuses an agent pointing at a department nobody is creating", () => {
    const r = growthShape({ departments: [], agents: [agent({ department: "legal" })] }, EXISTING);
    expect(!r.ok && r.error).toMatch(/does not exist and is not being created/);
  });

  it("refuses a proposal that adds nothing", () => {
    const r = growthShape({ departments: [], agents: [] }, EXISTING);
    expect(!r.ok && r.error).toMatch(/nothing to add/);
  });
});

describe("provision in grow mode", () => {
  it("adds an agent to an existing department and leaves everything else alone", () => {
    const dirs = org();
    const before = readFileSync(join(dirs.agentsDir, "research", "delve.yaml"), "utf8");
    const r = grow(dirs, { agents: [agent()] });
    expect(r.ok).toBe(true);
    expect(r.ok && r.agents).toEqual(["quill"]);
    expect(existsSync(join(dirs.agentsDir, "research", "quill.yaml"))).toBe(true);
    // The agent that was already there is untouched, byte for byte.
    expect(readFileSync(join(dirs.agentsDir, "research", "delve.yaml"), "utf8")).toBe(before);
    const reg = loadRegistry(dirs.agentsDir, dirs.playbooksDir);
    expect([...reg.agents.keys()].sort()).toEqual(["delve", "nova", "quill"]);
    expect(reg.coordinator).toBe("nova"); // still exactly one, and still the same one
  });

  it("creates a new department and staffs it in the same pass", () => {
    const dirs = org();
    const r = grow(dirs, {
      departments: [{ department: "finance", mission: "Own the numbers.", memoDomain: "money", capabilities: [], playbooks: [] }],
      agents: [agent({ name: "midas", department: "finance", kind: "lead" })],
    });
    expect(r.ok).toBe(true);
    const reg = loadRegistry(dirs.agentsDir, dirs.playbooksDir);
    expect([...reg.departments.keys()].sort()).toEqual(["finance", "ops", "research"]);
    expect(reg.agents.get("midas")?.department).toBe("finance");
  });

  it("writes nothing at all when the proposal is refused", () => {
    const dirs = org();
    const listing = () => readdirSync(join(dirs.agentsDir, "research")).sort();
    const before = listing();
    const r = grow(dirs, { agents: [agent({ kind: "coordinator" })] });
    expect(r.ok).toBe(false);
    expect(listing()).toEqual(before);
  });

  it("refuses to overwrite an existing agent even when the shape gate is bypassed", () => {
    // Belt and braces: growthShape catches this, and so does the per-agent validator, because a
    // silent overwrite here would destroy an agent the user wrote by hand.
    const dirs = org();
    const before = readFileSync(join(dirs.agentsDir, "research", "delve.yaml"), "utf8");
    const r = grow(dirs, { agents: [agent({ name: "delve", title: "IMPOSTER" })] });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(dirs.agentsDir, "research", "delve.yaml"), "utf8")).toBe(before);
  });
});

describe("renderExistingOrg", () => {
  it("names every department and every taken name, because that is what stops a collision", () => {
    // This block is the only thing telling the model what it may not reuse. If a name is missing
    // from it the model proposes that name, the validators reject the whole proposal, and the
    // user watches a finished conversation fail for no reason they can see.
    const out = renderExistingOrg(
      [{ department: "ops", mission: "Coordinate." }, { department: "research", mission: "Investigate." }],
      [
        { name: "nova", kind: "coordinator", department: "ops", title: "Coordinator" },
        { name: "delve", kind: "lead", department: "research", title: "Analyst" },
      ],
    );
    for (const needle of ["ops", "research", "nova", "delve", "Coordinate.", "Analyst"]) {
      expect(out).toContain(needle);
    }
    expect(out).toMatch(/add to it/i);
  });

  it("says so plainly when there is nothing yet, rather than rendering a blank list", () => {
    const out = renderExistingOrg([], []);
    expect(out).toContain("(none)");
  });
});

describe("growthTurn", () => {
  const ask = (out: unknown) => async () => out;

  it("passes a question straight through", async () => {
    const r = await growthTurn([], "ctx", ask({ done: false, question: "What is going unserved?" }), EXISTING);
    expect(r).toEqual({ done: false, question: "What is going unserved?" });
  });

  it("strips the playbooks the model invents, which provision would reject", async () => {
    const r = await growthTurn([], "ctx", ask({
      done: true,
      proposal: {
        departments: [{
          department: "finance", mission: "m", memoDomain: "money", capabilities: [],
          playbooks: ["monthly-close"], // never exists; kills the whole proposal at provision
        }],
        agents: [agent({ name: "midas", department: "finance" })],
        firstJob: "",
      },
    }), EXISTING);
    expect(r.done).toBe(true);
    expect(r.done && r.proposal.departments[0]!.playbooks).toEqual([]);
  });

  it("turns a coordinator the model slipped in into an error rather than a write", async () => {
    await expect(growthTurn([], "ctx", ask({
      done: true,
      proposal: { departments: [], agents: [agent({ kind: "coordinator" })], firstJob: "" },
    }), EXISTING)).rejects.toThrow(/already has one/);
  });
});
