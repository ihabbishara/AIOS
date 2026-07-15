# Skills Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skills tab in ui2 + filesystem-as-truth API: list skills with usage map, create/edit/delete SKILL.md files, URL-prefill import, assign skills to agents via role-YAML rewrite + registry reload.

**Architecture:** No new storage. `src/web/skills-view.ts` (mirroring `packs-view.ts`) scans `skills-plugin/skills/*/SKILL.md` and cross-refs the live `LoadedRegistry` for `usedBy`. Writes go straight to skill files; assignment rewrites the agent's YAML with the `yaml` package's `parseDocument` (preserves comments) and triggers the existing `reloadPacks()`. Skills load at agent spawn (`skillOptions`, `src/agents/runner.ts:17`) — skill-file changes need no restart.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), existing `yaml` dependency, vitest, React 18 in ui2. Spec: `docs/superpowers/specs/2026-07-15-skills-manager-design.md`.

## Global Constraints

- **No new dependencies.**
- Skill name regex: `/^[a-z][a-z0-9-]*$/`. Frontmatter `name` must equal directory name on save.
- `"fetch"` is a **reserved skill name** (would collide with `POST /api/skills/fetch`) — PUT rejects it.
- URL fetch: **https only**, `redirect: "error"`, 10 s timeout, 256 KB cap, content-type must start with `text/`. Fetch **never writes to disk** — it returns `{ md }` for editor prefill only.
- Skills plugin root: `process.env.AIOS_SKILLS_PLUGIN ?? join(process.cwd(), "skills-plugin")` — must match `src/agents/runner.ts:13`.
- YAML rewrites use `parseDocument` / `doc.set` / `doc.toString()` — never parse+restringify (comments must survive).
- Commit style: `feat(scope): lowercase summary`.
- Daemon tests: `npx vitest run <file>` from repo root. ui2: from `ui2/`.

---

### Task 1: skills-view core — scan, validate, CRUD, usage map, DTO

**Files:**
- Create: `src/web/skills-view.ts`
- Modify: `src/web/dto.ts` (append)
- Test: `test/skills-view.test.ts`

**Interfaces:**
- Consumes: `parse as parseYaml` from `yaml`; node:fs; `LoadedRegistry` is satisfied structurally by `RegistryLike`.
- Produces (later tasks rely on exact names):
  - dto: `interface SkillView { name: string; description: string; usedBy: string[] }`
  - `skillsPluginRoot(env?: NodeJS.ProcessEnv): string`
  - `interface RegistryLike { agents: Map<string, { manifest: { name: string }; role: { skills?: string[] } }> }`
  - `validateSkillMd(text: string): { ok: true; name: string; description: string } | { ok: false; error: string }`
  - `listSkills(root: string): Array<{ name: string; description: string }>`
  - `skillUsedBy(registry: RegistryLike, name: string): string[]`
  - `buildSkillsView(root: string, registry: RegistryLike): SkillView[]`
  - `readSkill(root: string, name: string): string | null`
  - `writeSkill(root: string, name: string, md: string): void`
  - `deleteSkill(root: string, name: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `test/skills-view.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/skills-view.test.ts`
Expected: FAIL — `Cannot find module '../src/web/skills-view.js'`

- [ ] **Step 3: Implement**

Append to `src/web/dto.ts`:

```ts
// ---- skills manager (spec 2026-07-15 skills-manager) ----
export interface SkillView {
  name: string;
  description: string;
  /** Agent (manifest) names whose role declares this skill. */
  usedBy: string[];
}
```

Create `src/web/skills-view.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/skills-view.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/skills-view.ts src/web/dto.ts test/skills-view.test.ts
git commit -m "feat(web): skills-view — scan, validate, CRUD, usage map (spec 2026-07-15)"
```

---

### Task 2: URL fetch guard + agent YAML skills rewrite

**Files:**
- Modify: `src/web/skills-view.ts` (append)
- Test: `test/skills-assign.test.ts`

**Interfaces:**
- Consumes: `parseDocument` from `yaml`; Task 1's `NAME` regex (same file).
- Produces:
  - `fetchSkillMd(url: string, fetchFn?: typeof fetch): Promise<{ ok: true; md: string } | { ok: false; error: string }>`
  - `agentYamlPath(agentsDir: string, def: { department: string; manifest: { name: string } }): string | null`
  - `rewriteSkillsField(text: string, skills: string[]): string`

- [ ] **Step 1: Write the failing test**

Create `test/skills-assign.test.ts`:

```ts
// test/skills-assign.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchSkillMd, agentYamlPath, rewriteSkillsField } from "../src/web/skills-view.js";

function fakeFetch(body: string, init?: { status?: number; contentType?: string }): typeof fetch {
  return (async () =>
    new Response(body, {
      status: init?.status ?? 200,
      headers: { "content-type": init?.contentType ?? "text/plain" },
    })) as unknown as typeof fetch;
}

describe("fetchSkillMd", () => {
  it("returns text from an https url", async () => {
    const r = await fetchSkillMd("https://example.com/SKILL.md", fakeFetch("---\nname: x\n---\nbody"));
    expect(r).toEqual({ ok: true, md: "---\nname: x\n---\nbody" });
  });
  it("rejects non-https and invalid urls without calling fetch", async () => {
    expect(await fetchSkillMd("http://example.com/x", fakeFetch("x"))).toMatchObject({ ok: false, error: "https only" });
    expect(await fetchSkillMd("not a url", fakeFetch("x"))).toMatchObject({ ok: false, error: "invalid url" });
  });
  it("rejects non-text content-type, oversize, and HTTP errors", async () => {
    expect(await fetchSkillMd("https://x.com/a", fakeFetch("bin", { contentType: "application/octet-stream" })))
      .toMatchObject({ ok: false });
    expect(await fetchSkillMd("https://x.com/a", fakeFetch("x".repeat(262_145)))).toMatchObject({ ok: false });
    expect(await fetchSkillMd("https://x.com/a", fakeFetch("nope", { status: 404 }))).toMatchObject({ ok: false, error: "HTTP 404" });
  });
});

describe("agentYamlPath", () => {
  it("finds <dept>/<name>.yaml directly, falls back to scanning for matching name", () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    mkdirSync(join(dir, "research"));
    writeFileSync(join(dir, "research", "janus.yaml"), "name: janus\n");
    writeFileSync(join(dir, "research", "renamed-file.yaml"), "name: venus\n");
    writeFileSync(join(dir, "research", "department.yaml"), "department: research\n");
    const def = (n: string) => ({ department: "research", manifest: { name: n } });
    expect(agentYamlPath(dir, def("janus"))).toBe(join(dir, "research", "janus.yaml"));
    expect(agentYamlPath(dir, def("venus"))).toBe(join(dir, "research", "renamed-file.yaml"));
    expect(agentYamlPath(dir, def("nobody"))).toBeNull();
  });
});

describe("rewriteSkillsField", () => {
  const SRC = `name: janus\n# keep this comment\ntools: [Read]\nskills: [market-sizing]\nkind: worker\n`;
  it("replaces the skills array and preserves comments + other fields", () => {
    const out = rewriteSkillsField(SRC, ["market-sizing", "design-tokens"]);
    expect(out).toContain("# keep this comment");
    expect(out).toContain("design-tokens");
    expect(out).toContain("kind: worker");
  });
  it("adds the key when absent, removes it when empty", () => {
    expect(rewriteSkillsField("name: odin\n", ["a-skill"])).toContain("a-skill");
    expect(rewriteSkillsField(SRC, [])).not.toContain("skills");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/skills-assign.test.ts`
Expected: FAIL — `fetchSkillMd` is not exported.

- [ ] **Step 3: Implement — append to `src/web/skills-view.ts`**

Extend the yaml import at the top of the file:

```ts
import { parse as parseYaml, parseDocument } from "yaml";
```

Append:

```ts
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

/** Comment-preserving rewrite of the `skills:` field (yaml Document API, not parse+restringify). */
export function rewriteSkillsField(text: string, skills: string[]): string {
  const doc = parseDocument(text);
  if (skills.length === 0) doc.delete("skills");
  else doc.set("skills", skills);
  return doc.toString();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/skills-assign.test.ts test/skills-view.test.ts`
Expected: PASS (both files)

- [ ] **Step 5: Commit**

```bash
git add src/web/skills-view.ts test/skills-assign.test.ts
git commit -m "feat(web): skill url-fetch guard + comment-preserving agent yaml skills rewrite"
```

---

### Task 3: API routes in `src/web/server.ts`

**Files:**
- Modify: `src/web/server.ts` (import block; routes after the schedule section added by the scheduling feature — search for `// ---- schedule:`)

**Interfaces:**
- Consumes: everything from Tasks 1–2; `registry` (`LoadedRegistry` satisfies `RegistryLike`), `config.agentsDir`, `reloadPacks()`, `json`, `readBody` — all already in scope in the handler.
- Produces routes (Task 4's api client calls these exact paths):
  - `GET /api/skills` → `SkillView[]`
  - `GET /api/skills/:name` → `{ md }` | 404
  - `PUT /api/skills/:name` → `{ ok: true }` | 400 (invalid md, name mismatch, reserved name)
  - `DELETE /api/skills/:name` → `{ ok: true }` | 404 | 409 `{ error, usedBy }` unless `?force=1`
  - `POST /api/skills/fetch` → `{ md }` | 400
  - `PATCH /api/agents/:name/skills` → `{ ok: true }` | 400 | 404 | 500

Route logic is thin by repo convention (see `test/goal-endpoints.test.ts` — builders/validators carry the tests); all logic lives in Tasks 1–2 functions.

- [ ] **Step 1: Add imports**

In the import block of `src/web/server.ts`:

```ts
import {
  skillsPluginRoot, buildSkillsView, validateSkillMd, readSkill, writeSkill,
  deleteSkill, skillUsedBy, fetchSkillMd, agentYamlPath, rewriteSkillsField,
} from "./skills-view.js";
import { readFileSync as readFileSyncFs, writeFileSync as writeFileSyncFs } from "node:fs";
```

Note: `server.ts` already imports `readFileSync`/`writeFileSync` from `node:fs` at the top — check first and reuse the existing names instead of aliasing if they're already there (they are, line 2). Drop the aliased import in that case.

- [ ] **Step 2: Add routes**

Directly after the schedule route group (after the `DELETE /api/reminders/:id` handler):

```ts
        // ---- skills manager (spec 2026-07-15 skills-manager) ----
        const skillsRoot = skillsPluginRoot();

        if (path === "/api/skills" && req.method === "GET") {
          return json(res, 200, buildSkillsView(skillsRoot, registry));
        }

        // Fetch route BEFORE the :name matcher — "fetch" is a reserved skill name.
        if (path === "/api/skills/fetch" && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { url?: unknown };
          if (typeof body.url !== "string") return json(res, 400, { error: "url must be a string" });
          const r = await fetchSkillMd(body.url);
          if (!r.ok) return json(res, 400, { error: r.error });
          return json(res, 200, { md: r.md });
        }

        const skillMatch = /^\/api\/skills\/([a-z][a-z0-9-]*)$/.exec(path);
        if (skillMatch && req.method === "GET") {
          const md = readSkill(skillsRoot, skillMatch[1]);
          if (md === null) return json(res, 404, { error: "unknown skill" });
          return json(res, 200, { md });
        }
        if (skillMatch && req.method === "PUT") {
          if (skillMatch[1] === "fetch") return json(res, 400, { error: '"fetch" is a reserved skill name' });
          const body = JSON.parse(await readBody(req)) as { md?: unknown };
          if (typeof body.md !== "string") return json(res, 400, { error: "md must be a string" });
          const v = validateSkillMd(body.md);
          if (!v.ok) return json(res, 400, { error: v.error });
          if (v.name !== skillMatch[1]) {
            return json(res, 400, { error: `frontmatter name "${v.name}" must equal "${skillMatch[1]}"` });
          }
          writeSkill(skillsRoot, skillMatch[1], body.md);
          return json(res, 200, { ok: true });
        }
        if (skillMatch && req.method === "DELETE") {
          const usedBy = skillUsedBy(registry, skillMatch[1]);
          if (usedBy.length > 0 && url.searchParams.get("force") !== "1") {
            return json(res, 409, { error: "skill in use", usedBy });
          }
          if (!deleteSkill(skillsRoot, skillMatch[1])) return json(res, 404, { error: "unknown skill" });
          return json(res, 200, { ok: true });
        }

        const agentSkillsMatch = /^\/api\/agents\/([a-z][a-z0-9-]*)\/skills$/.exec(path);
        if (agentSkillsMatch && req.method === "PATCH") {
          const canonical = registry.agentOf.get(agentSkillsMatch[1].toLowerCase()) ?? agentSkillsMatch[1];
          const def = registry.agents.get(canonical);
          if (!def) return json(res, 404, { error: "unknown agent" });
          const body = JSON.parse(await readBody(req)) as { skills?: unknown };
          if (!Array.isArray(body.skills) || body.skills.some((s) => typeof s !== "string")) {
            return json(res, 400, { error: "skills must be a string array" });
          }
          const known = new Set(buildSkillsView(skillsRoot, registry).map((s) => s.name));
          const unknown = (body.skills as string[]).filter((s) => !known.has(s));
          if (unknown.length > 0) return json(res, 400, { error: `unknown skills: ${unknown.join(", ")}` });
          const yamlPath = agentYamlPath(config.agentsDir, def);
          if (!yamlPath) return json(res, 500, { error: `agent yaml not found for ${canonical}` });
          writeFileSync(yamlPath, rewriteSkillsField(readFileSync(yamlPath, "utf8"), body.skills as string[]));
          reloadPacks();
          return json(res, 200, { ok: true });
        }
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx vitest run test/skills-view.test.ts test/skills-assign.test.ts`
Expected: clean typecheck, tests pass.

If `registry.agentOf` is not the alias map's name, check `LoadedRegistry` in `src/agents/registry/loader.ts:40` — the alias→canonical map used by `toCoordinator` (`server.ts:70`) is the one to use.

- [ ] **Step 4: Commit**

```bash
git add src/web/server.ts
git commit -m "feat(web): skills manager API — CRUD, guarded fetch prefill, agent assignment"
```

---

### Task 4: ui2 plumbing — section, nav, api client

**Files:**
- Modify: `ui2/src/lib/router.ts` (SECTIONS)
- Modify: `ui2/src/components/BottomTabs.tsx` (ICONS)
- Modify: `ui2/src/App.tsx` (JUMPS, import, mount, comments)
- Modify: `ui2/src/api.ts` (types + methods)
- Create: `ui2/src/views/Skills.tsx` (placeholder, replaced in Task 5)
- Test: extend `ui2/test/router.test.ts`

**Interfaces:**
- Consumes: `SkillView` via dto re-export; routes from Task 3.
- Produces (Task 5 relies on):
  - `api.skills(): Promise<SkillView[]>`
  - `api.skillMd(name: string): Promise<{ md: string }>`
  - `api.saveSkill(name: string, md: string): Promise<{ ok: true }>`
  - `api.deleteSkill(name: string, force?: boolean): Promise<{ ok: true }>`
  - `api.fetchSkill(url: string): Promise<{ md: string }>`
  - `api.setAgentSkills(agent: string, skills: string[]): Promise<{ ok: true }>`
  - Section id `"skills"`, jump key `k`, tab icon `✦`.

- [ ] **Step 1: Write the failing test**

Append to the `describe` block in `ui2/test/router.test.ts`:

```ts
  it("skills is a section", () => {
    expect(parseHash("#/skills").section).toBe("skills");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui2 && npx vitest run test/router.test.ts`
Expected: FAIL — section resolves to `"home"`.

- [ ] **Step 3: Implement**

`ui2/src/lib/router.ts`:

```ts
export const SECTIONS = ["home", "goals", "staff", "mail", "schedule", "skills", "system"] as const;
```

`ui2/src/components/BottomTabs.tsx`:

```ts
const ICONS: Record<string, string> = { home: "◉", goals: "◎", staff: "▤", mail: "✉", schedule: "◷", skills: "✦", system: "⚙" };
```

`ui2/src/App.tsx` — four edits:

```ts
const JUMPS: Record<string, string> = { h: "home", g: "goals", s: "staff", m: "mail", r: "schedule", k: "skills", y: "system" };
```

```ts
import { Skills } from "./views/Skills.js";
```

Mount between schedule and system:

```tsx
      <div className={show("skills")}><Skills /></div>
```

Update the two comments: shell comment `6 sections` → `7 sections`; jump comment `g then h/g/s/m/r/y` → `g then h/g/s/m/r/k/y`.

`ui2/src/api.ts` — add `SkillView` to BOTH the `export type {...}` and `import type {...}` lists from `../../src/web/dto.js`, then add to the `api` object:

```ts
  skills: () => request<SkillView[]>("/api/skills"),
  skillMd: (name: string) => request<{ md: string }>(`/api/skills/${encodeURIComponent(name)}`),
  saveSkill: (name: string, md: string) =>
    request<{ ok: true }>(`/api/skills/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ md }) }),
  deleteSkill: (name: string, force = false) =>
    request<{ ok: true }>(`/api/skills/${encodeURIComponent(name)}${force ? "?force=1" : ""}`, { method: "DELETE" }),
  fetchSkill: (url: string) =>
    request<{ md: string }>("/api/skills/fetch", { method: "POST", body: JSON.stringify({ url }) }),
  setAgentSkills: (agent: string, skills: string[]) =>
    request<{ ok: true }>(`/api/agents/${encodeURIComponent(agent)}/skills`, { method: "PATCH", body: JSON.stringify({ skills }) }),
```

Create `ui2/src/views/Skills.tsx`:

```tsx
// ui2/src/views/Skills.tsx — placeholder, implemented in the next task.
export function Skills() {
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui2 && npx vitest run && npx tsc --noEmit`
Expected: router test green, no other suite broken, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add ui2/src/lib/router.ts ui2/src/components/BottomTabs.tsx ui2/src/App.tsx ui2/src/api.ts ui2/src/views/Skills.tsx ui2/test/router.test.ts
git commit -m "feat(ui2): skills section plumbing — route, tab, jump key, api client"
```

---

### Task 5: Skills view UI

**Files:**
- Modify (replace placeholder): `ui2/src/views/Skills.tsx`
- Test: `ui2/test/skills-render.test.tsx`

**Interfaces:**
- Consumes: `api.*` from Task 4; `useFetch` from `ui2/src/hooks.ts`; `SectionLabel`, `Empty`, `Button`, `Tag` from `ui2/src/components/ui.tsx` (Button variants: `"primary" | "ghost" | "danger"`); `TwoStepButton` (`{ label, confirmLabel?, disabled?, onConfirm, className? }`); `api.state()` for the agent list (`StateInfo.agents: Array<{ name: string; ... }>`).
- Produces: `export function Skills()` — no props.

- [ ] **Step 1: Write the failing test**

Create `ui2/test/skills-render.test.tsx`:

```tsx
// ui2/test/skills-render.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Skills } from "../src/views/Skills.js";
import { stubApi, STATE_STUB } from "./stubs.js";

afterEach(cleanup);

const SKILLS = [
  { name: "design-tokens", description: "design token guidance", usedBy: [] },
  { name: "market-sizing", description: "TAM/SAM/SOM methodology", usedBy: ["janus"] },
];

describe("Skills view", () => {
  it("renders the list with usage chips", async () => {
    stubApi({ "/api/skills": SKILLS, "/api/state": STATE_STUB });
    render(<Skills />);
    expect(await screen.findByText("market-sizing")).toBeTruthy();
    expect(screen.getByText("design-tokens")).toBeTruthy();
    expect(screen.getByText("janus")).toBeTruthy(); // usage chip
  });

  it("opens a skill in the editor and saves", async () => {
    stubApi({
      "/api/skills": SKILLS,
      "/api/state": STATE_STUB,
      "/api/skills/market-sizing": { md: "---\nname: market-sizing\ndescription: d\n---\nbody" },
    });
    render(<Skills />);
    fireEvent.click(await screen.findByText("market-sizing"));
    const editor = (await screen.findByLabelText("skill markdown")) as HTMLTextAreaElement;
    expect(editor.value).toContain("market-sizing");
    fireEvent.click(screen.getByText("Save"));
    expect((await screen.findAllByText(/./)).length).toBeGreaterThan(0); // no crash; PUT stubbed above
  });

  it("new-skill button seeds the frontmatter template", async () => {
    stubApi({ "/api/skills": SKILLS, "/api/state": STATE_STUB });
    render(<Skills />);
    await screen.findByText("market-sizing");
    fireEvent.click(screen.getByText("New skill"));
    const editor = (await screen.findByLabelText("skill markdown")) as HTMLTextAreaElement;
    expect(editor.value).toContain("name: my-skill");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui2 && npx vitest run test/skills-render.test.tsx`
Expected: FAIL — placeholder renders null.

- [ ] **Step 3: Implement `ui2/src/views/Skills.tsx`**

```tsx
// ui2/src/views/Skills.tsx — skills manager: list + usage, SKILL.md editor, url prefill,
// agent assignment (spec 2026-07-15 skills-manager).
import { useState } from "react";
import { api } from "../api.js";
import type { SkillView } from "../api.js";
import { useFetch } from "../hooks.js";
import { SectionLabel, Empty, Button, Tag } from "../components/ui.js";
import { TwoStepButton } from "../components/TwoStepButton.js";

const TEMPLATE = `---
name: my-skill
description: When should an agent reach for this skill
---

# My Skill

Instructions the agent follows when the skill loads.
`;

function nameFromMd(md: string): string | null {
  const m = /^---[\s\S]*?\bname:\s*([a-z][a-z0-9-]*)\s*$/m.exec(md);
  return m ? m[1] : null;
}

function Editor({ initialMd, usedBy, agents, onSaved, onDeleted, onToggle }: {
  initialMd: string;
  usedBy: string[];
  agents: string[];
  onSaved: () => void;
  onDeleted: () => void;
  /** Toggle this skill for an agent — parent owns the PATCH (needs the full usage map). */
  onToggle: (agent: string) => void;
}) {
  const [md, setMd] = useState(initialMd);
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string>();
  const name = nameFromMd(md);
  const save = () => {
    if (!name) { setErr("frontmatter needs a valid name (a-z, 0-9, -)"); return; }
    api.saveSkill(name, md).then(() => { setErr(undefined); onSaved(); }).catch((e) => setErr((e as Error).message));
  };
  return (
    <div className="flex flex-col gap-2 py-2">
      <div className="flex items-center gap-2">
        <input className="bg-transparent border border-line rounded px-2 py-1 flex-1" placeholder="https://… (prefill editor from URL)"
          value={url} onChange={(e) => setUrl(e.target.value)} />
        <Button disabled={!url.trim()} onClick={() =>
          api.fetchSkill(url).then((r) => { setMd(r.md); setErr(undefined); }).catch((e) => setErr((e as Error).message))
        }>Fetch → editor</Button>
      </div>
      <textarea className="bg-transparent border border-line rounded px-2 py-1 min-h-64 font-mono text-xs"
        aria-label="skill markdown" value={md} onChange={(e) => setMd(e.target.value)} />
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="primary" onClick={save}>Save</Button>
        {name && (
          <TwoStepButton
            label={usedBy.length ? `Delete — used by ${usedBy.length}` : "Delete"}
            onConfirm={() => api.deleteSkill(name, usedBy.length > 0).then(onDeleted).catch((e) => setErr((e as Error).message))}
          />
        )}
      </div>
      {name && agents.length > 0 && (
        <div className="mt-2">
          <SectionLabel>Assigned agents</SectionLabel>
          <div className="flex flex-wrap gap-3 mt-1">
            {agents.map((a) => (
              <label key={a} className="flex items-center gap-1 text-sm text-fg">
                <input type="checkbox" checked={usedBy.includes(a)} onChange={() => onToggle(a)} />
                {a}
              </label>
            ))}
          </div>
        </div>
      )}
      {err && <div className="text-err text-xs">{err}</div>}
    </div>
  );
}

export function Skills() {
  const { data: skills, error, reload } = useFetch(() => api.skills(), []);
  const { data: state } = useFetch(() => api.state(), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [editorMd, setEditorMd] = useState<string | null>(null);
  const [err, setErr] = useState<string>();

  if (error) return <Empty>{error}</Empty>;
  if (!skills) return <Empty>Loading…</Empty>;
  const open = (s: SkillView) => {
    setSelected(s.name);
    setEditorMd(null);
    api.skillMd(s.name).then((r) => setEditorMd(r.md)).catch((e) => setErr((e as Error).message));
  };
  const sel = skills.find((s) => s.name === selected);
  const agents = (state?.agents ?? []).map((a) => a.name);
  // Assignment toggle: PATCH the agent's FULL skill list, recomputed from the live usage map.
  const toggle = (agent: string) => {
    if (!sel) return;
    const current = skills.filter((s) => s.usedBy.includes(agent)).map((s) => s.name);
    const next = current.includes(sel.name) ? current.filter((n) => n !== sel.name) : [...current, sel.name];
    api.setAgentSkills(agent, next).then(reload).catch((e) => setErr((e as Error).message));
  };
  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 max-w-4xl w-full mx-auto">
      <div className="flex items-center gap-2">
        <SectionLabel>Skills</SectionLabel>
        <span className="flex-1" />
        <Button onClick={() => { setSelected(null); setEditorMd(TEMPLATE); }}>New skill</Button>
      </div>
      {skills.length === 0 && <Empty>No skills yet.</Empty>}
      {skills.map((s) => (
        <div key={s.name} className="flex items-center gap-2 py-1.5 border-b border-line cursor-pointer"
          onClick={() => open(s)}>
          <span className="text-bright">{s.name}</span>
          <span className="text-dim text-xs flex-1 truncate">{s.description}</span>
          {s.usedBy.map((a) => (
            <a key={a} href={`#/staff/agents/${encodeURIComponent(a)}`} onClick={(e) => e.stopPropagation()}>
              <Tag tone="agent">{a}</Tag>
            </a>
          ))}
        </div>
      ))}
      {editorMd !== null && (
        <div className="mt-4">
          <SectionLabel>{sel ? `Edit: ${sel.name}` : "New skill"}</SectionLabel>
          <Editor initialMd={editorMd} usedBy={sel?.usedBy ?? []} agents={agents} onToggle={toggle}
            onSaved={() => { setEditorMd(null); setSelected(null); reload(); }}
            onDeleted={() => { setEditorMd(null); setSelected(null); reload(); }} />
        </div>
      )}
      {err && <div className="text-err text-xs mt-2">{err}</div>}
    </div>
  );
}
```

Usage chips are links into the agent's Staff profile (`#/staff/agents/<name>`), per spec; `stopPropagation` keeps chip clicks from also opening the editor.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui2 && npx vitest run test/skills-render.test.tsx && npx tsc --noEmit`
Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add ui2/src/views/Skills.tsx ui2/test/skills-render.test.tsx
git commit -m "feat(ui2): Skills view — list + usage, SKILL.md editor, url prefill, assignment"
```

---

### Task 6: Full verification + deploy

- [ ] **Step 1: Full daemon suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 2: Full ui2 suite + typecheck**

Run: `cd ui2 && npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 3: Build + restart daemon + smoke**

```bash
npm run build && cd ui2 && npm run build && cd ..
launchctl kickstart -k gui/501/com.ihab.aios && sleep 3
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | head -1 | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/skills
```

Expected: JSON array with `design-tokens` (usedBy `["venus"]`) and `market-sizing` (usedBy `["janus"]`).

- [ ] **Step 4: Verify clean tree**

```bash
git status --short
```

Expected: clean (all work committed per-task).
