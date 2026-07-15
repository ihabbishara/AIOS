// test/skills-view.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateSkillMd, listSkills, skillUsedBy, buildSkillsView,
  readSkill, writeSkill, deleteSkill, skillsPluginRoot, type RegistryLike,
} from "../src/web/skills-view.js";

const MD = (name: string, desc = "when to use it") => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# Body\n`;

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "skills-"));
}

function seed(root: string, names: string[]): void {
  for (const n of names) {
    mkdirSync(join(root, "skills", n), { recursive: true });
    writeFileSync(join(root, "skills", n, "SKILL.md"), MD(n));
  }
}

function registry(map: Record<string, string[]>): RegistryLike {
  const agents = new Map<string, { manifest: { name: string }; role: { skills?: string[] } }>();
  for (const [agent, skills] of Object.entries(map)) {
    agents.set(agent, { manifest: { name: agent }, role: { skills } });
  }
  return { agents };
}

describe("validateSkillMd", () => {
  it("accepts valid frontmatter", () => {
    expect(validateSkillMd(MD("market-sizing"))).toEqual({ ok: true, name: "market-sizing", description: "when to use it" });
  });
  it("rejects missing frontmatter, bad name, missing description", () => {
    expect(validateSkillMd("# no frontmatter")).toMatchObject({ ok: false });
    expect(validateSkillMd(MD("Bad_Name"))).toMatchObject({ ok: false });
    expect(validateSkillMd("---\nname: ok-name\n---\nbody")).toMatchObject({ ok: false });
    expect(validateSkillMd("---\nname: [broken\n---\nbody")).toMatchObject({ ok: false });
  });
});

describe("listSkills / buildSkillsView", () => {
  it("scans directories, sorted, invalid frontmatter surfaced not hidden", () => {
    const root = tmpRoot();
    seed(root, ["zeta", "alpha"]);
    mkdirSync(join(root, "skills", "broken"), { recursive: true });
    writeFileSync(join(root, "skills", "broken", "SKILL.md"), "no frontmatter here");
    const names = listSkills(root).map((s) => s.name);
    expect(names).toEqual(["alpha", "broken", "zeta"]);
    expect(listSkills(root)[1].description).toBe("(invalid frontmatter)");
  });
  it("empty/missing root → []", () => {
    expect(listSkills(join(tmpRoot(), "nope"))).toEqual([]);
  });
  it("usedBy cross-references the registry", () => {
    const root = tmpRoot();
    seed(root, ["market-sizing", "design-tokens"]);
    const reg = registry({ janus: ["market-sizing"], venus: ["design-tokens"], odin: [] });
    const view = buildSkillsView(root, reg);
    expect(view.find((s) => s.name === "market-sizing")!.usedBy).toEqual(["janus"]);
    expect(skillUsedBy(reg, "design-tokens")).toEqual(["venus"]);
    expect(skillUsedBy(reg, "unknown")).toEqual([]);
  });
});

describe("readSkill / writeSkill / deleteSkill", () => {
  it("round-trips and guards names before any path join", () => {
    const root = tmpRoot();
    writeSkill(root, "new-skill", MD("new-skill"));
    expect(readSkill(root, "new-skill")).toBe(MD("new-skill"));
    expect(readSkill(root, "../escape")).toBeNull();
    expect(readSkill(root, "missing")).toBeNull();
    expect(deleteSkill(root, "new-skill")).toBe(true);
    expect(readSkill(root, "new-skill")).toBeNull();
    expect(deleteSkill(root, "new-skill")).toBe(false);
  });
});

describe("skillsPluginRoot", () => {
  it("env override wins; default is <cwd>/skills-plugin", () => {
    expect(skillsPluginRoot({ AIOS_SKILLS_PLUGIN: "/x/y" } as NodeJS.ProcessEnv)).toBe("/x/y");
    expect(skillsPluginRoot({} as NodeJS.ProcessEnv)).toBe(join(process.cwd(), "skills-plugin"));
  });
});
