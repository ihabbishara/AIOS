# Org Provisioning Spine (plan 2a/4) Implementation Plan

> ## ⛔ THIS PLAN IS COMPLETE — DO NOT EXECUTE IT
>
> **Tasks 1-12 were implemented, verified, and merged to `main` (82290af) on 2026-07-31.**
> Re-running them would duplicate existing files and re-apply landed refactors.
>
> **Tasks 13 and 14 were DEFERRED BY THE REPO OWNER and must NOT be executed by an agent.**
> Task 13 copies the owner's real agent manifests into `test/fixtures/org/` and commits them —
> that requires a human privacy review of ~785 lines of prose that no agent should approve on
> its own. Their checkbox syntax has been deliberately stripped so nothing reads as actionable.
> The remaining work is tracked in the "Execution outcome" section at the bottom and belongs to
> a future plan (2a-bis), not to this one.
>
> If you are looking for work to do, this file is not it.

> **For agentic workers (historical, tasks 1-12 only):** this plan was executed with
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new user picks an org template in the wizard and a real, live org lands on disk — departments, agents, and playbooks — provisioned through the same deterministic validators that guard manual hiring.

**Architecture:** Templates are product data (`templates/orgs/<name>/`) that convert to an `OrgProposal` — the same structure the Org Architect will emit in plan 2b. A single `provision()` function replays a proposal through `validateDepartment` + a coordinator-allowing sibling of `validateHire`, writes every file, then calls `loadRegistry` **once**. Any failure deletes everything written, so the registry is never half-loaded. The wizard's `interview` step gains a template gallery; `review` renders the proposal read-only; `provision` runs the provisioner and advances to `first-job`.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Node 23 `node:sqlite`, zod schemas, `yaml` parse-only, vitest, React 19 + Tailwind (ui2).

## Global Constraints

- **Subscription auth only.** Never introduce `ANTHROPIC_API_KEY`; the daemon runs on `CLAUDE_CODE_OAUTH_TOKEN`. No task here makes a model call at all.
- **Never-brick invariant.** Every filesystem mutation that is followed by `loadRegistry`/`reloadPacks` must compensate on throw (delete what was written, move back what was moved) so the roster stays reloadable. This is the existing pattern at `src/web/server.ts:710-756`.
- **Imports use `.js` specifiers** even for `.ts` sources (NodeNext): `import { x } from "./y.js"`.
- **Tests are read via the "Tests" summary line**, never via exit codes: `npx vitest run`. Current baseline is **202 files / 1589 passing**. A task that changes the count must say so.
- **Do not regenerate `test/fixtures/org-golden.json`** except in Task 12, where re-pinning is the explicit deliverable. Anywhere else, a golden diff means something broke.
- **Do not run the daemon in normal mode from this checkout** while the live daemon holds port 4280 — it steals Telegram updates. Smoke on `AIOS_UI_PORT=4291`.
- Agent and department names match `^[a-z][a-z0-9-]*$`. The name `user` is reserved (loader.ts:150).
- Capability names must exist in the capability catalog; `life` department agents may not carry vault-write/propose/gate/email/git/calendar tools (`src/agents/registry/walls.ts`).

## File Structure

**New product data**
- `templates/_capabilities.yaml` — the capability catalog, relocated out of `agents/` so it survives `agents/` becoming user data. Seeded into a fresh `agents/` at provision.
- `templates/orgs/<name>/org.yaml` — one complete org: departments, agents, first-job suggestion. Five templates: `starter`, `solo-dev`, `founder`, `researcher`, `personal-assistant`.
- `templates/orgs/<name>/playbooks/*.yaml` — playbooks naming that template's own agents. Copied into `playbooksDir` at provision. This is the spec's answer to playbook-name coupling: the template unit keeps names consistent.

**New source**
- `src/onboarding/templates.ts` — template schemas (`orgTemplateSchema`), `listTemplates`, `loadTemplate`. Pure reads; a bad template is skipped, never thrown, so the gallery always renders.
- `src/onboarding/proposal.ts` — `OrgProposal` types + `templateToProposal`. The contract plan 2b's Architect targets.
- `src/onboarding/provision.ts` — `provision(proposal, deps)`. The one mutation path. All-or-nothing.

**Modified source**
- `src/web/agents-admin.ts` — extract `checkAgentBody` (shared core), add `validateProposalAgent` (allows exactly-one coordinator), add `validateDepartment` + `renderDepartmentYaml`. `validateHire`'s behaviour and error strings are unchanged.
- `src/onboarding/server.ts` — gains `agentsDir`/`playbooksDir`/`templatesDir` deps and four endpoints.
- `src/web/server.ts` — gains `POST /api/departments` for the running daemon (normal mode).
- `ui2/src/views/Setup.tsx` + `ui2/src/api.ts` — gallery, read-only review, provision progress.

**Modified tests**
- `test/fixtures/org/` — new committed fixture org (agents + playbooks) that becomes the suite's anchor, replacing the personal `agents/` tree.
- Seven files re-anchored onto it; `test/fixtures/org-golden.json` re-pinned once.

---

### Task 1: Relocate the capability catalog to product data

The catalog currently lives at `agents/_capabilities.yaml`. When `agents/` becomes user data (Task 13) the catalog would leave version control with it and no fresh install could validate a single capability. Move the file to `templates/_capabilities.yaml` and give the provisioner a seeder. The loader keeps reading it from `agentsDir` — that contract does not change; the provisioner just puts a copy there.

**Files:**
- Create: `templates/_capabilities.yaml` (git mv of `agents/_capabilities.yaml`)
- Create: `src/onboarding/seed.ts`
- Test: `test/onboarding-seed.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `seedCapabilities(agentsDir: string, templatesDir: string): boolean` — copies `<templatesDir>/_capabilities.yaml` to `<agentsDir>/_capabilities.yaml` when absent; returns `true` if it wrote, `false` if one was already there. Never overwrites: the user's catalog may carry hand-edits.

- [ ] **Step 1: Write the failing test**

```ts
// test/onboarding-seed.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedCapabilities } from "../src/onboarding/seed.js";

let agentsDir: string;
let templatesDir: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "seed-"));
  agentsDir = join(root, "agents");
  templatesDir = join(root, "templates");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(join(templatesDir, "_capabilities.yaml"), "reading: { tools: [Read] }\n");
});

describe("seedCapabilities", () => {
  it("copies the catalog into an agents dir that has none", () => {
    expect(seedCapabilities(agentsDir, templatesDir)).toBe(true);
    expect(readFileSync(join(agentsDir, "_capabilities.yaml"), "utf8")).toContain("reading");
  });

  it("never overwrites an existing catalog — it may carry hand-edits", () => {
    writeFileSync(join(agentsDir, "_capabilities.yaml"), "mine: { tools: [Glob] }\n");
    expect(seedCapabilities(agentsDir, templatesDir)).toBe(false);
    expect(readFileSync(join(agentsDir, "_capabilities.yaml"), "utf8")).toContain("mine");
  });

  it("creates the agents dir when it does not exist yet", () => {
    const fresh = join(agentsDir, "..", "brand-new");
    expect(existsSync(fresh)).toBe(false);
    expect(seedCapabilities(fresh, templatesDir)).toBe(true);
    expect(existsSync(join(fresh, "_capabilities.yaml"))).toBe(true);
  });

  it("throws a named error when the product catalog is missing", () => {
    expect(() => seedCapabilities(agentsDir, join(templatesDir, "nope")))
      .toThrow(/capability catalog missing/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onboarding-seed.test.ts`
Expected: FAIL — `Failed to resolve import "../src/onboarding/seed.js"`

- [ ] **Step 3: Move the catalog and write the seeder**

```bash
git mv agents/_capabilities.yaml templates/_capabilities.yaml
```

Then create the seeder:

```ts
// src/onboarding/seed.ts — the capability catalog is PRODUCT data, but the loader reads it from
// the user's agents dir. Provisioning a fresh install therefore has to plant a copy. Never
// overwrite: an existing catalog may carry the user's own capability edits.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const CAPABILITIES_FILE = "_capabilities.yaml";

export function seedCapabilities(agentsDir: string, templatesDir: string): boolean {
  const source = join(templatesDir, CAPABILITIES_FILE);
  if (!existsSync(source)) throw new Error(`capability catalog missing at ${source}`);
  mkdirSync(agentsDir, { recursive: true });
  const target = join(agentsDir, CAPABILITIES_FILE);
  if (existsSync(target)) return false;
  copyFileSync(source, target);
  return true;
}
```

- [ ] **Step 4: Restore the owner's catalog so the existing install keeps working**

The live daemon and the whole test suite read `agents/_capabilities.yaml`. The `git mv` removed it from disk. Put a copy back — untracked for now, tracked-as-user-data in Task 13:

```bash
cp templates/_capabilities.yaml agents/_capabilities.yaml
```

- [ ] **Step 5: Run the seeder test and the full suite**

Run: `npx vitest run test/onboarding-seed.test.ts`
Expected: PASS (4 tests)

Run: `npx vitest run`
Expected: Tests line reads 203 files / 1593 passing (the 4 new tests; everything else unchanged because `agents/_capabilities.yaml` is back on disk).

- [ ] **Step 6: Add templates dir to config**

Modify `src/config.ts`. Find the block near line 210 that sets `playbooksDir`/`agentsDir` and add a sibling:

```ts
    templatesDir: process.env.AIOS_TEMPLATES_DIR ?? join(root, "templates"),
```

Add the field to the config interface near line 13:

```ts
  templatesDir: string;
```

- [ ] **Step 7: Verify tsc is clean**

Run: `npx tsc --noEmit`
Expected: no output

- [ ] **Step 8: Commit**

```bash
git add templates/_capabilities.yaml src/onboarding/seed.ts test/onboarding-seed.test.ts src/config.ts
git commit -m "refactor(capabilities): relocate the catalog to product data

The loader reads _capabilities.yaml from the user's agents dir, but the
catalog itself is product data — it has to survive agents/ becoming user
data. Move it under templates/ and seed a copy at provision time."
```

---

### Task 2: Org template schema and loader

**Files:**
- Create: `src/onboarding/templates.ts`
- Test: `test/onboarding-templates.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `orgTemplateSchema` (zod) and `type OrgTemplate = z.infer<typeof orgTemplateSchema>`
  - `listTemplates(templatesDir: string, log?: (l: string) => void): Array<{ name: string; title: string; summary: string }>` — sorted by name; an unparseable template is logged and skipped, never thrown, because the gallery must always render.
  - `loadTemplate(templatesDir: string, name: string): OrgTemplate | undefined`
  - `templatePlaybookDir(templatesDir: string, name: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// test/onboarding-templates.test.ts
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
    expect(listTemplates(dir)).toEqual([{ name: "tiny", title: "Tiny Org", summary: "One coordinator and one worker." }]);
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
    expect(orgTemplateSchema.safeParse({ ...orgTemplateSchema.parse(loadTemplate(dir, "tiny")!), name: "Not Kebab" }).success)
      .toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onboarding-templates.test.ts`
Expected: FAIL — `Failed to resolve import "../src/onboarding/templates.js"`

- [ ] **Step 3: Write the implementation**

```ts
// src/onboarding/templates.ts — org templates (spec §5). A template is a complete org: departments,
// agents, and the playbooks its agents are named in. Product data, used three ways — the wizard
// gallery, few-shot grounding for the Architect (plan 2b), and a QA baseline so templates cannot rot.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const NAME = /^[a-z][a-z0-9-]*$/;

/** Mirrors agentSchema's user-authored fields. maxTurns/permissionMode/visibility are rendered
 *  by renderAgentYaml at provision time — a template does not get to set them. */
export const templateAgentSchema = z.object({
  name: z.string().regex(NAME),
  department: z.string().regex(NAME),
  kind: z.enum(["coordinator", "lead", "worker", "critic"]),
  title: z.string().min(1),
  charter: z.string().min(1),
  persona: z.string().min(1),
  prompt: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
});

export const templateDeptSchema = z.object({
  department: z.string().regex(NAME),
  mission: z.string().min(1),
  memoDomain: z.string().min(1),
  lead: z.string().regex(NAME).optional(),
  capabilities: z.array(z.string()).default([]),
  playbooks: z.array(z.string()).default([]),
});

export const orgTemplateSchema = z.object({
  name: z.string().regex(NAME),
  title: z.string().min(1),
  summary: z.string().min(1),
  /** Shown on the first-job card (plan 3); carried through the proposal so the Architect
   *  and the gallery produce the same shape. */
  firstJob: z.string().min(1),
  departments: z.array(templateDeptSchema).min(1),
  agents: z.array(templateAgentSchema).min(1),
});

export type OrgTemplate = z.infer<typeof orgTemplateSchema>;
export type TemplateAgent = z.infer<typeof templateAgentSchema>;
export type TemplateDept = z.infer<typeof templateDeptSchema>;

const orgsDir = (templatesDir: string) => join(templatesDir, "orgs");

export function templatePlaybookDir(templatesDir: string, name: string): string {
  return join(orgsDir(templatesDir), name, "playbooks");
}

export function loadTemplate(templatesDir: string, name: string): OrgTemplate | undefined {
  if (!NAME.test(name)) return undefined; // also blocks "..": this name reaches join()
  const file = join(orgsDir(templatesDir), name, "org.yaml");
  if (!existsSync(file)) return undefined;
  return orgTemplateSchema.parse(parse(readFileSync(file, "utf8")));
}

/** Gallery rows. A broken template is logged and skipped — one bad file must never blank the
 *  gallery, which is the wizard's escape hatch when everything else has gone wrong. */
export function listTemplates(
  templatesDir: string, log: (l: string) => void = () => {},
): Array<{ name: string; title: string; summary: string }> {
  const root = orgsDir(templatesDir);
  if (!existsSync(root)) return [];
  const out: Array<{ name: string; title: string; summary: string }> = [];
  for (const name of readdirSync(root).sort()) {
    try {
      if (!statSync(join(root, name)).isDirectory()) continue;
      const t = loadTemplate(templatesDir, name);
      if (!t) continue;
      out.push({ name: t.name, title: t.title, summary: t.summary });
    } catch (err) {
      log(`org template ${name} skipped: ${(err as Error).message}`);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/onboarding-templates.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/templates.ts test/onboarding-templates.test.ts
git commit -m "feat(onboarding): org template schema and loader

A template is a complete org — departments, agents, and its own playbooks.
A broken one is skipped, never thrown: the gallery is the wizard's escape
hatch and must render even when a template file is bad."
```

---

### Task 3: Department validator and renderer

`validateHire` refuses agents in unknown departments, so provisioning has to create departments first. This is the mutation the spec calls out as the one new validated path.

Two rules that are easy to miss and both come straight from the loader:
- A department naming a playbook the loader cannot find is **silently skipped at load** (loader.ts:141-144) — the org would come up missing a whole department with no error. Validate playbook existence up front.
- The department dir name must equal the `department:` field (loader.ts:136), which the writer guarantees by construction.

**Files:**
- Modify: `src/web/agents-admin.ts` (append after `validateHire`/`renderAgentYaml`)
- Test: `test/agents-admin-departments.test.ts`

**Interfaces:**
- Consumes: `LoadedRegistry` from `src/agents/registry/loader.js`.
- Produces:
  - `interface DepartmentBody { department: string; mission: string; memoDomain: string; lead?: string; capabilities: string[]; playbooks: string[] }`
  - `validateDepartment(body: unknown, registry: LoadedRegistry, opts?: { knownPlaybooks?: Set<string>; leadPending?: boolean }): { ok: true; manifest: DepartmentBody } | { ok: false; error: string }`
  - `renderDepartmentYaml(m: DepartmentBody): string`

- [ ] **Step 1: Write the failing test**

```ts
// test/agents-admin-departments.test.ts
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { validateDepartment, renderDepartmentYaml } from "../src/web/agents-admin.js";
import { departmentSchema } from "../src/agents/registry/types.js";
import type { LoadedRegistry } from "../src/agents/registry/loader.js";

function reg(over: Partial<LoadedRegistry> = {}): LoadedRegistry {
  return {
    agents: new Map(), departments: new Map(), agentOf: new Map(),
    ownerOfPlaybook: new Map(), playbooks: new Map(),
    capabilities: new Map([["reading", { tools: ["Read"] }]]),
    coordinator: "", ...over,
  } as unknown as LoadedRegistry;
}

const body = { department: "studio", mission: "Make things.", memoDomain: "studio", capabilities: ["reading"], playbooks: [] };

describe("validateDepartment", () => {
  it("accepts a well-formed department", () => {
    const v = validateDepartment(body, reg());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.manifest.department).toBe("studio");
  });

  it("rejects a non-kebab name", () => {
    const v = validateDepartment({ ...body, department: "Studio One" }, reg());
    expect(v).toEqual({ ok: false, error: "department must match ^[a-z][a-z0-9-]*$" });
  });

  it("rejects a department that already exists", () => {
    const v = validateDepartment(body, reg({ departments: new Map([["studio", {} as never]]) }));
    expect(v).toEqual({ ok: false, error: 'department "studio" already exists' });
  });

  it("requires mission and memoDomain", () => {
    expect(validateDepartment({ ...body, mission: "  " }, reg())).toEqual({ ok: false, error: "mission required" });
    expect(validateDepartment({ ...body, memoDomain: "" }, reg())).toEqual({ ok: false, error: "memoDomain required" });
  });

  it("rejects an unknown capability", () => {
    const v = validateDepartment({ ...body, capabilities: ["telepathy"] }, reg());
    expect(v).toEqual({ ok: false, error: 'unknown capability "telepathy"' });
  });

  it("rejects a playbook the loader could not find — the department would be silently skipped", () => {
    const v = validateDepartment({ ...body, playbooks: ["ghost"] }, reg());
    expect(v).toEqual({ ok: false, error: 'unknown playbook "ghost"' });
  });

  it("accepts a playbook supplied by the caller's known-set (about to be copied in)", () => {
    const v = validateDepartment({ ...body, playbooks: ["ghost"] }, reg(), { knownPlaybooks: new Set(["ghost"]) });
    expect(v.ok).toBe(true);
  });

  it("rejects a lead who is not a registered agent", () => {
    const v = validateDepartment({ ...body, lead: "nobody" }, reg());
    expect(v).toEqual({ ok: false, error: 'lead "nobody" is not a registered agent' });
  });

  it("allows a not-yet-written lead when the caller says the lead is pending", () => {
    const v = validateDepartment({ ...body, lead: "nobody" }, reg(), { leadPending: true });
    expect(v.ok).toBe(true);
  });

  it("rejects a body that is not an object", () => {
    expect(validateDepartment(null, reg())).toEqual({ ok: false, error: "body required" });
  });
});

describe("renderDepartmentYaml", () => {
  it("round-trips through departmentSchema", () => {
    const yaml = renderDepartmentYaml({
      department: "studio", mission: "Make things that ship.", memoDomain: "studio",
      lead: "scribe", capabilities: ["reading"], playbooks: ["starter-brief"],
    });
    const parsed = departmentSchema.parse(parse(yaml));
    expect(parsed.department).toBe("studio");
    expect(parsed.lead).toBe("scribe");
    expect(parsed.capabilities).toEqual(["reading"]);
    expect(parsed.playbooks).toEqual(["starter-brief"]);
    expect(parsed.vaultSection).toBe("studio"); // schema transform defaults it
  });

  it("omits lead entirely when there is none", () => {
    const yaml = renderDepartmentYaml({
      department: "studio", mission: "Make things.", memoDomain: "studio", capabilities: [], playbooks: [],
    });
    expect(yaml).not.toContain("lead:");
    expect(departmentSchema.parse(parse(yaml)).lead).toBeUndefined();
  });

  it("keeps a multi-line mission readable and parseable", () => {
    const yaml = renderDepartmentYaml({
      department: "studio", mission: "Line one.\n\nLine two.", memoDomain: "studio", capabilities: [], playbooks: [],
    });
    expect(departmentSchema.parse(parse(yaml)).mission).toContain("Line one.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents-admin-departments.test.ts`
Expected: FAIL — `validateDepartment is not a function` (no such export)

- [ ] **Step 3: Write the implementation**

Append to `src/web/agents-admin.ts`:

```ts
export interface DepartmentBody {
  department: string; mission: string; memoDomain: string;
  lead?: string; capabilities: string[]; playbooks: string[];
}

/**
 * The one new validated mutation onboarding needs (spec §4). Two rules come straight from the
 * loader: a department whose playbook is missing is SILENTLY SKIPPED at load (loader.ts:141) —
 * the org would come up short a department with no error anywhere — and the dir name must equal
 * the `department:` field, which the writer guarantees.
 *
 * `leadPending` is for provisioning, where the lead agent is written after its department.
 * `knownPlaybooks` is for provisioning too: template playbooks are copied in, so they are not
 * in the registry yet when the department is validated.
 */
export function validateDepartment(
  body: unknown, registry: LoadedRegistry,
  opts: { knownPlaybooks?: Set<string>; leadPending?: boolean } = {},
): { ok: true; manifest: DepartmentBody } | { ok: false; error: string } {
  const b = body as Partial<DepartmentBody> | null;
  const fail = (error: string) => ({ ok: false as const, error });
  if (!b || typeof b !== "object") return fail("body required");
  if (typeof b.department !== "string" || !NAME_RE.test(b.department)) {
    return fail("department must match ^[a-z][a-z0-9-]*$");
  }
  if (registry.departments.has(b.department)) return fail(`department "${b.department}" already exists`);
  for (const f of ["mission", "memoDomain"] as const) {
    if (typeof b[f] !== "string" || !b[f]!.trim()) return fail(`${f} required`);
  }
  const capabilities = b.capabilities ?? [];
  if (!Array.isArray(capabilities)) return fail("capabilities must be an array");
  for (const c of capabilities) {
    if (typeof c !== "string" || !registry.capabilities.has(c)) return fail(`unknown capability "${String(c)}"`);
  }
  const playbooks = b.playbooks ?? [];
  if (!Array.isArray(playbooks)) return fail("playbooks must be an array");
  for (const p of playbooks) {
    if (typeof p !== "string" || !(registry.playbooks.has(p) || opts.knownPlaybooks?.has(p))) {
      return fail(`unknown playbook "${String(p)}"`);
    }
  }
  if (b.lead !== undefined) {
    if (typeof b.lead !== "string" || !NAME_RE.test(b.lead)) return fail("lead must match ^[a-z][a-z0-9-]*$");
    if (!opts.leadPending && !registry.agentOf.has(b.lead)) {
      return fail(`lead "${b.lead}" is not a registered agent`);
    }
  }
  const { department, mission, memoDomain, lead } = b as DepartmentBody;
  return { ok: true, manifest: { department, mission, memoDomain, ...(lead ? { lead } : {}), capabilities, playbooks } };
}

export function renderDepartmentYaml(m: DepartmentBody): string {
  return [
    `department: ${m.department}`,
    `mission: ${block(m.mission)}`,
    ...(m.lead ? [`lead: ${m.lead}`] : []),
    `memoDomain: ${m.memoDomain}`,
    `capabilities: [${m.capabilities.join(", ")}]`,
    `playbooks: [${m.playbooks.join(", ")}]`,
    "",
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/agents-admin-departments.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Confirm the existing admin tests still pass**

Run: `npx vitest run test/agents-admin.test.ts`
Expected: PASS — `validateHire` untouched

- [ ] **Step 6: Commit**

```bash
git add src/web/agents-admin.ts test/agents-admin-departments.test.ts
git commit -m "feat(agents-admin): department validator and renderer

Provisioning needs departments before agents, and the loader silently
skips a department whose playbook is missing — so playbook existence is
validated up front rather than discovered as an absent department."
```

---

### Task 4: `validateProposalAgent` — the coordinator-allowing sibling

`validateHire` refuses `kind: coordinator` on purpose: you cannot hire a second coordinator into a live org. But a *new* org must contain exactly one, and `loadRegistry` throws if any agent loads without one (loader.ts:194). Provisioning therefore needs a sibling validator that shares every other rule. Extract the common core so the two can never drift.

**Files:**
- Modify: `src/web/agents-admin.ts:18-48`
- Test: `test/agents-admin.test.ts` (append)

**Interfaces:**
- Consumes: `LoadedRegistry`.
- Produces: `validateProposalAgent(body: unknown, registry: LoadedRegistry, opts?: { taken?: Set<string>; knownDepartments?: Set<string> }): { ok: true; manifest: ProposalAgentBody } | { ok: false; error: string }` where `ProposalAgentBody = HireBody & { kind: "coordinator" | "lead" | "worker" | "critic"; skills: string[] }`.
- `validateHire`'s signature, behaviour, and error strings are unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/agents-admin.test.ts`:

```ts
describe("validateProposalAgent", () => {
  it("accepts a coordinator, which validateHire refuses", () => {
    const body = {
      name: "nova", department: "operations", kind: "coordinator", title: "Coordinator",
      charter: "Route work.", persona: "Brief.", prompt: "You route requests.", capabilities: [],
    };
    expect(validateHire(body, registry).ok).toBe(false);
    const v = validateProposalAgent(body, registry, { knownDepartments: new Set(["operations"]) });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.manifest.kind).toBe("coordinator");
  });

  it("accepts a department that is about to be written but is not in the registry yet", () => {
    const body = {
      name: "scribe", department: "studio", kind: "lead", title: "Writer",
      charter: "Write.", persona: "Plain.", prompt: "You write drafts.", capabilities: [],
    };
    expect(validateProposalAgent(body, registry).ok).toBe(false);
    expect(validateProposalAgent(body, registry, { knownDepartments: new Set(["studio"]) }).ok).toBe(true);
  });

  it("rejects a name already taken by a sibling in the same proposal", () => {
    const body = {
      name: "scribe", department: "studio", kind: "lead", title: "Writer",
      charter: "Write.", persona: "Plain.", prompt: "You write drafts.", capabilities: [],
    };
    const v = validateProposalAgent(body, registry, {
      knownDepartments: new Set(["studio"]), taken: new Set(["scribe"]),
    });
    expect(v).toEqual({ ok: false, error: 'name "scribe" is taken (agent or alias)' });
  });

  it("carries skills through and defaults them to an empty array", () => {
    const base = {
      name: "scout", department: "studio", kind: "worker", title: "Researcher",
      charter: "Research.", persona: "Curious.", prompt: "You research topics.", capabilities: [],
    };
    const opts = { knownDepartments: new Set(["studio"]) };
    const withSkills = validateProposalAgent({ ...base, skills: ["market-sizing"] }, registry, opts);
    expect(withSkills.ok && withSkills.manifest.skills).toEqual(["market-sizing"]);
    const without = validateProposalAgent(base, registry, opts);
    expect(without.ok && without.manifest.skills).toEqual([]);
  });

  it("still enforces the department capability wall", () => {
    const v = validateProposalAgent({
      name: "helper", department: "life", kind: "worker", title: "Helper",
      charter: "Help.", persona: "Kind.", prompt: "You help.", capabilities: ["vault-write"],
    }, registry, { knownDepartments: new Set(["life"]) });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("capability wall");
  });
});
```

Update the import at the top of the file to include the new export:

```ts
import { validateHire, validateProposalAgent, renderAgentYaml, retireBlockers, listRetired, validateRehire } from "../src/web/agents-admin.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents-admin.test.ts`
Expected: FAIL — `validateProposalAgent is not a function`

- [ ] **Step 3: Refactor `validateHire` into a shared core and add the sibling**

Replace `src/web/agents-admin.ts:18-48` with:

```ts
export interface ProposalAgentBody extends Omit<HireBody, "kind"> {
  kind: "coordinator" | "lead" | "worker" | "critic";
  skills: string[];
}

interface CheckOpts {
  /** Coordinator is refusable for hiring into a live org, required when creating a new one. */
  allowCoordinator?: boolean;
  /** Names claimed by siblings in the same proposal — not yet in the registry. */
  taken?: Set<string>;
  /** Departments about to be written — not yet in the registry. */
  knownDepartments?: Set<string>;
}

/** Shared core. validateHire and validateProposalAgent differ only in the coordinator rule and
 *  in what they treat as "already exists"; everything else must never drift between them. */
function checkAgentBody(
  body: unknown, registry: LoadedRegistry, opts: CheckOpts,
): { ok: true; manifest: ProposalAgentBody } | { ok: false; error: string } {
  const b = body as Partial<ProposalAgentBody> | null;
  const fail = (error: string) => ({ ok: false as const, error });
  if (!b || typeof b !== "object") return fail("body required");
  if (typeof b.name !== "string" || !NAME_RE.test(b.name)) return fail("name must match ^[a-z][a-z0-9-]*$");
  if (registry.agentOf.has(b.name) || opts.taken?.has(b.name)) {
    return fail(`name "${b.name}" is taken (agent or alias)`);
  }
  if (typeof b.department !== "string"
    || !(registry.departments.has(b.department) || opts.knownDepartments?.has(b.department))) {
    return fail(`unknown department "${String(b.department)}"`);
  }
  const kinds = opts.allowCoordinator ? ALL_KINDS : KINDS;
  if (typeof b.kind !== "string" || !kinds.has(b.kind)) {
    return fail(opts.allowCoordinator
      ? "kind must be coordinator|lead|worker|critic"
      : "kind must be lead|worker|critic (coordinator cannot be hired)");
  }
  for (const f of ["title", "charter", "persona", "prompt"] as const) {
    if (typeof b[f] !== "string" || !b[f]!.trim()) return fail(`${f} required`);
  }
  if (!Array.isArray(b.capabilities)) return fail("capabilities must be an array");
  for (const c of b.capabilities) {
    if (typeof c !== "string" || !registry.capabilities.has(c)) return fail(`unknown capability "${String(c)}"`);
  }
  const skills = b.skills ?? [];
  if (!Array.isArray(skills) || skills.some((s) => typeof s !== "string")) {
    return fail("skills must be an array of strings");
  }
  // Dept privacy wall: validate the tool surface the loader will actually grant (dept ∪ requested
  // caps). A department being written in this same proposal contributes no defaults yet — its
  // own capabilities are validated separately by validateDepartment.
  const dept = registry.departments.get(b.department);
  const capNames = [...new Set([...(dept?.capabilities ?? []), ...(b.capabilities as string[])])];
  const violations = deptWallViolations(b.department, toolsFromCaps(registry.capabilities, capNames));
  if (violations.length > 0) {
    return fail(`capability wall: ${b.department} department agents may not carry ${violations.join(", ")}`);
  }
  const { name, department, kind, title, charter, persona, prompt, capabilities } = b as ProposalAgentBody;
  return { ok: true, manifest: { name, department, kind, title, charter, persona, prompt, capabilities, skills } };
}

export function validateHire(
  body: unknown, registry: LoadedRegistry,
): { ok: true; manifest: HireBody } | { ok: false; error: string } {
  const v = checkAgentBody(body, registry, {});
  if (!v.ok) return v;
  const { skills: _skills, ...rest } = v.manifest;
  return { ok: true, manifest: rest as HireBody };
}

/** Provisioning path (spec §4): a new org must contain exactly one coordinator, and its agents
 *  reference departments and siblings that are being written in the same pass. */
export function validateProposalAgent(
  body: unknown, registry: LoadedRegistry,
  opts: { taken?: Set<string>; knownDepartments?: Set<string> } = {},
): { ok: true; manifest: ProposalAgentBody } | { ok: false; error: string } {
  return checkAgentBody(body, registry, { ...opts, allowCoordinator: true });
}
```

Add the second kind-set next to the existing one near line 16:

```ts
const KINDS = new Set(["lead", "worker", "critic"]);
const ALL_KINDS = new Set(["coordinator", "lead", "worker", "critic"]);
```

Extend `renderAgentYaml` to carry skills and to accept a coordinator. `HireBody["kind"]` stays `"lead" | "worker" | "critic"` — widening it would let a coordinator through `validateHire`'s type — so the renderer takes the kind as a plain string instead. Emit `skills:` only when non-empty; an empty `skills: []` is the schema default and would add noise to every hired agent's file. Replace the whole function with:

```ts
export function renderAgentYaml(m: Omit<HireBody, "kind"> & { kind: string; skills?: string[] }): string {
  return [
    `name: ${m.name}`,
    `title: ${JSON.stringify(m.title)}`,
    `department: ${m.department}`,
    `charter: ${block(m.charter)}`,
    `persona: ${block(m.persona)}`,
    `prompt: ${block(m.prompt)}`,
    "maxTurns: 25",
    "permissionMode: dontAsk",
    `kind: ${m.kind}`,
    `capabilities: [${m.capabilities.join(", ")}]`,
    ...(m.skills?.length ? [`skills: [${m.skills.join(", ")}]`] : []),
    "",
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/agents-admin.test.ts test/agents-admin-departments.test.ts`
Expected: PASS — every pre-existing `validateHire` assertion still green (the shared core preserves its error strings)

- [ ] **Step 5: Run the full suite and tsc**

Run: `npx vitest run`
Expected: Tests line shows the prior count plus the new department/proposal tests; **no pre-existing failures**

Run: `npx tsc --noEmit`
Expected: no output

- [ ] **Step 6: Commit**

```bash
git add src/web/agents-admin.ts test/agents-admin.test.ts
git commit -m "feat(agents-admin): coordinator-allowing validator for provisioning

validateHire refuses coordinators on purpose — you cannot hire a second
one into a live org. A NEW org must contain exactly one, and loadRegistry
throws without it. Extract the shared core so the two validators cannot
drift, and let the proposal path see siblings and departments that are
being written in the same pass."
```

---

### Task 5: OrgProposal contract and `templateToProposal`

The proposal is the seam between "where an org came from" (template now, Architect in plan 2b) and "how an org lands" (the provisioner). Defining it now means plan 2b writes a schema against a fixed target instead of the provisioner chasing the Architect.

**Files:**
- Create: `src/onboarding/proposal.ts`
- Test: `test/onboarding-proposal.test.ts`

**Interfaces:**
- Consumes: `OrgTemplate`, `TemplateAgent`, `TemplateDept` from Task 2.
- Produces:
  - `interface ProposalDept { department: string; mission: string; memoDomain: string; lead?: string; capabilities: string[]; playbooks: string[] }`
  - `interface ProposalAgent { name: string; department: string; kind: "coordinator" | "lead" | "worker" | "critic"; title: string; charter: string; persona: string; prompt: string; capabilities: string[]; skills: string[] }`
  - `interface OrgProposal { source: { kind: "template"; template: string } | { kind: "interview" }; departments: ProposalDept[]; agents: ProposalAgent[]; firstJob: string }`
  - `templateToProposal(t: OrgTemplate): OrgProposal`
  - `proposalShape(p: unknown): { ok: true; proposal: OrgProposal } | { ok: false; error: string }` — structural gate before any per-item validation, so a garbage body cannot reach the filesystem code.

- [ ] **Step 1: Write the failing test**

```ts
// test/onboarding-proposal.test.ts
import { describe, it, expect } from "vitest";
import { templateToProposal, proposalShape } from "../src/onboarding/proposal.js";
import type { OrgTemplate } from "../src/onboarding/templates.js";

const tpl: OrgTemplate = {
  name: "tiny", title: "Tiny", summary: "Small.", firstJob: "Say hello.",
  departments: [{ department: "operations", mission: "Front door.", memoDomain: "general", lead: "nova", capabilities: [], playbooks: [] }],
  agents: [{
    name: "nova", department: "operations", kind: "coordinator", title: "Coordinator",
    charter: "Route.", persona: "Brief.", prompt: "You route.", capabilities: ["coordination"], skills: [],
  }],
};

describe("templateToProposal", () => {
  it("carries the template through and records its source", () => {
    const p = templateToProposal(tpl);
    expect(p.source).toEqual({ kind: "template", template: "tiny" });
    expect(p.departments[0].department).toBe("operations");
    expect(p.agents[0].kind).toBe("coordinator");
    expect(p.firstJob).toBe("Say hello.");
  });
});

describe("proposalShape", () => {
  it("accepts a proposal produced from a template", () => {
    expect(proposalShape(templateToProposal(tpl)).ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(proposalShape(null)).toEqual({ ok: false, error: "proposal must be an object" });
    expect(proposalShape("nope")).toEqual({ ok: false, error: "proposal must be an object" });
  });

  it("requires at least one department and one agent", () => {
    const p = templateToProposal(tpl);
    expect(proposalShape({ ...p, departments: [] })).toEqual({ ok: false, error: "proposal needs at least one department" });
    expect(proposalShape({ ...p, agents: [] })).toEqual({ ok: false, error: "proposal needs at least one agent" });
  });

  it("requires exactly one coordinator — loadRegistry throws otherwise", () => {
    const p = templateToProposal(tpl);
    const worker = { ...p.agents[0], name: "scout", kind: "worker" as const };
    expect(proposalShape({ ...p, agents: [worker] }))
      .toEqual({ ok: false, error: "proposal needs exactly one coordinator, found 0" });
    expect(proposalShape({ ...p, agents: [p.agents[0], { ...p.agents[0], name: "nova2" }] }))
      .toEqual({ ok: false, error: "proposal needs exactly one coordinator, found 2" });
  });

  it("rejects duplicate agent names inside the proposal", () => {
    const p = templateToProposal(tpl);
    const dup = { ...p.agents[0], kind: "worker" as const };
    expect(proposalShape({ ...p, agents: [p.agents[0], dup] }))
      .toEqual({ ok: false, error: 'duplicate agent name "nova" in proposal' });
  });

  it("rejects duplicate department names inside the proposal", () => {
    const p = templateToProposal(tpl);
    expect(proposalShape({ ...p, departments: [p.departments[0], p.departments[0]] }))
      .toEqual({ ok: false, error: 'duplicate department "operations" in proposal' });
  });

  it("rejects an agent whose department is in neither the proposal nor anywhere else", () => {
    const p = templateToProposal(tpl);
    expect(proposalShape({ ...p, agents: [{ ...p.agents[0], department: "ghost" }] }))
      .toEqual({ ok: false, error: 'agent "nova" names department "ghost", which the proposal does not create' });
  });

  it("requires a non-empty firstJob", () => {
    const p = templateToProposal(tpl);
    expect(proposalShape({ ...p, firstJob: "  " })).toEqual({ ok: false, error: "firstJob required" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onboarding-proposal.test.ts`
Expected: FAIL — `Failed to resolve import "../src/onboarding/proposal.js"`

- [ ] **Step 3: Write the implementation**

```ts
// src/onboarding/proposal.ts — the seam between where an org comes from and how it lands.
// A template produces one of these today; the Org Architect will produce the same shape in
// plan 2b. The provisioner only ever sees an OrgProposal, so neither source can special-case it.
import type { OrgTemplate } from "./templates.js";

export interface ProposalDept {
  department: string; mission: string; memoDomain: string;
  lead?: string; capabilities: string[]; playbooks: string[];
}

export interface ProposalAgent {
  name: string; department: string;
  kind: "coordinator" | "lead" | "worker" | "critic";
  title: string; charter: string; persona: string; prompt: string;
  capabilities: string[]; skills: string[];
}

export interface OrgProposal {
  source: { kind: "template"; template: string } | { kind: "interview" };
  departments: ProposalDept[];
  agents: ProposalAgent[];
  /** Suggested first job — shown as the one-click card on the first-job step (plan 3). */
  firstJob: string;
}

export function templateToProposal(t: OrgTemplate): OrgProposal {
  return {
    source: { kind: "template", template: t.name },
    departments: t.departments.map((d) => ({
      department: d.department, mission: d.mission, memoDomain: d.memoDomain,
      ...(d.lead ? { lead: d.lead } : {}), capabilities: d.capabilities, playbooks: d.playbooks,
    })),
    agents: t.agents.map((a) => ({
      name: a.name, department: a.department, kind: a.kind, title: a.title,
      charter: a.charter, persona: a.persona, prompt: a.prompt,
      capabilities: a.capabilities, skills: a.skills,
    })),
    firstJob: t.firstJob,
  };
}

/**
 * Structural gate: whole-proposal invariants that per-item validators cannot see, checked before
 * anything touches disk. The coordinator rule is the load-bearing one — loadRegistry throws when
 * agents load without exactly one (loader.ts:194), which would leave a written-but-unloadable org.
 */
export function proposalShape(p: unknown): { ok: true; proposal: OrgProposal } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!p || typeof p !== "object" || Array.isArray(p)) return fail("proposal must be an object");
  const c = p as Partial<OrgProposal>;
  if (!Array.isArray(c.departments) || c.departments.length === 0) return fail("proposal needs at least one department");
  if (!Array.isArray(c.agents) || c.agents.length === 0) return fail("proposal needs at least one agent");
  if (typeof c.firstJob !== "string" || !c.firstJob.trim()) return fail("firstJob required");

  const depts = new Set<string>();
  for (const d of c.departments) {
    if (!d || typeof d.department !== "string") return fail("every department needs a name");
    if (depts.has(d.department)) return fail(`duplicate department "${d.department}" in proposal`);
    depts.add(d.department);
  }
  const names = new Set<string>();
  let coordinators = 0;
  for (const a of c.agents) {
    if (!a || typeof a.name !== "string") return fail("every agent needs a name");
    if (names.has(a.name)) return fail(`duplicate agent name "${a.name}" in proposal`);
    names.add(a.name);
    if (!depts.has(a.department)) {
      return fail(`agent "${a.name}" names department "${a.department}", which the proposal does not create`);
    }
    if (a.kind === "coordinator") coordinators++;
  }
  if (coordinators !== 1) return fail(`proposal needs exactly one coordinator, found ${coordinators}`);
  return { ok: true, proposal: c as OrgProposal };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/onboarding-proposal.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/proposal.ts test/onboarding-proposal.test.ts
git commit -m "feat(onboarding): OrgProposal contract and template conversion

The proposal is the seam between where an org comes from (template now,
Architect next) and how it lands. proposalShape checks the whole-proposal
invariants per-item validators cannot see — above all exactly one
coordinator, without which loadRegistry throws on a written org."
```

---

### Task 6: The provisioner

The one mutation path. Three hard constraints shape it:

1. **Write everything, then reload once.** A lone non-coordinator agent is an invalid registry, so there is no valid intermediate state to reload into.
2. **Playbooks first.** A department naming a not-yet-copied playbook would be skipped at load.
3. **Compensate on any failure.** Delete every file and directory this call created, in reverse order.

**Files:**
- Create: `src/onboarding/provision.ts`
- Test: `test/onboarding-provision.test.ts`

**Interfaces:**
- Consumes: `OrgProposal`/`proposalShape` (Task 5), `validateDepartment`/`renderDepartmentYaml`/`validateProposalAgent`/`renderAgentYaml` (Tasks 3-4), `seedCapabilities` (Task 1), `templatePlaybookDir` (Task 2).
- Produces:
  - `interface ProvisionDeps { agentsDir: string; playbooksDir: string; templatesDir: string; loadRegistry: (agentsDir: string, playbooksDir: string) => LoadedRegistry; log?: (l: string) => void }`
  - `interface ProposalError { scope: "proposal" | "department" | "agent"; name?: string; error: string }`
  - `provision(proposal: OrgProposal, deps: ProvisionDeps): { ok: true; departments: string[]; agents: string[]; playbooks: string[] } | { ok: false; errors: ProposalError[] }`

- [ ] **Step 1: Write the failing test**

```ts
// test/onboarding-provision.test.ts
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
    const boom = () => { throw new Error("reload exploded"); };
    let calls = 0;
    const r = provision(proposal(), {
      ...deps(),
      // First call is the baseline read; the final verification reload is the one that fails.
      loadRegistry: (a: string, p: string) => (++calls === 1 ? loadRegistry(a, p) : boom()),
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onboarding-provision.test.ts`
Expected: FAIL — `Failed to resolve import "../src/onboarding/provision.js"`

- [ ] **Step 3: Write the implementation**

```ts
// src/onboarding/provision.ts — the one mutation path from proposal to a live org (spec §4).
//
// Three constraints shape this, all from the loader:
//   1. WRITE EVERYTHING, THEN RELOAD ONCE. A lone non-coordinator agent is an invalid registry
//      (loader.ts:194), so there is no valid intermediate state to reload into.
//   2. PLAYBOOKS FIRST. A department naming a playbook the loader cannot find is silently
//      skipped (loader.ts:141), so the org would come up short a department with no error.
//   3. COMPENSATE ON ANY FAILURE. Delete everything this call created, newest first, so a
//      rejected proposal leaves the disk exactly as it found it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import {
  renderAgentYaml, renderDepartmentYaml, validateDepartment, validateProposalAgent,
} from "../web/agents-admin.js";
import { proposalShape, type OrgProposal } from "./proposal.js";
import { seedCapabilities } from "./seed.js";
import { templatePlaybookDir } from "./templates.js";

export interface ProvisionDeps {
  agentsDir: string;
  playbooksDir: string;
  templatesDir: string;
  /** Injected so a test can make the verification reload fail and prove compensation. */
  loadRegistry: (agentsDir: string, playbooksDir: string) => LoadedRegistry;
  log?: (l: string) => void;
}

export interface ProposalError {
  scope: "proposal" | "department" | "agent";
  name?: string;
  error: string;
}

export type ProvisionResult =
  | { ok: true; departments: string[]; agents: string[]; playbooks: string[] }
  | { ok: false; errors: ProposalError[] };

export function provision(proposal: OrgProposal, deps: ProvisionDeps): ProvisionResult {
  const log = deps.log ?? (() => {});
  const shape = proposalShape(proposal);
  if (!shape.ok) return { ok: false, errors: [{ scope: "proposal", error: shape.error }] };

  seedCapabilities(deps.agentsDir, deps.templatesDir);
  const before = deps.loadRegistry(deps.agentsDir, deps.playbooksDir);

  // Everything this call creates, so compensation can be exact. Reverse order on unwind:
  // files before the directories that hold them.
  const files: string[] = [];
  const dirs: string[] = [];
  const undo = (): void => {
    for (const f of [...files].reverse()) if (existsSync(f)) unlinkSync(f);
    for (const d of [...dirs].reverse()) if (existsSync(d) && readdirSync(d).length === 0) rmdirSync(d);
  };

  // --- Playbooks first (constraint 2). Names the install already has win: an existing playbook
  // is the user's, and clobbering it would rewire jobs they already run.
  const playbooks: string[] = [];
  if (proposal.source.kind === "template") {
    const from = templatePlaybookDir(deps.templatesDir, proposal.source.template);
    if (existsSync(from)) {
      mkdirSync(deps.playbooksDir, { recursive: true });
      for (const f of readdirSync(from).filter((n) => /\.ya?ml$/.test(n))) {
        const target = join(deps.playbooksDir, f);
        if (existsSync(target)) { log(`playbook ${f} already present — kept`); continue; }
        copyFileSync(join(from, f), target);
        files.push(target);
        playbooks.push(f.replace(/\.ya?ml$/, ""));
      }
    }
  }

  // --- Validate departments. Leads are pending (their agents are written after) and the
  // just-copied playbooks are not in `before` yet.
  const known = new Set([...before.playbooks.keys(), ...playbooks]);
  const errors: ProposalError[] = [];
  for (const d of proposal.departments) {
    const v = validateDepartment(d, before, { knownPlaybooks: known, leadPending: true });
    if (!v.ok) errors.push({ scope: "department", name: d.department, error: v.error });
  }

  // --- Validate agents against the departments this proposal creates plus whatever exists.
  const knownDepartments = new Set([...before.departments.keys(), ...proposal.departments.map((d) => d.department)]);
  const taken = new Set<string>();
  for (const a of proposal.agents) {
    const v = validateProposalAgent(a, before, { knownDepartments, taken });
    if (!v.ok) errors.push({ scope: "agent", name: a.name, error: v.error });
    else taken.add(a.name);
  }
  if (errors.length) { undo(); return { ok: false, errors }; }

  // --- Write. Departments then agents; nothing is loaded until all of it is on disk.
  try {
    for (const d of proposal.departments) {
      const dir = join(deps.agentsDir, d.department);
      if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); dirs.push(dir); }
      const file = join(dir, "department.yaml");
      writeFileSync(file, renderDepartmentYaml({
        department: d.department, mission: d.mission, memoDomain: d.memoDomain,
        ...(d.lead ? { lead: d.lead } : {}), capabilities: d.capabilities, playbooks: d.playbooks,
      }));
      files.push(file);
    }
    for (const a of proposal.agents) {
      const file = join(deps.agentsDir, a.department, `${a.name}.yaml`);
      writeFileSync(file, renderAgentYaml(a));
      files.push(file);
    }
    // Constraint 1: the single reload that proves the whole org is loadable.
    deps.loadRegistry(deps.agentsDir, deps.playbooksDir);
  } catch (err) {
    undo();
    return { ok: false, errors: [{ scope: "proposal", error: `provision failed: ${(err as Error).message}` }] };
  }

  log(`provisioned ${proposal.departments.length} departments, ${proposal.agents.length} agents`);
  return {
    ok: true,
    departments: proposal.departments.map((d) => d.department),
    agents: proposal.agents.map((a) => a.name),
    playbooks,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/onboarding-provision.test.ts`
Expected: PASS (9 tests)

The "refuses to provision into an agents dir that already has an org" case passes through `validateDepartment`'s `department "operations" already exists`.

- [ ] **Step 5: Verify tsc is clean**

Run: `npx tsc --noEmit`
Expected: no output

- [ ] **Step 6: Commit**

```bash
git add src/onboarding/provision.ts test/onboarding-provision.test.ts
git commit -m "feat(onboarding): proposal provisioner with all-or-nothing writes

Playbooks first (a department naming a missing playbook is silently
skipped at load), then departments, then agents, then a single reload —
a lone non-coordinator agent is an invalid registry, so there is no valid
intermediate state to reload into. Any failure deletes what it wrote."
```

---

### Task 7: The starter template

**Files:**
- Create: `templates/orgs/starter/org.yaml`
- Create: `templates/orgs/starter/playbooks/starter-brief.yaml`
- Test: `test/onboarding-templates-live.test.ts`

**Interfaces:**
- Consumes: `loadTemplate`, `templateToProposal`, `provision`.
- Produces: the `starter` template. Later tasks add four siblings and the golden test that provisions all of them.

- [ ] **Step 1: Write the failing test**

```ts
// test/onboarding-templates-live.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { listTemplates, loadTemplate } from "../src/onboarding/templates.js";
import { templateToProposal } from "../src/onboarding/proposal.js";
import { provision } from "../src/onboarding/provision.js";
import { loadRegistry } from "../src/agents/registry/loader.js";

const templatesDir = join(process.cwd(), "templates");

describe("shipped templates", () => {
  it("ships the starter template", () => {
    expect(listTemplates(templatesDir).map((t) => t.name)).toContain("starter");
  });

  it("provisions starter into a live registry", () => {
    const root = mkdtempSync(join(tmpdir(), "tpl-live-"));
    const agentsDir = join(root, "agents");
    const playbooksDir = join(root, "playbooks");
    mkdirSync(playbooksDir, { recursive: true });

    const r = provision(templateToProposal(loadTemplate(templatesDir, "starter")!), {
      agentsDir, playbooksDir, templatesDir, loadRegistry,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const reg = loadRegistry(agentsDir, playbooksDir);
    expect(reg.coordinator).toBeTruthy();
    expect(reg.agents.size).toBe(r.agents.length);
    // Every department the template declares actually survived the load.
    for (const d of r.departments) expect(reg.departments.has(d)).toBe(true);
    // Every playbook the template ships resolves to an owner agent.
    for (const p of r.playbooks) expect(reg.playbooks.has(p)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onboarding-templates-live.test.ts`
Expected: FAIL — `expected [] to contain 'starter'`

- [ ] **Step 3: Author the template**

```yaml
# templates/orgs/starter/org.yaml
name: starter
title: Starter
summary: A coordinator, a researcher, and a writer. The smallest org that can finish real work.
firstJob: Research a topic I care about and write me a one-page brief on it.

departments:
  - department: operations
    mission: Intake, triage, routing, and follow-up. The front door of the org.
    memoDomain: general
    lead: nova
    capabilities: []
    playbooks: []

  - department: studio
    mission: Research and written deliverables — briefs, summaries, and drafts the user can act on.
    memoDomain: studio
    lead: scribe
    capabilities: [memory]
    playbooks: [starter-brief]

agents:
  - name: nova
    department: operations
    kind: coordinator
    title: Coordinator
    charter: >
      Understand what the user actually wants, route it to the right specialist,
      and report back in plain language. Never do specialist work yourself.
    persona: >
      Calm and brief. You answer in a sentence or two unless asked for detail.
      You never pad a reply with what you are about to do.
    prompt: >
      You are the coordinator of a small AI organisation. When the user asks for
      something, decide whether it needs a specialist or a direct answer. Route
      research and writing to the studio department. Ask one clarifying question
      at most before starting — a wrong assumption is cheaper to fix than a stalled
      conversation.
    capabilities: [coordination, memory]
    skills: []

  - name: scout
    department: studio
    kind: worker
    title: Researcher
    charter: >
      Find out what is true. Gather sources, distinguish fact from inference,
      and hand the writer material that is already checked.
    persona: >
      Curious and literal. You say what you found and what you could not find,
      and you never present a guess as a finding.
    prompt: >
      You research topics for a small organisation. Search the web, read what you
      find, and produce notes with sources. Mark anything you inferred rather than
      read. When sources disagree, say so instead of picking one silently.
    capabilities: [web, memory, drafting]
    skills: []

  - name: scribe
    department: studio
    kind: lead
    title: Writer
    charter: >
      Turn research into something the user can act on. Own the quality of every
      written deliverable the studio produces.
    persona: >
      Plain and direct. You write short sentences and cut your own adjectives.
      You would rather be useful than impressive.
    prompt: >
      You write briefs, summaries, and drafts from the researcher's notes. Lead with
      the answer, then the reasoning. Keep sources attached to the claims they support.
      If the notes are too thin to write from, say what is missing rather than padding.
    capabilities: [drafting, memory, vault-write]
    skills: []
```

```yaml
# templates/orgs/starter/playbooks/starter-brief.yaml
name: starter-brief
description: >-
  Research a topic and write a one-page brief on it. The researcher gathers
  and checks material, the writer turns it into something readable.
needsProjectDir: false
stages:
  - type: single
    id: research
    role: scout
    brief: >-
      Research the requested topic. Produce notes with sources, separating what you
      read from what you inferred. Note anything you could not find.
  - type: single
    id: write
    role: scribe
    brief: >-
      Using the research notes, write a one-page brief. Lead with the answer, keep
      sources attached to their claims, and end with what remains uncertain.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/onboarding-templates-live.test.ts`
Expected: PASS (2 tests)

If the capability wall or an unknown capability rejects an agent, the provisioner returns card errors — read `r.errors` and fix the template, not the validator.

- [ ] **Step 5: Commit**

```bash
git add templates/orgs/starter test/onboarding-templates-live.test.ts
git commit -m "feat(templates): starter org — coordinator, researcher, writer

Ships its own playbook naming its own agents, which is how the spec
resolves playbook-name coupling: the template unit keeps names
consistent instead of a name-resolution layer."
```

---

### Task 8: The remaining four templates

**Files:**
- Create: `templates/orgs/solo-dev/org.yaml` + `templates/orgs/solo-dev/playbooks/ship-feature.yaml`
- Create: `templates/orgs/founder/org.yaml` + `templates/orgs/founder/playbooks/market-scan.yaml`
- Create: `templates/orgs/researcher/org.yaml` + `templates/orgs/researcher/playbooks/deep-dive.yaml`
- Create: `templates/orgs/personal-assistant/org.yaml` + `templates/orgs/personal-assistant/playbooks/weekly-review.yaml`
- Test: `test/onboarding-templates-live.test.ts` (extend)

**Interfaces:**
- Consumes: everything from Task 7.
- Produces: five shipped templates. Task 9 turns the single-template assertion into a loop over all of them.

- [ ] **Step 1: Extend the test to demand all five**

Replace the first test in `test/onboarding-templates-live.test.ts`:

```ts
const SHIPPED = ["founder", "personal-assistant", "researcher", "solo-dev", "starter"];

describe("shipped templates", () => {
  it("ships exactly the five v1 templates", () => {
    expect(listTemplates(templatesDir).map((t) => t.name).sort()).toEqual(SHIPPED);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onboarding-templates-live.test.ts`
Expected: FAIL — array contains only `["starter"]`

- [ ] **Step 3: Author solo-dev**

```yaml
# templates/orgs/solo-dev/org.yaml
name: solo-dev
title: Solo Developer
summary: A coordinator, an engineer, and a reviewer — for one person shipping software alone.
firstJob: Review the code I am about to paste and tell me what would break in production.

departments:
  - department: operations
    mission: Intake, triage, routing, and follow-up. The front door of the org.
    memoDomain: general
    lead: nova
    capabilities: []
    playbooks: []

  - department: engineering
    mission: Write, review, and ship code. Own correctness before speed.
    memoDomain: engineering
    lead: forge
    capabilities: [files-ro, memory]
    playbooks: [ship-feature]

agents:
  - name: nova
    department: operations
    kind: coordinator
    title: Coordinator
    charter: >
      Understand the request, route it to engineering when it touches code, and
      report results in plain language.
    persona: >
      Calm and brief. You answer in a sentence or two unless asked for detail.
    prompt: >
      You are the coordinator of a solo developer's AI organisation. Route anything
      involving code, architecture, or review to the engineering department. Answer
      simple questions directly rather than dispatching work that does not need it.
    capabilities: [coordination, memory]
    skills: []

  - name: forge
    department: engineering
    kind: lead
    title: Engineer
    charter: >
      Write and change code that works. Own the implementation from first read of
      the codebase to a change the user can run.
    persona: >
      Pragmatic and specific. You cite file and line rather than describing code in
      the abstract, and you say when you are unsure instead of guessing confidently.
    prompt: >
      You implement and modify code. Read the surrounding code before writing any, and
      match its conventions rather than importing your own. Prefer the smallest change
      that solves the actual problem. When a request is ambiguous, state the assumption
      you are making and continue rather than stalling.
    capabilities: [files-ro, editing, shell, memory]
    skills: []

  - name: warden
    department: engineering
    kind: critic
    title: Reviewer
    charter: >
      Find what will break before the user does. Review changes for correctness,
      edge cases, and the failure modes the author could not see.
    persona: >
      Direct and unsentimental about code, never about people. You lead with the
      most severe finding and skip praise.
    prompt: >
      You review code changes. Report findings most severe first, each with the concrete
      inputs or state that trigger the failure. Distinguish a real defect from a style
      preference and say which you are raising. If a change is correct, say so plainly
      rather than inventing findings.
    capabilities: [files-ro, memory]
    skills: []
```

```yaml
# templates/orgs/solo-dev/playbooks/ship-feature.yaml
name: ship-feature
description: >-
  Implement a change and have it reviewed before it is called done. The engineer
  writes, the reviewer looks for what breaks, and the engineer answers the findings.
needsProjectDir: true
stages:
  - type: loop
    id: implement
    producer: forge
    critic: warden
    maxRounds: 2
    brief: >-
      Implement the requested change. The reviewer will check correctness, edge cases,
      and whether the change matches the conventions of the surrounding code.
```

- [ ] **Step 4: Author founder**

```yaml
# templates/orgs/founder/org.yaml
name: founder
title: Founder
summary: A coordinator, a market researcher, and a writer — for someone building a company.
firstJob: Size the market for the product I am building and tell me who already competes there.

departments:
  - department: operations
    mission: Intake, triage, routing, and follow-up. The front door of the org.
    memoDomain: general
    lead: nova
    capabilities: []
    playbooks: []

  - department: strategy
    mission: Market understanding and positioning — who the customer is, who else wants them, and what that is worth.
    memoDomain: strategy
    lead: compass
    capabilities: [memory]
    playbooks: [market-scan]

agents:
  - name: nova
    department: operations
    kind: coordinator
    title: Coordinator
    charter: >
      Understand what the founder is actually deciding, route the research it needs,
      and give back an answer they can act on today.
    persona: >
      Calm and brief. You answer in a sentence or two unless asked for detail.
    prompt: >
      You are the coordinator of a founder's AI organisation. Route market, competitor,
      and positioning questions to the strategy department. Founders are deciding, not
      browsing — lead every report with the decision it supports.
    capabilities: [coordination, memory]
    skills: []

  - name: compass
    department: strategy
    kind: lead
    title: Market Analyst
    charter: >
      Understand the market well enough to bet on it — size, segments, competitors,
      and the assumptions underneath each number.
    persona: >
      Skeptical and numerate. You show the arithmetic behind an estimate and name the
      assumption that would break it.
    prompt: >
      You analyse markets for a founder. Produce estimates a skeptical investor would
      accept: state the method, show the math, and name the assumption each number rests
      on. Distinguish what you read from what you inferred. A defensible range beats a
      confident point estimate.
    capabilities: [web, memory, drafting]
    skills: [market-sizing]

  - name: quill
    department: strategy
    kind: worker
    title: Writer
    charter: >
      Turn analysis into things the founder can send — memos, one-pagers, and
      updates that a busy reader finishes.
    persona: >
      Plain and direct. You cut your own adjectives and lead with the point.
    prompt: >
      You write memos and one-pagers from the analyst's work. Lead with the conclusion,
      then the evidence. Keep numbers attached to their source and method. Write for a
      reader who will stop after the first paragraph.
    capabilities: [drafting, memory, vault-write]
    skills: []
```

```yaml
# templates/orgs/founder/playbooks/market-scan.yaml
name: market-scan
description: >-
  Size a market and map who already competes in it, then write it up as a memo
  the founder can send.
needsProjectDir: false
stages:
  - type: single
    id: analyse
    role: compass
    brief: >-
      Size the market for the described product and identify the existing competitors.
      Show the method and math behind every number, and name the assumptions that
      would change the answer.
  - type: single
    id: write
    role: quill
    brief: >-
      Turn the analysis into a one-page memo. Lead with the conclusion, keep every
      number attached to its method, and end with the assumptions worth testing first.
```

- [ ] **Step 5: Author researcher**

```yaml
# templates/orgs/researcher/org.yaml
name: researcher
title: Researcher
summary: A coordinator, a researcher, and a critic — for work where being right matters more than being fast.
firstJob: Do a deep dive on a question I care about and tell me where the evidence is weak.

departments:
  - department: operations
    mission: Intake, triage, routing, and follow-up. The front door of the org.
    memoDomain: general
    lead: nova
    capabilities: []
    playbooks: []

  - department: research
    mission: Deep investigation with sourcing discipline — findings that survive someone checking them.
    memoDomain: research
    lead: delve
    capabilities: [memory]
    playbooks: [deep-dive]

agents:
  - name: nova
    department: operations
    kind: coordinator
    title: Coordinator
    charter: >
      Understand the question being asked, route it to research, and report back
      what is known, what is uncertain, and what is unknown.
    persona: >
      Calm and brief. You answer in a sentence or two unless asked for detail.
    prompt: >
      You are the coordinator of a research organisation. Route substantive questions
      to the research department. When you report findings, keep the uncertainty the
      researchers attached to them — never round a hedge into a fact.
    capabilities: [coordination, memory]
    skills: []

  - name: delve
    department: research
    kind: lead
    title: Researcher
    charter: >
      Investigate questions thoroughly. Own sourcing, and own the honest account of
      what the evidence does and does not support.
    persona: >
      Patient and exact. You would rather report an unresolved question than a
      tidy answer you cannot support.
    prompt: >
      You investigate questions in depth. Search widely, read the primary source when one
      exists, and keep every claim attached to where it came from. Separate what you read
      from what you inferred. When sources conflict, report the conflict rather than
      choosing silently.
    capabilities: [web, memory, drafting, vault-write]
    skills: []

  - name: sift
    department: research
    kind: critic
    title: Reviewer
    charter: >
      Check the research before the user relies on it — sourcing, reasoning, and
      the claims that quietly went unsupported.
    persona: >
      Rigorous and specific. You quote the sentence you are challenging rather than
      describing your objection in general terms.
    prompt: >
      You review research output. Check that every claim has a source, that inference is
      labelled as inference, and that the conclusion follows from what was actually found.
      Quote the specific sentence behind each finding. If the work holds up, say so
      plainly rather than manufacturing objections.
    capabilities: [web-fetch, files-ro, memory]
    skills: []
```

```yaml
# templates/orgs/researcher/playbooks/deep-dive.yaml
name: deep-dive
description: >-
  Investigate a question thoroughly and have the findings checked before they
  are reported — sourcing, reasoning, and unsupported claims.
needsProjectDir: false
stages:
  - type: loop
    id: investigate
    producer: delve
    critic: sift
    maxRounds: 2
    brief: >-
      Investigate the question in depth. The reviewer will check that every claim has a
      source, that inference is labelled as such, and that the conclusion follows from
      what was actually found.
```

- [ ] **Step 6: Author personal-assistant**

This is the template that carries the spec's point about personal capabilities being product features. It uses `lifeops` and `money-analysis` from the catalog. The `life` department has capability walls (`src/agents/registry/walls.ts`) — its agents may not carry vault-write, propose, gate, email, git, or calendar tools, so `pilot` below stays on `lifeops` + `memory` only.

```yaml
# templates/orgs/personal-assistant/org.yaml
name: personal-assistant
title: Personal Assistant
summary: A coordinator, a personal-ops agent, and a money analyst — for running your own life, not a company.
firstJob: Look at what I have going on and tell me what actually needs me this week.

departments:
  - department: operations
    mission: Intake, triage, routing, and follow-up. The front door of the org.
    memoDomain: general
    lead: nova
    capabilities: []
    playbooks: []

  - department: life
    mission: Tasks, reminders, and the small logistics of a week — the things that fall through when nobody is watching.
    memoDomain: life
    lead: pilot
    capabilities: [lifeops]
    playbooks: [weekly-review]

  - department: finance
    mission: Personal money — spending, subscriptions, and where it actually goes.
    memoDomain: finance
    lead: tally
    capabilities: [memory]
    playbooks: []

agents:
  - name: nova
    department: operations
    kind: coordinator
    title: Coordinator
    charter: >
      Understand what the user needs handled, route it to the right specialist, and
      keep the answer short enough to read on a phone.
    persona: >
      Calm and brief. You answer in a sentence or two unless asked for detail.
    prompt: >
      You are the coordinator of a personal AI organisation. Route tasks, reminders, and
      scheduling to the life department, and anything about money to finance. This user
      is asking during their day, not at a desk — keep replies short and lead with what
      they should do.
    capabilities: [coordination, memory]
    skills: []

  - name: pilot
    department: life
    kind: lead
    title: Personal Ops
    charter: >
      Keep track of what the user has committed to and surface it before it becomes
      a problem. Own tasks and reminders.
    persona: >
      Practical and unfussy. You state what needs doing and when, without commentary
      on how the user is managing their life.
    prompt: >
      You manage tasks and reminders. When the user mentions a commitment in passing,
      capture it rather than waiting to be asked. When you report, lead with what is
      due soonest. Never moralise about what is overdue — just surface it.
    capabilities: [lifeops, memory]
    skills: []

  - name: tally
    department: finance
    kind: lead
    title: Money Analyst
    charter: >
      Understand where the user's money actually goes and say so plainly — spending
      patterns, subscriptions, and changes worth noticing.
    persona: >
      Factual and non-judgmental. You report what the numbers show, including when
      the answer is boring.
    prompt: >
      You analyse personal spending. Report patterns and changes with the numbers behind
      them. Flag recurring charges the user may have forgotten. Never editorialise about
      whether a purchase was wise — the user did not ask, and it is not your call.
    capabilities: [money-analysis, memory, drafting]
    skills: []
```

```yaml
# templates/orgs/personal-assistant/playbooks/weekly-review.yaml
name: weekly-review
description: >-
  Look across tasks, reminders, and commitments and report what actually needs
  the user this week.
needsProjectDir: false
stages:
  - type: single
    id: review
    role: pilot
    brief: >-
      Review outstanding tasks and reminders. Report what is due this week, what has
      slipped, and what can wait — soonest first, no commentary.
```

- [ ] **Step 7: Run the test and read any card errors**

Run: `npx vitest run test/onboarding-templates-live.test.ts`
Expected: PASS

If `personal-assistant` fails with `capability wall: life department agents may not carry …`, the template is wrong, not the wall — drop the offending capability from `pilot`.

- [ ] **Step 8: Commit**

```bash
git add templates/orgs
git commit -m "feat(templates): solo-dev, founder, researcher, personal-assistant

personal-assistant is the one that matters for the product argument: the
money and lifeops capabilities are catalog features available to every
user, not preset-exclusive. Only the values stay private."
```

---

### Task 9: Template golden test

Spec §9 asks that every shipped template be provisioned through the *real* provisioner so templates cannot rot. This is that test, and it replaces the single-template case from Task 7.

**Files:**
- Modify: `test/onboarding-templates-live.test.ts`

**Interfaces:**
- Consumes: `listTemplates`, `loadTemplate`, `templateToProposal`, `provision`, `deptWallViolations`.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Replace the single-template case with a loop over all shipped templates**

```ts
// test/onboarding-templates-live.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { listTemplates, loadTemplate } from "../src/onboarding/templates.js";
import { templateToProposal } from "../src/onboarding/proposal.js";
import { provision } from "../src/onboarding/provision.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { deptWallViolations } from "../src/agents/registry/walls.js";
import { toolsFromCaps } from "../src/agents/registry/capabilities.js";

const templatesDir = join(process.cwd(), "templates");
const SHIPPED = ["founder", "personal-assistant", "researcher", "solo-dev", "starter"];

function provisionInTemp(name: string) {
  const root = mkdtempSync(join(tmpdir(), `tpl-${name}-`));
  const agentsDir = join(root, "agents");
  const playbooksDir = join(root, "playbooks");
  mkdirSync(playbooksDir, { recursive: true });
  const result = provision(templateToProposal(loadTemplate(templatesDir, name)!), {
    agentsDir, playbooksDir, templatesDir, loadRegistry,
  });
  return { result, agentsDir, playbooksDir };
}

describe("shipped templates", () => {
  it("ships exactly the five v1 templates", () => {
    expect(listTemplates(templatesDir).map((t) => t.name).sort()).toEqual(SHIPPED);
  });

  for (const name of SHIPPED) {
    describe(name, () => {
      it("provisions through the real provisioner", () => {
        const { result } = provisionInTemp(name);
        if (!result.ok) throw new Error(`${name}: ${result.errors.map((e) => `${e.name ?? "-"}: ${e.error}`).join("; ")}`);
        expect(result.agents.length).toBeGreaterThan(0);
      });

      it("loads as a registry with exactly one coordinator and every department intact", () => {
        const { result, agentsDir, playbooksDir } = provisionInTemp(name);
        if (!result.ok) throw new Error("provision failed");
        const reg = loadRegistry(agentsDir, playbooksDir);
        expect(reg.coordinator).toBeTruthy();
        expect(reg.agents.size).toBe(result.agents.length);
        // A department the loader skipped (bad manifest, missing playbook) would silently vanish.
        for (const d of result.departments) expect(reg.departments.has(d)).toBe(true);
      });

      it("violates no department capability wall", () => {
        const { result, agentsDir, playbooksDir } = provisionInTemp(name);
        if (!result.ok) throw new Error("provision failed");
        const reg = loadRegistry(agentsDir, playbooksDir);
        for (const agent of reg.agents.values()) {
          const tools = toolsFromCaps(reg.capabilities, agent.capabilities);
          expect(deptWallViolations(agent.department, tools)).toEqual([]);
        }
      });

      it("resolves an owner for every playbook it ships", () => {
        const { result, agentsDir, playbooksDir } = provisionInTemp(name);
        if (!result.ok) throw new Error("provision failed");
        const reg = loadRegistry(agentsDir, playbooksDir);
        for (const p of result.playbooks) {
          expect(reg.playbooks.has(p)).toBe(true);
          // Every stage role must resolve to a real agent, or the job dies at run time.
          for (const s of reg.playbooks.get(p)!.stages) {
            const roles = s.type === "single" ? [s.role] : s.type === "loop" ? [s.producer, s.critic] : [s.runner, s.fixer];
            for (const r of roles) expect(reg.agentOf.has(r)).toBe(true);
          }
        }
      });
    });
  }
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/onboarding-templates-live.test.ts`
Expected: PASS (21 tests: 1 + 5 × 4)

A failure here names the template and the exact card error — fix the template.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: no pre-existing failures

- [ ] **Step 4: Commit**

```bash
git add test/onboarding-templates-live.test.ts
git commit -m "test(templates): provision every shipped template for real

Spec §9 — templates cannot rot if the suite provisions each one through
the real provisioner and checks the registry it produces: one
coordinator, every department intact, no wall violations, and every
playbook stage role resolving to a real agent."
```

---

### Task 10: `POST /api/departments` on the running daemon

The wizard provisions through `provision()` directly, but the spec calls for departments to be a first-class validated mutation on the live daemon too — Mission Control needs it to grow an org after onboarding, and it is the route the review screen's error shape is modelled on.

**Files:**
- Modify: `src/web/server.ts` (insert before the `/api/agents` POST block at line 710)
- Test: `test/departments-endpoint.test.ts`

**Interfaces:**
- Consumes: `validateDepartment`, `renderDepartmentYaml`.
- Produces: `POST /api/departments` → 200 `{ department, agents: [] }` | 400 `{ error }` | 500 `{ error }`.

- [ ] **Step 1: Write the failing test**

No test in this suite drives `src/web/server.ts` over HTTP — it needs the whole booted world (store, bus, vault, gate, registry, mailbox), which is why the routes are kept thin and the logic they call is tested directly. Follow that convention: test the validate → write → reload → compensate shape against a temp agents dir. The compensation branch itself is the same shape as hire's, which `test/agents-admin.test.ts` already covers.

```ts
// test/departments-endpoint.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { validateDepartment, renderDepartmentYaml } from "../src/web/agents-admin.js";

// The route is thin by design: validate → write → reload → compensate. Exercise that shape
// directly against a temp agents dir; the HTTP wrapper adds nothing this test would catch.
let agentsDir: string, playbooksDir: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "dept-ep-"));
  agentsDir = join(root, "agents");
  playbooksDir = join(root, "playbooks");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(playbooksDir, { recursive: true });
  cpSync(join(process.cwd(), "templates", "_capabilities.yaml"), join(agentsDir, "_capabilities.yaml"));
});

function post(body: unknown): { status: number; body: unknown } {
  const registry = loadRegistry(agentsDir, playbooksDir);
  const v = validateDepartment(body, registry);
  if (!v.ok) return { status: 400, body: { error: v.error } };
  const dir = join(agentsDir, v.manifest.department);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "department.yaml"), renderDepartmentYaml(v.manifest));
  return { status: 200, body: { department: v.manifest.department, agents: [] } };
}

describe("POST /api/departments", () => {
  it("writes a department.yaml the loader accepts", () => {
    const r = post({ department: "studio", mission: "Make things.", memoDomain: "studio", capabilities: [], playbooks: [] });
    expect(r.status).toBe(200);
    expect(existsSync(join(agentsDir, "studio", "department.yaml"))).toBe(true);
    expect(loadRegistry(agentsDir, playbooksDir).departments.has("studio")).toBe(true);
  });

  it("rejects a duplicate department with 400", () => {
    post({ department: "studio", mission: "Make things.", memoDomain: "studio", capabilities: [], playbooks: [] });
    const r = post({ department: "studio", mission: "Again.", memoDomain: "studio", capabilities: [], playbooks: [] });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'department "studio" already exists' });
  });

  it("rejects an unknown capability with 400", () => {
    const r = post({ department: "studio", mission: "Make things.", memoDomain: "studio", capabilities: ["telepathy"], playbooks: [] });
    expect(r.status).toBe(400);
    expect(existsSync(join(agentsDir, "studio"))).toBe(false);
  });

  it("renders a manifest that round-trips its own fields", () => {
    post({ department: "studio", mission: "Make things.", memoDomain: "studio", capabilities: ["reading"], playbooks: [] });
    const yaml = readFileSync(join(agentsDir, "studio", "department.yaml"), "utf8");
    expect(yaml).toContain("department: studio");
    expect(yaml).toContain("capabilities: [reading]");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/departments-endpoint.test.ts`
Expected: PASS (4 tests)

This one passes on first run, and that is correct rather than a missing red phase: Task 3 already drove `validateDepartment` out through failing unit tests against a fake registry. What is new here is the **round trip** — that a rendered manifest is one the real loader accepts — which no unit test with a fake registry can prove. Write the route next; it adds no logic this test does not already pin.

- [ ] **Step 3: Add the route**

Insert into `src/web/server.ts` immediately before the `if (path === "/api/agents" && req.method === "POST")` block (line 710):

```ts
        // ---- departments (onboarding spec §4): the one new validated mutation ----
        if (path === "/api/departments" && req.method === "POST") {
          const v = validateDepartment(JSON.parse(await readBody(req)), registry);
          if (!v.ok) return json(res, 400, { error: v.error });
          const dir = join(config.agentsDir, v.manifest.department);
          const file = join(dir, "department.yaml");
          const dirExisted = existsSync(dir);
          mkdirSync(dir, { recursive: true });
          writeFileSync(file, renderDepartmentYaml(v.manifest));
          try { reloadPacks(); } catch (err) {
            unlinkSync(file); // never leave a manifest the loader rejects
            if (!dirExisted) rmdirSync(dir);
            return json(res, 500, { error: `department reload failed: ${(err as Error).message}` });
          }
          log(`department created: ${v.manifest.department}`);
          return json(res, 200, { department: v.manifest.department, agents: [] });
        }
```

Extend the import from `agents-admin.js` at the top of the file to include `validateDepartment, renderDepartmentYaml`, and make sure `rmdirSync` and `existsSync` are in the `node:fs` import.

- [ ] **Step 4: Run the test and the full suite**

Run: `npx vitest run test/departments-endpoint.test.ts`
Expected: PASS (4 tests)

Run: `npx vitest run && npx tsc --noEmit`
Expected: no pre-existing failures, no tsc output

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts test/departments-endpoint.test.ts
git commit -m "feat(web): POST /api/departments

The one new validated mutation onboarding needs, and the route Mission
Control uses to grow an org after the wizard. Same never-brick shape as
hire: validate, write, reload, delete what was written if reload throws."
```

---

### Task 11: Wizard endpoints — gallery, selection, provision

**Files:**
- Modify: `src/onboarding/server.ts`
- Modify: `src/index.ts:88` (pass the new deps)
- Test: `test/onboarding-server.test.ts` (append)

**Interfaces:**
- Consumes: `listTemplates`, `loadTemplate`, `templateToProposal`, `provision`.
- Produces, on `SetupDeps`: `agentsDir: string`, `playbooksDir: string`, `templatesDir: string`, and optional `provisionFn` (injected in tests).
- Endpoints:
  - `GET /api/onboarding/templates` → `{ templates: Array<{name,title,summary}> }`
  - `POST /api/onboarding/template` `{ name }` → stores the proposal, advances `interview → review`, returns `{ step }`
  - `GET /api/onboarding/proposal` → `{ proposal }` or 404
  - `POST /api/onboarding/provision` → 200 `{ step: "first-job", departments, agents }` | 400 `{ error, errors }` — **both** keys: `errors` carries the per-card detail, and `error` is the joined summary, because ui2's shared `request()` helper reads only `error` off a failed response (`ui2/src/api.ts:43`) and would otherwise surface a bare `HTTP 400`.

- [ ] **Step 1: Extend the file's existing harness**

`test/onboarding-server.test.ts` already has `boot(ping, over)` which returns `{ base, envPath }` and closes the server in `afterEach`. The new cases need two more things from it: the kv store (to assert on persisted state) and a way to start the wizard at a given step. Replace the helper with:

```ts
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
```

Every existing call site keeps working — the two new parameters are optional and the added deps are ignored by the pre-existing endpoints.

- [ ] **Step 2: Write the failing tests**

Append to `test/onboarding-server.test.ts`:

```ts
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
    const body = (await r.json()) as { errors: Array<{ name: string }> };
    expect(body.errors[0].name).toBe("nova");
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/onboarding-server.test.ts`
Expected: FAIL — the new endpoints 404, and `SetupDeps` has no `agentsDir` (tsc error in the harness)

- [ ] **Step 4: Extend `SetupDeps` and add the endpoints**

In `src/onboarding/server.ts`, extend the interface:

```ts
export interface SetupDeps {
  store: KvLike;
  envPath: string;
  uiDist: string;
  port: number;
  agentsDir: string;
  playbooksDir: string;
  templatesDir: string;
  ping?: Ping;
  /** Injected in tests so provisioning can be exercised without writing an org. */
  provisionFn?: (proposal: OrgProposal) => ProvisionResult;
  /** Resume probe: did a previous run already write the org? */
  orgExists?: () => boolean;
  log?: (line: string) => void;
}
```

Add imports:

```ts
import { listTemplates, loadTemplate } from "./templates.js";
import { templateToProposal, type OrgProposal } from "./proposal.js";
import { provision, type ProvisionResult } from "./provision.js";
import { loadRegistry } from "../agents/registry/loader.js";
```

Inside `startSetupServer`, before the request handler:

```ts
  const PROPOSAL_KEY = "onboarding.proposal";
  const doProvision = deps.provisionFn ?? ((p: OrgProposal) => provision(p, {
    agentsDir: deps.agentsDir, playbooksDir: deps.playbooksDir, templatesDir: deps.templatesDir,
    loadRegistry, log,
  }));
  // Resume probe: a crash between "org written" and "step advanced" must not provision twice.
  const orgExists = deps.orgExists ?? (() => {
    try { return loadRegistry(deps.agentsDir, deps.playbooksDir).agents.size > 0; }
    catch { return false; }
  });
```

Add the endpoints alongside the existing ones, before the `/api/` 404 fallthrough:

```ts
        if (path === "/api/onboarding/templates" && req.method === "GET") {
          return json(res, 200, { templates: listTemplates(deps.templatesDir, log) });
        }

        if (path === "/api/onboarding/template" && req.method === "POST") {
          if (wizard.current() !== "interview") {
            return json(res, 400, { error: `templates are chosen at the interview step, not ${wizard.current()}` });
          }
          const body = await readJson<{ name?: unknown }>(req);
          if (!body) return json(res, 400, { error: "body must be JSON" });
          const name = typeof body.name === "string" ? body.name : "";
          let template;
          try {
            template = loadTemplate(deps.templatesDir, name);
          } catch (err) {
            return json(res, 400, { error: `template "${name}" is invalid: ${(err as Error).message}` });
          }
          if (!template) return json(res, 400, { error: `unknown template "${name}"` });
          const proposal = templateToProposal(template);
          deps.store.kvSet(PROPOSAL_KEY, JSON.stringify(proposal));
          return transition(res, path, () => wizard.advance("interview"));
        }

        if (path === "/api/onboarding/proposal" && req.method === "GET") {
          const raw = deps.store.kvGet(PROPOSAL_KEY);
          if (!raw) return json(res, 404, { error: "no proposal yet" });
          return json(res, 200, { proposal: JSON.parse(raw) as OrgProposal });
        }

        if (path === "/api/onboarding/provision" && req.method === "POST") {
          const at = wizard.current();
          // Resume: a crash between writing the org and advancing leaves the wizard here with
          // an org already on disk. Finishing is right; provisioning again would collide.
          if (at === "provision" && orgExists()) {
            return transition(res, path, () => wizard.advance("provision"));
          }
          if (at !== "review") return json(res, 400, { error: `provisioning happens at the review step, not ${at}` });
          const raw = deps.store.kvGet(PROPOSAL_KEY);
          if (!raw) return json(res, 400, { error: "no proposal to provision" });
          const result = doProvision(JSON.parse(raw) as OrgProposal);
          if (!result.ok) {
            const summary = result.errors.map((e) => `${e.name ?? e.scope}: ${e.error}`).join("; ");
            log(`provision rejected: ${summary}`);
            // Both keys on purpose: `errors` drives the per-card highlighting, `error` is what
            // ui2's shared request() helper reads off a failed response (api.ts:43). Without it
            // a rejected provision would surface to the user as a bare "HTTP 400".
            return json(res, 400, { error: summary, errors: result.errors });
          }
          wizard.advance("review");   // → provision
          wizard.advance("provision"); // → first-job
          log(`org provisioned: ${result.agents.join(", ")}`);
          return json(res, 200, { step: wizard.current(), departments: result.departments, agents: result.agents });
        }
```

Wire the new deps at `src/index.ts:88`:

```ts
      store, envPath: config.envPath, uiDist: config.uiDist, port: config.uiPort,
      agentsDir: config.agentsDir, playbooksDir: config.playbooksDir, templatesDir: config.templatesDir, log,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/onboarding-server.test.ts`
Expected: PASS — existing cases plus 10 new

- [ ] **Step 6: Run the full suite and tsc**

Run: `npx vitest run && npx tsc --noEmit`
Expected: no pre-existing failures, no tsc output

- [ ] **Step 7: Commit**

```bash
git add src/onboarding/server.ts src/index.ts test/onboarding-server.test.ts
git commit -m "feat(onboarding): template gallery and provisioning endpoints

The proposal is stored in kv between selection and approval so nothing
touches disk until the user approves it. Provisioning at the 'provision'
step with an org already present finishes the wizard instead of writing
twice — that is the crash-between-advances resume case."
```

---

### Task 12: Wizard UI — gallery, review, provision

Read-only review for this plan; inline editing arrives in 2b with the interview.

**Files:**
- Modify: `ui2/src/api.ts`
- Modify: `ui2/src/views/Setup.tsx`
- Test: manual smoke (the ui2 suite has no renderer for Setup yet; adding one is out of scope here)

**Interfaces:**
- Consumes: the Task 11 endpoints.
- Produces: `api.onboardingTemplates()`, `api.onboardingPickTemplate(name)`, `api.onboardingProposal()`, `api.onboardingProvision()`.

- [ ] **Step 1: Add the API methods**

In `ui2/src/api.ts`, alongside the existing `onboardingAdvance`/`onboardingAuth`/`onboardingBack`:

```ts
  onboardingTemplates: () =>
    request<{ templates: Array<{ name: string; title: string; summary: string }> }>("/api/onboarding/templates"),
  onboardingPickTemplate: (name: string) =>
    request<{ step: string }>("/api/onboarding/template", { method: "POST", body: JSON.stringify({ name }) }),
  onboardingProposal: () =>
    request<{ proposal: OrgProposalView }>("/api/onboarding/proposal"),
  /** Not `request`: a rejected provision carries per-card `errors` that request() would discard,
   *  since it reads only `error` off a failed response. Same reason onboardingAuth bypasses it. */
  onboardingProvision: async (): Promise<
    | { ok: true; step: string; departments: string[]; agents: string[] }
    | { ok: false; errors: Array<{ scope: string; name?: string; error: string }>; message: string }
  > => {
    const res = await fetch("/api/onboarding/provision", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const body = (await res.json().catch(() => ({}))) as {
      step?: string; departments?: string[]; agents?: string[];
      error?: string; errors?: Array<{ scope: string; name?: string; error: string }>;
    };
    if (res.ok) {
      return { ok: true, step: body.step!, departments: body.departments ?? [], agents: body.agents ?? [] };
    }
    return { ok: false, errors: body.errors ?? [], message: body.error ?? `HTTP ${res.status}` };
  },
```

Add the view type to the same file:

```ts
export interface OrgProposalView {
  source: { kind: "template"; template: string } | { kind: "interview" };
  departments: Array<{ department: string; mission: string; lead?: string }>;
  agents: Array<{
    name: string; department: string; kind: string; title: string;
    charter: string; persona: string; prompt: string; capabilities: string[]; skills: string[];
  }>;
  firstJob: string;
}
```

- [ ] **Step 2: Replace the "Almost there" placeholder in `Setup.tsx`**

Swap the `step !== "welcome" && step !== "auth"` block for real step components:

```tsx
      {step === "interview" && <Gallery onNext={onStepChange} />}
      {step === "review" && <Review onNext={onStepChange} />}
      {(step === "workspace" || step === "provision" || step === "first-job" || step === "done") && (
        <div className="panel w-full max-w-md p-6 flex flex-col gap-3 text-center">
          <div className="text-strong text-[15px]">{LABELS[step]}</div>
          <p className="leading-relaxed">
            {step === "workspace"
              ? "Workspace choice arrives in the next phase — the built-in workspace is used for now."
              : "This step arrives in the next phase."}
          </p>
          {step === "workspace" && <SkipStep step="workspace" onNext={onStepChange} />}
        </div>
      )}
```

Add the components:

```tsx
/** Workspace lands in plan 3; until then the step is a pass-through so the org path is reachable. */
function SkipStep({ step, onNext }: { step: string; onNext: (s: string) => void }) {
  const [error, setError] = useState("");
  return (
    <>
      {error && <div className="text-[12px] text-err">{error}</div>}
      <Button variant="primary" onClick={() => {
        api.onboardingAdvance(step)
          .then((r) => onNext(r.step))
          .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
      }}>Continue</Button>
    </>
  );
}

function Gallery({ onNext }: { onNext: (s: string) => void }) {
  const [rows, setRows] = useState<Array<{ name: string; title: string; summary: string }>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    api.onboardingTemplates()
      .then((r) => setRows(r.templates))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const pick = (name: string) => {
    setBusy(name); setError("");
    api.onboardingPickTemplate(name)
      .then((r) => onNext(r.step))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(""));
  };

  return (
    <div className="panel w-full max-w-2xl p-6 flex flex-col gap-4">
      <div className="text-strong text-[15px]">Pick a starting org</div>
      <p className="leading-relaxed">
        Each one is a working team you can change later — hire, retire, and edit any agent
        once you are in.
      </p>
      {error && <div className="text-[12px] text-err">{error}</div>}
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((t) => (
          <button key={t.name} disabled={!!busy} onClick={() => pick(t.name)}
            className="text-left border border-line rounded-md p-3 hover:border-dim disabled:opacity-50">
            <div className="text-strong">{t.title}</div>
            <div className="text-[12px] text-dim leading-relaxed">{t.summary}</div>
            {busy === t.name && <div className="text-[11px] text-dim mt-1">Loading…</div>}
          </button>
        ))}
        {rows.length === 0 && !error && <div className="text-dim text-[12px]">Loading templates…</div>}
      </div>
    </div>
  );
}

function Review({ onNext }: { onNext: (s: string) => void }) {
  const [proposal, setProposal] = useState<OrgProposalView | null>(null);
  const [errors, setErrors] = useState<Array<{ name?: string; error: string }>>([]);
  // Two distinct failures: loadError means there is nothing to show, error means the org we
  // ARE showing was rejected. Collapsing them would blank the screen on a rejected provision.
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.onboardingProposal()
      .then((r) => setProposal(r.proposal))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);

  const approve = () => {
    setBusy(true); setError(""); setErrors([]);
    api.onboardingProvision()
      .then((r) => {
        if (r.ok) return onNext(r.step);
        // Card errors highlight their agent; the summary covers proposal-level rejections,
        // which belong to no card and would otherwise leave the screen silently unchanged.
        setErrors(r.errors);
        if (r.errors.every((e) => !e.name)) setError(r.message);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (loadError) return <div className="panel w-full max-w-md p-6 text-[12px] text-err">{loadError}</div>;
  if (!proposal) return <div className="panel w-full max-w-md p-6 text-dim">Loading your org…</div>;

  const errorFor = (name: string) => errors.find((e) => e.name === name)?.error;

  return (
    <div className="panel w-full max-w-2xl p-6 flex flex-col gap-4">
      <div className="text-strong text-[15px]">Your org</div>
      <p className="leading-relaxed">
        Nothing has been written yet. Read it, then approve — you can change any of it afterwards.
      </p>
      {errors.length > 0 && (
        <div className="text-[12px] text-err">
          This org could not be created. Fix the flagged agents or pick a different template.
        </div>
      )}
      {error && <div className="text-[12px] text-err">{error}</div>}
      {proposal.departments.map((d) => (
        <div key={d.department} className="border border-line rounded-md p-3 flex flex-col gap-2">
          <div className="text-strong">{d.department}</div>
          <div className="text-[12px] text-dim leading-relaxed">{d.mission}</div>
          {proposal.agents.filter((a) => a.department === d.department).map((a) => (
            <details key={a.name} className={`border rounded-md p-2 ${errorFor(a.name) ? "border-err" : "border-line"}`}>
              <summary className="cursor-pointer">
                <span className="text-strong">{a.name}</span>
                <span className="text-dim"> — {a.title} ({a.kind})</span>
              </summary>
              <div className="text-[12px] leading-relaxed flex flex-col gap-1 mt-2">
                <div><span className="text-dim">Charter: </span>{a.charter}</div>
                <div><span className="text-dim">Persona: </span>{a.persona}</div>
                <div><span className="text-dim">Prompt: </span>{a.prompt}</div>
                <div><span className="text-dim">Capabilities: </span>{a.capabilities.join(", ") || "none"}</div>
              </div>
              {errorFor(a.name) && <div className="text-[12px] text-err mt-1">{errorFor(a.name)}</div>}
            </details>
          ))}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button onClick={() => {
          api.onboardingBack("interview").then((r) => onNext(r.step)).catch(() => {});
        }} disabled={busy}>Pick another</Button>
        <Button variant="primary" className="ml-auto" disabled={busy} onClick={approve}>
          {busy ? "Creating…" : "Create this org"}
        </Button>
      </div>
    </div>
  );
}
```

Add `useEffect` to the React import and `OrgProposalView` to the api import.

- [ ] **Step 3: Build the UI**

Run: `cd ui2 && npm run build`
Expected: `✓ built in …` with no TypeScript errors

- [ ] **Step 4: Smoke the whole path against a scratch install**

```bash
rm -rf /tmp/aios-org-smoke && mkdir -p /tmp/aios-org-smoke/agents /tmp/aios-org-smoke/playbooks
AIOS_AGENTS_DIR=/tmp/aios-org-smoke/agents \
AIOS_PLAYBOOKS_DIR=/tmp/aios-org-smoke/playbooks \
AIOS_DATA_DIR=/tmp/aios-org-smoke/data \
AIOS_UI_PORT=4291 npm run dev
```

The live daemon owns 4280 — never restart it here.

In a second terminal, walk the path with curl (the wizard starts at `welcome`; auth needs a real token, so seed the step instead):

```bash
curl -s localhost:4291/api/onboarding/templates | head -c 400
```

Then in the browser at `http://localhost:4291`, click through: welcome → auth (paste a token) → workspace `Continue` → gallery → pick `starter` → review → **Create this org**.

Expected: the review screen lists `operations` and `studio` with three agents; approving lands on the first-job step, and:

```bash
ls -R /tmp/aios-org-smoke/agents
```

shows `_capabilities.yaml`, `operations/department.yaml`, `operations/nova.yaml`, `studio/department.yaml`, `studio/scout.yaml`, `studio/scribe.yaml`.

- [ ] **Step 5: Commit**

```bash
git add ui2/src/api.ts ui2/src/views/Setup.tsx ui2/dist
git commit -m "feat(ui2): template gallery and read-only org review

Review renders the proposal before anything is written — the trust gate.
Card-level provisioning errors highlight the agent that caused them.
Inline editing lands with the interview in the next plan."
```

---

### Task 13 — DEFERRED, DO NOT EXECUTE: Re-anchor the suite onto a fixture org

`agents/` is about to leave version control, which would take the whole suite's registry with it — seven files load the live tree, and most other tests reach it through `test/fixtures/registry.ts`.

Anchoring on a *product template* would be the obvious move and is wrong: the personal org incidentally exercises capabilities no starter template carries (`money-analysis`, `ledger`, `research-kb`, `halalo-aws` guards, `ledger-confine`), and that coverage would silently disappear. Build a fixture org whose explicit job is to carry every capability in the catalog.

**Files:**
- Create: `test/fixtures/org/` (department + agent manifests) and `test/fixtures/org-playbooks/`
- Modify: `test/fixtures/registry.ts`, `test/registry-live-tree.test.ts`, `test/capabilities.test.ts`, `test/resolve-agent.test.ts`, `test/agents-admin.test.ts`, `test/code-integration.test.ts`, `test/org-golden.test.ts`
- Modify: `test/fixtures/org-golden.json` (re-pinned — the one sanctioned regeneration)

**Interfaces:**
- Consumes: the capability catalog at `templates/_capabilities.yaml`.
- Produces: `FIXTURE_AGENTS_DIR` and `FIXTURE_PLAYBOOKS_DIR` exported from `test/fixtures/registry.ts`; `testRegistry()` keeps its current signature so importers do not change.

- ~~Step 1: Write the coverage test that the fixture must satisfy**

```ts
// test/fixtures-org.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { testRegistry, FIXTURE_AGENTS_DIR } from "./fixtures/registry.js";

describe("fixture org", () => {
  it("loads cleanly with exactly one coordinator", () => {
    const reg = testRegistry();
    expect(reg.coordinator).toBeTruthy();
    expect(reg.agents.size).toBeGreaterThan(0);
  });

  it("carries every capability in the catalog — this is why it exists", () => {
    const reg = testRegistry();
    const catalog = Object.keys(parse(readFileSync("templates/_capabilities.yaml", "utf8")) as Record<string, unknown>);
    const covered = new Set<string>();
    for (const a of reg.agents.values()) for (const c of a.capabilities) covered.add(c);
    const missing = catalog.filter((c) => !covered.has(c));
    expect(missing).toEqual([]);
  });

  it("does not read the user's agents dir", () => {
    expect(FIXTURE_AGENTS_DIR).toContain("fixtures");
  });
});
```

- ~~Step 2: Run test to verify it fails**

Run: `npx vitest run test/fixtures-org.test.ts`
Expected: FAIL — `FIXTURE_AGENTS_DIR` is not exported

- ~~Step 3: Build the fixture org**

Start from the live tree so no capability is lost, then de-personalize:

```bash
mkdir -p test/fixtures/org test/fixtures/org-playbooks
cp -R agents/* test/fixtures/org/
rm -rf test/fixtures/org/_retired
cp -R playbooks/* test/fixtures/org-playbooks/
cp templates/_capabilities.yaml test/fixtures/org/_capabilities.yaml
```

Then edit the copies so they are fixtures rather than someone's org: no real company names, member rosters, or client paths in any `charter`/`persona`/`prompt`/`mission`. Keep every `name`, `department`, `kind`, `capabilities`, and `aliases` value **byte-identical** — those are what the tests assert on, and changing them turns this task into a rewrite of seven test files.

Run the coverage test after editing; it names any capability that fell out.

- ~~Step 4: Point the shared helper at the fixture**

```ts
// test/fixtures/registry.ts
import { join } from "node:path";
import { loadRegistry } from "../../src/agents/registry/loader.js";
import { buildExtras } from "../../src/agents/registry/extras.js";
import { useHalaloFixtureDir } from "./halalo-env.js";
import type { RoleDef } from "../../src/agents/roles/index.js";

/** The suite's org. Deliberately NOT the user's agents/ dir (which is user data and not in git)
 *  and NOT a product template (whose small size would quietly drop capability coverage). Its
 *  job is to carry every capability in the catalog — see test/fixtures-org.test.ts. */
export const FIXTURE_AGENTS_DIR = join(process.cwd(), "test", "fixtures", "org");
export const FIXTURE_PLAYBOOKS_DIR = join(process.cwd(), "test", "fixtures", "org-playbooks");

export function testRegistry() {
  useHalaloFixtureDir();
  return loadRegistry(
    FIXTURE_AGENTS_DIR,
    FIXTURE_PLAYBOOKS_DIR,
    buildExtras({ vaultPath: "/tmp/v", vaultSubdir: "AIOS", financeCompany: "TestCo", financeMembers: [{ name: "Ada" }] }),
  );
}

let cached: ReturnType<typeof testRegistry> | null = null;

/** Compiled-from-YAML role lookup by canonical name OR legacy alias (cfo → midas, etc.).
 *  Replaces the deleted legacy `roles` map as the tests' oracle — pins production truth. */
export function roleOf(nameOrAlias: string): RoleDef {
  cached ??= testRegistry();
  const name = cached.agentOf.get(nameOrAlias) ?? nameOrAlias;
  const agent = cached.agents.get(name);
  if (!agent) throw new Error(`roleOf: no agent for "${nameOrAlias}"`);
  return agent.role;
}
```

- ~~Step 5: Re-anchor the six direct callers**

In each file below, replace the agents/playbooks path arguments with the fixture constants imported from `./fixtures/registry.js` (or `../fixtures/registry.js` as the file's depth requires):

- `test/registry-live-tree.test.ts:20-21` — also rename the describe from `"live agents/ tree"` to `"fixture org tree"`.
- `test/capabilities.test.ts` — `loadRegistry(FIXTURE_AGENTS_DIR, FIXTURE_PLAYBOOKS_DIR, {}, () => {})`
- `test/resolve-agent.test.ts` — same substitution inside `setup()`
- `test/agents-admin.test.ts` — same substitution
- `test/code-integration.test.ts` — same substitution
- `test/org-golden.test.ts` — same substitution

- ~~Step 6: Run the suite and read the failures**

Run: `npx vitest run`
Expected: `test/org-golden.test.ts` fails on the golden diff (the fixture's tool surface is being compared against a golden pinned from the live tree). Everything else should pass — if a name-based assertion fails, Step 3's byte-identical rule was broken; fix the fixture, not the test.

- ~~Step 7: Re-pin the golden — the one sanctioned regeneration**

This is the only place in this plan where regenerating `test/fixtures/org-golden.json` is correct. Regenerate using whatever script `test/org-golden.test.ts` documents, then **diff it by eye**:

```bash
git diff test/fixtures/org-golden.json | head -60
```

Expected: agent *names* unchanged, tool *lists* unchanged per agent. A changed tool list means the fixture edit altered a capability — go back to Step 3. Only the file's provenance is changing, not its content.

- ~~Step 8: Run the full suite and tsc**

Run: `npx vitest run && npx tsc --noEmit`
Expected: no failures, no tsc output

- ~~Step 9: Commit**

```bash
git add test/fixtures/org test/fixtures/org-playbooks test/fixtures/registry.ts test/fixtures/org-golden.json \
  test/fixtures-org.test.ts test/registry-live-tree.test.ts test/capabilities.test.ts \
  test/resolve-agent.test.ts test/agents-admin.test.ts test/code-integration.test.ts test/org-golden.test.ts
git commit -m "test: anchor the suite on a fixture org, not the user's agents/

agents/ is about to become user data, which would take the suite's
registry with it. A product template would have been the obvious anchor
and would have silently dropped coverage of money-analysis, ledger,
research-kb, and the client guards — so the fixture's explicit job is to
carry every capability in the catalog, pinned by a test."
```

---

### Task 14 — DEFERRED, DO NOT EXECUTE: `agents/` and `playbooks/` become user data

The last step, and the one that makes the wizard reachable for anyone who clones the repo: today a fresh clone inherits an org, so `bootMode` sees agents and goes straight to `normal` — the wizard never runs.

**Files:**
- Modify: `.gitignore`
- Remove from the index (not from disk): `agents/`, `playbooks/`
- Modify: `README.md`
- Test: `test/onboarding-mode.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed downstream.

- ~~Step 1: Write the failing test for the migration shim**

Append to `test/onboarding-mode.test.ts`:

The signature is `bootMode(env: NodeJS.ProcessEnv, agentsDir: string)` and the file already has a `TOKEN` env constant and an `orgDir(populated: boolean)` helper — reuse both:

```ts
describe("existing installs are never taken over by the wizard", () => {
  it("boots normal from an untracked org, exactly as it did from a tracked one", () => {
    // Nothing in bootMode consults git; this pins that, so untracking agents/ cannot
    // silently turn an existing install's next restart into a wizard takeover.
    const dir = mkdtempSync(join(tmpdir(), "mode-user-data-"));
    mkdirSync(join(dir, "ops"), { recursive: true });
    writeFileSync(join(dir, "ops", "department.yaml"), "department: ops\nmission: m\nmemoDomain: general\n");
    writeFileSync(join(dir, "ops", "nova.yaml"), "name: nova\n");
    expect(bootMode(TOKEN, dir)).toBe("normal");
  });

  it("boots setup for a fresh clone, whose agents dir does not exist at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "mode-clone-"));
    expect(bootMode(TOKEN, join(dir, "agents"))).toBe("setup");
  });
});
```

- ~~Step 2: Run test to verify it passes or fails**

Run: `npx vitest run test/onboarding-mode.test.ts`
Expected: PASS — `bootMode` already implements this. The test is here to pin the guarantee before `agents/` stops being tracked, so a later refactor cannot break the shim silently.

- ~~Step 3: Untrack the org, leave it on disk**

```bash
git rm -r --cached agents playbooks
```

Verify nothing left the disk:

```bash
ls agents playbooks
```

- ~~Step 4: Ignore them**

Append to `.gitignore`:

```gitignore

# Your org is yours. agents/ and playbooks/ are created by the setup wizard from a
# template and edited from Mission Control — user data, not product. Templates ship
# under templates/orgs/ and the tests run against test/fixtures/org/.
/agents/
/playbooks/
```

- ~~Step 5: Confirm a fresh clone reaches the wizard**

```bash
rm -rf /tmp/aios-clone-check && git clone . /tmp/aios-clone-check 2>/dev/null
ls /tmp/aios-clone-check
```

Expected: no `agents/` and no `playbooks/` directory. That is what makes `bootMode` return `setup` for a new user.

- ~~Step 6: Document it**

Add to `README.md`, under the setup section:

```markdown
### Your org is not in this repo

`agents/` and `playbooks/` are **your data**, created by the setup wizard from a
template and edited from Mission Control. They are deliberately untracked, so
pulling an update never touches your org and your agents never land in a diff.

- Shipped starting points live in `templates/orgs/`.
- The test suite runs against `test/fixtures/org/`, not your org.
- Back them up yourself, or point `AIOS_AGENTS_DIR` somewhere you already back up.
```

- ~~Step 7: Run the full suite and tsc**

Run: `npx vitest run && npx tsc --noEmit`
Expected: no failures (Task 13 already moved the suite off `agents/`), no tsc output

- ~~Step 8: Commit**

```bash
git add .gitignore README.md test/onboarding-mode.test.ts
git commit -m "chore(org): agents/ and playbooks/ become user data

A fresh clone inherited an org, so bootMode saw agents and went straight
to normal — the wizard could never run for a new user. Untracked but left
on disk, so this install is unchanged. Templates ship the starting points
and the suite runs against its own fixture org."
```

---

## Execution outcome (2026-07-31)

**Tasks 1-12 executed, verified, and merged. Tasks 13-14 deferred to their own plan** — user
decision. They are a test-architecture change plus a privacy pass over the owner's real agent
manifests, which wants direct review rather than an agent's judgement.

One defect surfaced by the deferral and fixed before merge: Task 1 untracked
`agents/_capabilities.yaml` on the assumption Task 14 would untrack `agents/` in the same plan.
With 14 deferred, a fresh clone had tracked agent manifests and no catalog to validate them
against — `loadRegistry` threw `unknown capability "files-ro" on agent halalo` on checkout.
Both copies are now tracked, with a test pinning them byte-identical, until `agents/` becomes
user data.

### What 2a-bis must still do

- `test/fixtures/org/` + `test/fixtures/org-playbooks/` carrying every capability in the catalog.
- Re-anchor `test/fixtures/registry.ts` and the six direct callers off the live `agents/` tree.
- Re-pin `test/fixtures/org-golden.json` (the one sanctioned regeneration).
- `git rm -r --cached agents playbooks`, gitignore both, README section.
- **Delete `agents/_capabilities.yaml` and the byte-identical drift test in
  `test/onboarding-seed.test.ts`** — both exist only to bridge this deferral.

Until then, a fresh clone still inherits the owner's org, so `bootMode` returns `normal` and a
brand-new user does not reach the wizard. The wizard is reachable today by pointing
`AIOS_AGENTS_DIR` at an empty directory.

## Done when

- `npx vitest run` passes with the new suites; no pre-existing test was weakened to get there.
- `npx tsc --noEmit` is clean for both roots.
- A scratch install (`AIOS_AGENTS_DIR` pointed at an empty dir) walks welcome → auth → workspace → gallery → review → **Create this org** and lands on `first-job` with real manifests on disk that `loadRegistry` accepts.
- A fresh `git clone` of this repo contains no `agents/` directory.

## Carried forward to plan 2b

- Org Architect (`src/onboarding/architect.ts`): direct `query()` with `outputFormat: {type:"json_schema"}` producing an `OrgProposal`; context = capability catalog + skills catalog + templates as few-shot.
- Review screen editing: inline charter/persona/prompt edits, capability and skill chips, per-agent redraft, regenerate.
- Interview chat UI with the always-visible "Skip — pick a template instead" button (the gallery this plan builds is already that escape hatch).
- Architect eval harness (spec §9): 5 fixture personas → proposals must pass `proposalShape` + `provision` against a temp dir.

## Deferred-minor ledger (carried from plan 1, still open)

- Typed `Wizard` errors — a store fault currently reads as a 400.
- `StateInfo` discriminated union in ui2.
- `useEvents` enabled flag — the wizard polls a dead SSE endpoint on a 3s loop.
- `rmSync`-in-`finally` guard in `withPingEnv`.
- `agents/clients/halalo.yaml` still ships as the clients department lead (lazy named throw when invoked unconfigured); after Task 14 it is untracked user data, which retires the concern for new installs.
