// src/web/skills-view.ts — skills manager: scan/validate/CRUD over skills-plugin + usage map
// (spec docs/superpowers/specs/2026-07-15-skills-manager-design.md). Mirrors packs-view.ts.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, parseDocument, isMap, isNode, isScalar } from "yaml";
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

const FETCH_CAP = 262_144; // 256 KB
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Server-side fetch for the import prefill. Returns text for the editor —
 * NEVER writes to disk: imported skills become agent system-prompt content,
 * so a human reviews before save. https only, no redirects, text only, capped.
 */
export async function fetchSkillMd(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; md: string } | { ok: false; error: string }> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, error: "invalid url" }; }
  if (u.protocol !== "https:") return { ok: false, error: "https only" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(u, { signal: ctrl.signal, redirect: "error" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("text/")) return { ok: false, error: `content-type "${ct || "unknown"}" is not text` };
    const text = await res.text();
    if (text.length > FETCH_CAP) return { ok: false, error: "response exceeds 256 KB" };
    return { ok: true, md: text };
  } catch (err) {
    return { ok: false, error: (err as Error).name === "AbortError" ? "timeout" : (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** `<agentsDir>/<dept>/<name>.yaml`, falling back to a department-dir scan for renamed files. */
export function agentYamlPath(
  agentsDir: string,
  def: { department: string; manifest: { name: string } },
): string | null {
  const direct = join(agentsDir, def.department, `${def.manifest.name}.yaml`);
  if (existsSync(direct)) return direct;
  const deptDir = join(agentsDir, def.department);
  if (!existsSync(deptDir)) return null;
  for (const f of readdirSync(deptDir)) {
    if (!f.endsWith(".yaml") || f === "department.yaml") continue;
    try {
      const parsed = parseYaml(readFileSync(join(deptDir, f), "utf8")) as { name?: string } | null;
      if (parsed?.name === def.manifest.name) return join(deptDir, f);
    } catch { /* unparseable file — not ours to fix here */ }
  }
  return null;
}

/**
 * Rewrite the `skills:` field, leaving every other byte of the file untouched.
 *
 * Parse to LOCATE, splice to EDIT. A full `parseDocument(text).toString()`
 * round-trip re-emits the whole document in the serializer's own style — flow
 * padding (`[a]` → `[ a ]`), folded scalars re-wrapped at a different column —
 * which rewrites ~85% of a hand-authored role file on every skill toggle. No
 * toString option avoids it (a no-op round-trip churns the file by itself), so
 * we take the field's parsed source range and splice the original string.
 */
export function rewriteSkillsField(text: string, skills: string[]): string {
  for (const s of skills) {
    if (!NAME.test(s)) throw new Error(`invalid skill name: ${s}`);
  }
  const line = `skills: [${skills.join(", ")}]\n`;
  const doc = parseDocument(text);
  const items = isMap(doc.contents) ? doc.contents.items : [];
  const pair = items.find((p) => isScalar(p.key) && p.key.value === "skills");
  // Field absent: nothing to strip, otherwise append in the repo's flow style.
  if (!pair || !isNode(pair.key) || !isNode(pair.value)) {
    if (skills.length === 0) return text;
    return text === "" || text.endsWith("\n") ? text + line : `${text}\n${line}`;
  }
  const start = pair.key.range![0];
  const end = pair.value.range![2];
  return text.slice(0, start) + (skills.length === 0 ? "" : line) + text.slice(end);
}
