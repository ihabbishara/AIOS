// src/web/skills-view.ts — skills manager: scan/validate/CRUD over skills-plugin + usage map
// (spec docs/superpowers/specs/2026-07-15-skills-manager-design.md). Mirrors packs-view.ts.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillView } from "./dto.js";

/** Must agree with SKILLS_PLUGIN_PATH in src/agents/runner.ts. */
export function skillsPluginRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.AIOS_SKILLS_PLUGIN ?? join(process.cwd(), "skills-plugin");
}

/** Structural slice of LoadedRegistry — keeps this module testable without the loader. */
export interface RegistryLike {
  agents: Map<string, { manifest: { name: string }; role: { skills?: string[] } }>;
}

const NAME = /^[a-z][a-z0-9-]*$/;

export function validateSkillMd(
  text: string,
): { ok: true; name: string; description: string } | { ok: false; error: string } {
  const m = /^---\n([\s\S]*?)\n---/.exec(text.trim());
  if (!m) return { ok: false, error: "missing --- frontmatter block" };
  let fm: unknown;
  try { fm = parseYaml(m[1]); } catch (err) { return { ok: false, error: `frontmatter: ${(err as Error).message}` }; }
  const o = (fm ?? {}) as Record<string, unknown>;
  if (typeof o.name !== "string" || !NAME.test(o.name)) {
    return { ok: false, error: "frontmatter name must match ^[a-z][a-z0-9-]*$" };
  }
  if (typeof o.description !== "string" || !o.description.trim()) {
    return { ok: false, error: "frontmatter description required" };
  }
  return { ok: true, name: o.name, description: o.description.trim() };
}

export function listSkills(root: string): Array<{ name: string; description: string }> {
  const dir = join(root, "skills");
  if (!existsSync(dir)) return [];
  const out: Array<{ name: string; description: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const md = join(dir, entry.name, "SKILL.md");
    if (!existsSync(md)) continue;
    const v = validateSkillMd(readFileSync(md, "utf8"));
    // Invalid skills stay visible — the UI is where you fix them.
    out.push({ name: entry.name, description: v.ok ? v.description : "(invalid frontmatter)" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function skillUsedBy(registry: RegistryLike, name: string): string[] {
  const out: string[] = [];
  for (const def of registry.agents.values()) {
    if (def.role.skills?.includes(name)) out.push(def.manifest.name);
  }
  return out.sort();
}

export function buildSkillsView(root: string, registry: RegistryLike): SkillView[] {
  return listSkills(root).map((s) => ({ ...s, usedBy: skillUsedBy(registry, s.name) }));
}

export function readSkill(root: string, name: string): string | null {
  if (!NAME.test(name)) return null;
  const md = join(root, "skills", name, "SKILL.md");
  return existsSync(md) ? readFileSync(md, "utf8") : null;
}

export function writeSkill(root: string, name: string, md: string): void {
  mkdirSync(join(root, "skills", name), { recursive: true });
  writeFileSync(join(root, "skills", name, "SKILL.md"), md);
}

export function deleteSkill(root: string, name: string): boolean {
  if (!NAME.test(name)) return false;
  const dir = join(root, "skills", name);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true });
  return true;
}
