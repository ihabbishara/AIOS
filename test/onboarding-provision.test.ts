// test/onboarding-provision.test.ts — the one mutation path from proposal to live org (spec §4).
// The invariant under test throughout: a rejected proposal leaves the disk as it found it.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provision } from "../src/onboarding/provision.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import type { OrgProposal } from "../src/onboarding/proposal.js";

let root: string, agentsDir: string, playbooksDir: string, templatesDir: string;

const CAPS = `
coordination: { tools: [TodoWrite] }
reading:      { tools: [Read] }
drafting:     { tools: [Write] }
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prov-"));
  agentsDir = join(root, "agents");
  playbooksDir = join(root, "playbooks");
  templatesDir = join(root, "templates");
  mkdirSync(playbooksDir, { recursive: true });
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(join(templatesDir, "_capabilities.yaml"), CAPS);
});

const deps = () => ({ agentsDir, playbooksDir, templatesDir, loadRegistry });

const proposal = (over: Partial<OrgProposal> = {}): OrgProposal => ({
  source: { kind: "template", template: "tiny" },
  firstJob: "Say hello.",
  departments: [
    { department: "operations", mission: "Front door.", memoDomain: "general", lead: "nova", capabilities: [], playbooks: [] },
    { department: "studio", mission: "Make things.", memoDomain: "studio", lead: "scribe", capabilities: ["reading"], playbooks: [] },
  ],
  agents: [
    { name: "nova", department: "operations", kind: "coordinator", title: "Coordinator",
      charter: "Route work.", persona: "Brief.", prompt: "You route requests.", capabilities: ["coordination"], skills: [] },
    { name: "scribe", department: "studio", kind: "lead", title: "Writer",
      charter: "Write drafts.", persona: "Plain.", prompt: "You write drafts.", capabilities: ["drafting"], skills: [] },
  ],
  ...over,
});

describe("provision", () => {
  it("writes departments and agents, and the result loads as a live registry", () => {
    const r = provision(proposal(), deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.departments.sort()).toEqual(["operations", "studio"]);
    expect(r.agents.sort()).toEqual(["nova", "scribe"]);

    const reg = loadRegistry(agentsDir, playbooksDir);
    expect([...reg.departments.keys()].sort()).toEqual(["operations", "studio"]);
    expect(reg.agents.size).toBe(2);
    expect(reg.coordinator).toBe("nova");
    expect(reg.departments.get("studio")!.lead).toBe("scribe");
  });

  it("seeds the capability catalog into a fresh agents dir", () => {
    provision(proposal(), deps());
    expect(readFileSync(join(agentsDir, "_capabilities.yaml"), "utf8")).toContain("coordination");
  });

  it("copies the template's playbooks before the departments that name them", () => {
    mkdirSync(join(templatesDir, "orgs", "tiny", "playbooks"), { recursive: true });
    writeFileSync(join(templatesDir, "orgs", "tiny", "playbooks", "tiny-brief.yaml"),
      "name: tiny-brief\ndescription: Brief.\nneedsProjectDir: false\nstages:\n  - type: single\n    id: s\n    role: scribe\n    brief: Write.\n");
    const p = proposal();
    p.departments[1].playbooks = ["tiny-brief"];
    const r = provision(p, deps());
    expect(r.ok).toBe(true);
    expect(existsSync(join(playbooksDir, "tiny-brief.yaml"))).toBe(true);
    // The department survived the load — a missing playbook would have made the loader skip it.
    expect([...loadRegistry(agentsDir, playbooksDir).departments.keys()]).toContain("studio");
  });

  it("reports a bad capability as a card-level agent error and writes nothing", () => {
    const p = proposal();
    p.agents[1].capabilities = ["telepathy"];
    const r = provision(p, deps());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([{ scope: "agent", name: "scribe", error: 'unknown capability "telepathy"' }]);
    expect(existsSync(join(agentsDir, "operations"))).toBe(false);
    expect(existsSync(join(agentsDir, "studio"))).toBe(false);
  });

  it("collects every card error in one pass rather than stopping at the first", () => {
    const p = proposal();
    p.agents[0].capabilities = ["telepathy"];
    p.agents[1].title = "";
    const r = provision(p, deps());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.name).sort()).toEqual(["nova", "scribe"]);
  });

  it("rejects a proposal that fails the structural gate before touching disk", () => {
    const p = proposal();
    p.agents[0].kind = "worker";
    const r = provision(p, deps());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([{ scope: "proposal", error: "proposal needs exactly one coordinator, found 0" }]);
    expect(existsSync(agentsDir)).toBe(false);
  });

  it("deletes everything it wrote when the final reload throws", () => {
    let calls = 0;
    const r = provision(proposal(), {
      ...deps(),
      // First call is the baseline read; the final verification reload is the one that fails.
      loadRegistry: (a: string, p: string) => {
        if (++calls === 1) return loadRegistry(a, p);
        throw new Error("reload exploded");
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].error).toContain("reload exploded");
    expect(existsSync(join(agentsDir, "operations"))).toBe(false);
    expect(existsSync(join(agentsDir, "studio"))).toBe(false);
    // The seeded catalog is left: it is not part of the org and re-seeding is idempotent.
    expect(existsSync(join(agentsDir, "_capabilities.yaml"))).toBe(true);
  });

  it("refuses to provision into an agents dir that already has an org", () => {
    provision(proposal(), deps());
    const r = provision(proposal(), deps());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].error).toContain("already exists");
  });

  it("leaves a pre-existing unrelated department untouched when it compensates", () => {
    mkdirSync(join(agentsDir, "keep"), { recursive: true });
    writeFileSync(join(agentsDir, "keep", "department.yaml"),
      "department: keep\nmission: Keep me.\nmemoDomain: keep\n");
    const p = proposal();
    p.agents[1].capabilities = ["telepathy"];
    provision(p, deps());
    expect(existsSync(join(agentsDir, "keep", "department.yaml"))).toBe(true);
    expect(readdirSync(agentsDir).sort()).toEqual(["_capabilities.yaml", "keep"]);
  });
});
