// test/onboarding-templates.test.ts — org templates are product data read from disk (spec §5).
// The gallery is the wizard's escape hatch, so a broken template must never blank it.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTemplates, loadTemplate, orgTemplateSchema } from "../src/onboarding/templates.js";

const GOOD = `
name: tiny
title: Tiny Org
summary: One coordinator and one worker.
firstJob: Summarize what this org can do for me.
departments:
  - department: operations
    mission: The front door.
    memoDomain: general
    lead: nova
agents:
  - name: nova
    department: operations
    kind: coordinator
    title: Coordinator
    charter: Route work.
    persona: Calm and brief.
    prompt: You route requests to the right specialist.
    capabilities: [coordination]
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tpl-"));
  mkdirSync(join(dir, "orgs", "tiny"), { recursive: true });
  writeFileSync(join(dir, "orgs", "tiny", "org.yaml"), GOOD);
});

describe("org templates", () => {
  it("lists templates as gallery rows", () => {
    expect(listTemplates(dir)).toEqual([
      { name: "tiny", title: "Tiny Org", summary: "One coordinator and one worker." },
    ]);
  });

  it("loads a template into a parsed structure", () => {
    const t = loadTemplate(dir, "tiny")!;
    expect(t.agents[0].name).toBe("nova");
    expect(t.agents[0].kind).toBe("coordinator");
    expect(t.agents[0].skills).toEqual([]); // defaulted
    expect(t.departments[0].capabilities).toEqual([]); // defaulted
  });

  it("returns undefined for an unknown template", () => {
    expect(loadTemplate(dir, "nope")).toBeUndefined();
  });

  it("skips a broken template instead of throwing — the gallery must still render", () => {
    mkdirSync(join(dir, "orgs", "broken"), { recursive: true });
    writeFileSync(join(dir, "orgs", "broken", "org.yaml"), "name: broken\ntitle: [unclosed\n");
    const lines: string[] = [];
    expect(listTemplates(dir, (l) => lines.push(l)).map((t) => t.name)).toEqual(["tiny"]);
    expect(lines.join(" ")).toContain("broken");
  });

  it("skips a directory with no org.yaml", () => {
    mkdirSync(join(dir, "orgs", "empty"), { recursive: true });
    expect(listTemplates(dir).map((t) => t.name)).toEqual(["tiny"]);
  });

  it("returns an empty list when the templates dir is absent", () => {
    expect(listTemplates(join(dir, "missing"))).toEqual([]);
  });

  it("rejects a template whose name is not kebab-case", () => {
    const good = loadTemplate(dir, "tiny")!;
    expect(orgTemplateSchema.safeParse({ ...good, name: "Not Kebab" }).success).toBe(false);
  });

  it("refuses a traversing name rather than reading outside the templates dir", () => {
    expect(loadTemplate(dir, "../../etc")).toBeUndefined();
  });
});
