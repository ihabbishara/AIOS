# The Staff — Agent Registry + Unified Routing (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One agent registry (YAML manifests → compiled RoleDef) replacing the roles-map/pack.yaml/FinanceAgent split; one routing brain with logged `route.decision`; `hand_off` with full capability parity replacing toolless `ask_specialist`.

**Architecture:** New `agents/<dept>/` manifest tree loaded by `loadRegistry()` (mirrors `loadPacks` fail-soft semantics) and compiled to the existing `RoleDef` shape, so the runner options pipeline (`roleQueryOptions → packRunOptions → withEffectiveTools → withDenialObserver`) is untouched. `department.yaml` replaces `pack.yaml` (same resolve semantics; tools move to per-agent manifests, resolver uses the department union + existing `clampTools`). FinanceAgent dissolves into a `ledger` toolServer + a normal registry agent.

**Tech Stack:** TypeScript, Node 23 (`node:sqlite`), zod, yaml, Claude Agent SDK 0.3.x, vitest.

**Spec:** `docs/superpowers/specs/2026-07-02-agent-registry-legibility-design.md`

## Global Constraints

- Subscription auth only (`CLAUDE_CODE_OAUTH_TOKEN`); never `ANTHROPIC_API_KEY`.
- No new npm dependencies. No better-sqlite3 (build fails on this machine); `node:sqlite` only.
- Fail-soft load / fail-closed capability: a bad manifest skips that unit with a loud log; permission merging never widens on error.
- Untouchable: action gate + trust ledger, recall exclusions (personal_*, email.*, mail.received), 5-layer code sandbox, `privateOnly` semantics, integer-cents ledger math, playbook engine stage logic.
- Phase 2 (UI) is a separate plan. No UI changes here beyond keeping `npm run build` + existing endpoints green.
- Existing env vars keep working: `AIOS_CODE|MONEY|RESEARCH|LIFEOPS_DISABLED` map to engineering/finance/research/life.
- Run tests from repo root: `npx vitest run <file>`; full suite `npx vitest run`; type check `npx tsc --noEmit`.
- Commit after each task; message prefix `feat(staff):` / `test(staff):` / `refactor(staff):`.

---

### Task 1: Registry schemas + types

**Files:**
- Create: `src/agents/registry/types.ts`
- Test: `test/registry-types.test.ts`

**Interfaces:**
- Produces: `agentSchema`, `departmentSchema` (zod), `AgentManifest`, `DepartmentManifest` types. `AgentManifest.visibility: "shared"|"private"` (default shared), `aliases: string[]` (default []), `tools: string[]` (default []), `guards/skills: string[]` (default []), `outputSchema?: "verdict"|"test-report"`, `permissionMode` (default "dontAsk"), `maxTurns` (default 25), `model?: string`. `DepartmentManifest` = pack.yaml fields renamed (`department` replaces `pillar`, adds `mission: string`, `lead?: string`) with `vaultSection` defaulting to `department`; **no `tools` field** (tools are per-agent now).

- [ ] **Step 1: Write the failing test**

```ts
// test/registry-types.test.ts
import { describe, it, expect } from "vitest";
import { agentSchema, departmentSchema } from "../src/agents/registry/types.js";

describe("agentSchema", () => {
  it("parses a minimal manifest with defaults", () => {
    const a = agentSchema.parse({
      name: "maya", title: "Senior Engineer", department: "engineering",
      charter: "Owns code changes.", persona: "Terse.", prompt: "You are an engineer.",
    });
    expect(a.visibility).toBe("shared");
    expect(a.aliases).toEqual([]);
    expect(a.tools).toEqual([]);
    expect(a.permissionMode).toBe("dontAsk");
    expect(a.maxTurns).toBe(25);
  });
  it("rejects a bad permissionMode and bad visibility", () => {
    expect(() => agentSchema.parse({ name: "x", title: "t", department: "d", charter: "c", persona: "p", prompt: "s", permissionMode: "yolo" })).toThrow();
    expect(() => agentSchema.parse({ name: "x", title: "t", department: "d", charter: "c", persona: "p", prompt: "s", visibility: "public" })).toThrow();
  });
  it("rejects uppercase / spaced names", () => {
    expect(() => agentSchema.parse({ name: "Maya B", title: "t", department: "d", charter: "c", persona: "p", prompt: "s" })).toThrow();
  });
});

describe("departmentSchema", () => {
  it("parses and defaults vaultSection to department", () => {
    const d = departmentSchema.parse({ department: "engineering", mission: "Build software.", memoDomain: "code" });
    expect(d.vaultSection).toBe("engineering");
    expect(d.actions).toEqual([]);
    expect(d.playbooks).toEqual([]);
    expect(d.sandbox).toBe(false);
  });
  it("keeps explicit vaultSection", () => {
    const d = departmentSchema.parse({ department: "research", mission: "m", memoDomain: "research", vaultSection: "knowledge" });
    expect(d.vaultSection).toBe("knowledge");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/registry-types.test.ts`
Expected: FAIL — cannot find module `src/agents/registry/types.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/agents/registry/types.ts
import { z } from "zod";

/** One agent manifest (agents/<dept>/<name>.yaml). Compiled to RoleDef at load. */
export const agentSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase kebab name"),
  title: z.string().min(1),
  department: z.string().min(1),
  charter: z.string().min(1),
  persona: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().optional(),
  tools: z.array(z.string()).default([]),
  guards: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  maxTurns: z.number().int().positive().default(25),
  permissionMode: z.enum(["dontAsk", "bypassPermissions", "default"]).default("dontAsk"),
  visibility: z.enum(["shared", "private"]).default("shared"),
  outputSchema: z.enum(["verdict", "test-report"]).optional(),
  aliases: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
});
export type AgentManifest = z.infer<typeof agentSchema>;

/** Department manifest (agents/<dept>/department.yaml) — pack.yaml evolved; tools live on agents. */
export const departmentSchema = z.object({
  department: z.string().min(1),
  mission: z.string().min(1),
  lead: z.string().optional(),
  memoDomain: z.string().min(1),
  vaultSection: z.string().optional(),
  toolServer: z.string().optional(),
  actions: z.array(z.string()).default([]),
  playbooks: z.array(z.string()).default([]),
  sandbox: z.boolean().default(false),
}).transform((d) => ({ ...d, vaultSection: d.vaultSection ?? d.department }));
export type DepartmentManifest = z.infer<typeof departmentSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/registry-types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/registry/types.ts test/registry-types.test.ts
git commit -m "feat(staff): agent + department manifest schemas"
```

---

### Task 2: Registry loader + RoleDef compile

**Files:**
- Create: `src/agents/registry/loader.ts`
- Test: `test/registry-loader.test.ts`

**Interfaces:**
- Consumes: `agentSchema`/`departmentSchema` (Task 1); `RoleDef` from `src/agents/roles/index.ts`; `loadPlaybook` from `src/engine/playbook.ts`.
- Produces:
  - `interface AgentExtras { toolChecks?: Record<string, ToolCheck>; toolCheckFallback?: "allow"|"deny"; cwd?: string; contextFiles?: string[]; attachDirs?: string[]; promptSuffix?: string; }`
  - `interface AgentDef { manifest: AgentManifest; role: RoleDef; department: string; }`
  - `interface LoadedRegistry { agents: Map<string, AgentDef>; departments: Map<string, DepartmentManifest & { toolsUnion: string[] }>; agentOf: Map<string, string>; ownerOfPlaybook: Map<string, string>; playbooks: Map<string, Playbook>; }`
  - `loadRegistry(agentsDir: string, playbooksDir: string, extras?: Record<string, AgentExtras>, log?: (l: string) => void): LoadedRegistry`
  - `dropDepartment(reg: LoadedRegistry, dept: string): void`
  - `LEGACY_DISABLE_ALIAS: Record<string, string>` = `{ code: "engineering", money: "finance", research: "research", lifeops: "life" }`
  - `disabledDepartments(env: NodeJS.ProcessEnv, deptNames: Iterable<string>): Set<string>` — union of `AIOS_<DEPT>_DISABLED==="1"` and legacy alias keys.
- Also add `attachDirs?: string[]` to `RoleDef` in `src/agents/roles/index.ts` (optional field, used by Task 8).

**Compile rule (agent manifest → RoleDef):**
`{ name, description: title + " — " + first sentence of charter, systemPrompt: persona + "\n\n" + prompt + (extras.promptSuffix ?? ""), allowedTools: tools, permissionMode, maxTurns, skills, privateOnly: visibility === "private", outputSchema: SCHEMA_BY_NAME[outputSchema], cwd/contextFiles/toolChecks/toolCheckFallback/attachDirs from extras }` where `SCHEMA_BY_NAME = { verdict: VERDICT_SCHEMA, "test-report": TEST_REPORT_SCHEMA }` (import from roles/index.ts).

**Load rules (all fail-soft with loud log):**
1. Scan `agentsDir` subdirs; each with `department.yaml` is a department. Bad department.yaml → skip whole department. Duplicate department name → skip later.
2. Every other `*.yaml` in the dept dir is an agent manifest. Bad manifest → skip agent. `manifest.department !== dirName` → skip agent. Duplicate agent `name` or `alias` (collides with any existing name or alias) → skip later, log.
3. Playbooks: scan `playbooksDir` exactly like today's `loadPacks` (top-level `*.yaml` + one level of subdir `*.yaml`, ignoring `pack.yaml`/`department.yaml` files) into `playbooks`. Department claims its `playbooks` by name → `ownerOfPlaybook.set(name, dept)`; a department referencing a missing playbook name is skipped entirely (mirrors pack behavior). Unclaimed playbooks are packless (echo, code-inplace).
4. `departments.get(d).toolsUnion` = ordered dedupe of all member agents' `tools`.
5. `agentOf` maps every agent name AND every alias → agent name.
6. `dropDepartment` deletes the department, its agents (and their agentOf entries incl. aliases), and its ownerOfPlaybook + playbooks entries (playbooks stay loaded only if another department claims them — they can't; delete them like `dropPack` does).

- [ ] **Step 1: Write the failing test** (fixture tree built in a temp dir)

```ts
// test/registry-loader.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, dropDepartment, disabledDepartments } from "../src/agents/registry/loader.js";

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), "aios-reg-"));
  const agents = join(root, "agents");
  const pbs = join(root, "playbooks");
  mkdirSync(join(agents, "engineering"), { recursive: true });
  mkdirSync(pbs, { recursive: true });
  writeFileSync(join(pbs, "echo.yaml"),
    "name: echo\ndescription: smoke\nstages:\n  - type: single\n    id: echo\n    role: ziad\n");
  writeFileSync(join(pbs, "eng-build.yaml"),
    "name: eng-build\ndescription: build\nstages:\n  - type: single\n    id: impl\n    role: maya\n");
  writeFileSync(join(agents, "engineering", "department.yaml"),
    "department: engineering\nmission: Build software.\nmemoDomain: code\nplaybooks: [eng-build]\n");
  writeFileSync(join(agents, "engineering", "maya.yaml"),
    "name: maya\ntitle: Senior Engineer\ndepartment: engineering\ncharter: Owns code changes.\npersona: Terse.\nprompt: You are an engineer.\ntools: [Read, Edit]\npermissionMode: bypassPermissions\nmaxTurns: 80\naliases: [developer]\n");
  writeFileSync(join(agents, "engineering", "ziad.yaml"),
    "name: ziad\ntitle: Eng Researcher\ndepartment: engineering\ncharter: Investigates.\npersona: Fast.\nprompt: You research.\ntools: [Read, Grep]\n");
  return { root, agents, pbs };
}

describe("loadRegistry", () => {
  let t: ReturnType<typeof scaffold>;
  beforeEach(() => { t = scaffold(); });

  it("loads agents, departments, aliases, playbook ownership, tools union", () => {
    const reg = loadRegistry(t.agents, t.pbs);
    expect([...reg.agents.keys()].sort()).toEqual(["maya", "ziad"]);
    expect(reg.agentOf.get("developer")).toBe("maya");
    expect(reg.ownerOfPlaybook.get("eng-build")).toBe("engineering");
    expect(reg.ownerOfPlaybook.has("echo")).toBe(false);        // packless
    expect(reg.playbooks.has("echo")).toBe(true);
    expect(reg.departments.get("engineering")!.toolsUnion).toEqual(["Read", "Edit", "Grep"]);
    const maya = reg.agents.get("maya")!;
    expect(maya.role.permissionMode).toBe("bypassPermissions");
    expect(maya.role.systemPrompt).toContain("Terse.");
    expect(maya.role.systemPrompt).toContain("You are an engineer.");
  });

  it("skips an agent whose department field mismatches its directory", () => {
    writeFileSync(join(t.agents, "engineering", "imp.yaml"),
      "name: imp\ntitle: T\ndepartment: research\ncharter: c\npersona: p\nprompt: s\n");
    const reg = loadRegistry(t.agents, t.pbs);
    expect(reg.agents.has("imp")).toBe(false);
  });

  it("skips duplicate names and colliding aliases, keeps first", () => {
    writeFileSync(join(t.agents, "engineering", "zz-dup.yaml"),
      "name: maya\ntitle: T\ndepartment: engineering\ncharter: c\npersona: p\nprompt: s\n");
    writeFileSync(join(t.agents, "engineering", "zz-alias.yaml"),
      "name: newbie\ntitle: T\ndepartment: engineering\ncharter: c\npersona: p\nprompt: s\naliases: [developer]\n");
    const reg = loadRegistry(t.agents, t.pbs);
    expect(reg.agents.get("maya")!.manifest.title).toBe("Senior Engineer");
    expect(reg.agentOf.get("developer")).toBe("maya");
    expect(reg.agents.has("newbie")).toBe(true);                 // agent loads, alias dropped
  });

  it("skips a department referencing a missing playbook", () => {
    mkdirSync(join(t.agents, "ghost"));
    writeFileSync(join(t.agents, "ghost", "department.yaml"),
      "department: ghost\nmission: m\nmemoDomain: general\nplaybooks: [nope]\n");
    const reg = loadRegistry(t.agents, t.pbs);
    expect(reg.departments.has("ghost")).toBe(false);
  });

  it("applies extras (guards, cwd, promptSuffix)", () => {
    const reg = loadRegistry(t.agents, t.pbs, {
      maya: { cwd: "/x", promptSuffix: "\n\nEXTRA", toolCheckFallback: "deny" },
    });
    const maya = reg.agents.get("maya")!;
    expect(maya.role.cwd).toBe("/x");
    expect(maya.role.systemPrompt.endsWith("EXTRA")).toBe(true);
    expect(maya.role.toolCheckFallback).toBe("deny");
  });

  it("dropDepartment removes agents, aliases, playbooks", () => {
    const reg = loadRegistry(t.agents, t.pbs);
    dropDepartment(reg, "engineering");
    expect(reg.agents.size).toBe(0);
    expect(reg.agentOf.has("developer")).toBe(false);
    expect(reg.playbooks.has("eng-build")).toBe(false);
    expect(reg.playbooks.has("echo")).toBe(true);
  });

  it("disabledDepartments honors new + legacy env names", () => {
    const out = disabledDepartments(
      { AIOS_ENGINEERING_DISABLED: "1", AIOS_MONEY_DISABLED: "1" } as NodeJS.ProcessEnv,
      ["engineering", "finance", "research"],
    );
    expect(out).toEqual(new Set(["engineering", "finance"]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/registry-loader.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// src/agents/registry/loader.ts
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadPlaybook, type Playbook } from "../../engine/playbook.js";
import { agentSchema, departmentSchema, type AgentManifest, type DepartmentManifest } from "./types.js";
import { VERDICT_SCHEMA, TEST_REPORT_SCHEMA, type RoleDef } from "../roles/index.js";
import type { ToolCheck } from "../guards/halalo-readonly.js";

const SCHEMA_BY_NAME: Record<string, Record<string, unknown>> = {
  verdict: VERDICT_SCHEMA as unknown as Record<string, unknown>,
  "test-report": TEST_REPORT_SCHEMA as unknown as Record<string, unknown>,
};

/** Code-side extras merged into the compiled RoleDef (guards, env-dependent paths, prompt suffixes). */
export interface AgentExtras {
  toolChecks?: Record<string, ToolCheck>;
  toolCheckFallback?: "allow" | "deny";
  cwd?: string;
  contextFiles?: string[];
  attachDirs?: string[];
  promptSuffix?: string;
}

export interface AgentDef {
  manifest: AgentManifest;
  role: RoleDef;
  department: string;
}

export type LoadedDepartment = DepartmentManifest & { toolsUnion: string[] };

export interface LoadedRegistry {
  agents: Map<string, AgentDef>;
  departments: Map<string, LoadedDepartment>;
  /** name OR alias → canonical agent name */
  agentOf: Map<string, string>;
  ownerOfPlaybook: Map<string, string>;
  playbooks: Map<string, Playbook>;
}

export const LEGACY_DISABLE_ALIAS: Record<string, string> = {
  code: "engineering", money: "finance", research: "research", lifeops: "life",
};

export function disabledDepartments(env: NodeJS.ProcessEnv, deptNames: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const d of deptNames) if (env[`AIOS_${d.toUpperCase()}_DISABLED`] === "1") out.add(d);
  for (const [legacy, dept] of Object.entries(LEGACY_DISABLE_ALIAS)) {
    if (env[`AIOS_${legacy.toUpperCase()}_DISABLED`] === "1") out.add(dept);
  }
  return out;
}

function compile(m: AgentManifest, x: AgentExtras = {}): RoleDef {
  return {
    name: m.name,
    description: `${m.title} — ${m.charter.trim().split(/(?<=\.)\s/)[0]}`,
    systemPrompt: `${m.persona.trim()}\n\n${m.prompt.trim()}${x.promptSuffix ?? ""}`,
    allowedTools: m.tools,
    permissionMode: m.permissionMode,
    maxTurns: m.maxTurns,
    ...(m.skills.length ? { skills: m.skills } : {}),
    ...(m.visibility === "private" ? { privateOnly: true } : {}),
    ...(m.outputSchema ? { outputSchema: SCHEMA_BY_NAME[m.outputSchema] } : {}),
    ...(x.cwd ? { cwd: x.cwd } : {}),
    ...(x.contextFiles ? { contextFiles: x.contextFiles } : {}),
    ...(x.toolChecks ? { toolChecks: x.toolChecks } : {}),
    ...(x.toolCheckFallback ? { toolCheckFallback: x.toolCheckFallback } : {}),
    ...(x.attachDirs ? { attachDirs: x.attachDirs } : {}),
  };
}

/** Scan playbooksDir like loadPacks: top-level *.yaml + one subdir level; manifest files ignored. */
function scanPlaybooks(dir: string, log: (l: string) => void): Map<string, Playbook> {
  const out = new Map<string, Playbook>();
  const tryLoad = (full: string, label: string) => {
    try { const pb = loadPlaybook(full); out.set(pb.name, pb); }
    catch (err) { log(`playbook ${label} skipped: ${(err as Error).message}`); }
  };
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory()) {
        for (const f of readdirSync(full)) {
          if (!/\.ya?ml$/.test(f) || f === "pack.yaml" || f === "department.yaml") continue;
          tryLoad(join(full, f), `${entry}/${f}`);
        }
      } else if (/\.ya?ml$/.test(entry)) {
        tryLoad(full, entry);
      }
    } catch (err) {
      log(`playbooks entry ${entry} skipped: ${(err as Error).message}`);
    }
  }
  return out;
}

export function loadRegistry(
  agentsDir: string,
  playbooksDir: string,
  extras: Record<string, AgentExtras> = {},
  log: (l: string) => void = () => {},
): LoadedRegistry {
  const agents = new Map<string, AgentDef>();
  const departments = new Map<string, LoadedDepartment>();
  const agentOf = new Map<string, string>();
  const ownerOfPlaybook = new Map<string, string>();
  const playbooks = scanPlaybooks(playbooksDir, log);

  for (const dirName of existsSync(agentsDir) ? readdirSync(agentsDir) : []) {
    const dirPath = join(agentsDir, dirName);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
      const deptPath = join(dirPath, "department.yaml");
      if (!existsSync(deptPath)) continue;

      let dept: DepartmentManifest;
      try { dept = departmentSchema.parse(parse(readFileSync(deptPath, "utf8"))); }
      catch (err) { log(`department ${dirName} skipped: invalid manifest — ${(err as Error).message}`); continue; }
      if (dept.department !== dirName) { log(`department ${dirName} skipped: name mismatch "${dept.department}"`); continue; }
      if (departments.has(dept.department)) { log(`department ${dirName} skipped: duplicate`); continue; }
      if (dept.playbooks.some((p) => !playbooks.has(p))) {
        log(`department ${dirName} skipped: playbook missing — ${dept.playbooks.filter((p) => !playbooks.has(p)).join(", ")}`);
        continue;
      }

      const members: AgentDef[] = [];
      for (const f of readdirSync(dirPath).sort()) {
        if (!/\.ya?ml$/.test(f) || f === "department.yaml") continue;
        let m: AgentManifest;
        try { m = agentSchema.parse(parse(readFileSync(join(dirPath, f), "utf8"))); }
        catch (err) { log(`agent ${dirName}/${f} skipped: ${(err as Error).message}`); continue; }
        if (m.department !== dirName) { log(`agent ${dirName}/${f} skipped: department mismatch`); continue; }
        if (agents.has(m.name) || agentOf.has(m.name)) { log(`agent ${dirName}/${f} skipped: duplicate name "${m.name}"`); continue; }
        const def: AgentDef = { manifest: m, role: compile(m, extras[m.name]), department: dept.department };
        agents.set(m.name, def);
        agentOf.set(m.name, m.name);
        for (const a of m.aliases) {
          if (agentOf.has(a)) { log(`agent ${m.name}: alias "${a}" dropped (already taken)`); continue; }
          agentOf.set(a, m.name);
        }
        members.push(def);
      }

      departments.set(dept.department, {
        ...dept,
        toolsUnion: [...new Set(members.flatMap((a) => a.manifest.tools))],
      });
      for (const pb of dept.playbooks) ownerOfPlaybook.set(pb, dept.department);
    } catch (err) {
      log(`agents entry ${dirName} skipped: ${(err as Error).message}`);
    }
  }
  return { agents, departments, agentOf, ownerOfPlaybook, playbooks };
}

/** Kill-switch: remove a department, its agents/aliases, and its playbooks. */
export function dropDepartment(reg: LoadedRegistry, dept: string): void {
  const d = reg.departments.get(dept);
  if (!d) return;
  for (const [name, def] of [...reg.agents]) {
    if (def.department !== dept) continue;
    reg.agents.delete(name);
    for (const [k, v] of [...reg.agentOf]) if (v === name) reg.agentOf.delete(k);
  }
  for (const pb of d.playbooks) { reg.playbooks.delete(pb); reg.ownerOfPlaybook.delete(pb); }
  reg.departments.delete(dept);
}
```

Also in `src/agents/roles/index.ts`, add to `RoleDef` (after `privateOnly`):

```ts
  /** Extra absolute dirs the attachment server may serve from for this role (e.g. vault receipts). */
  attachDirs?: string[];
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/registry-loader.test.ts test/registry-types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/registry/loader.ts src/agents/roles/index.ts test/registry-loader.test.ts
git commit -m "feat(staff): registry loader — manifests compiled to RoleDef, dept kill-switches"
```

---

### Task 3: Author the real `agents/` tree + extras registry + legacy-parity pin

**Files:**
- Create: `agents/operations/department.yaml`, `agents/operations/rami.yaml`
- Create: `agents/engineering/department.yaml` + `kai.yaml maya.yaml tarek.yaml nadia.yaml omar.yaml ziad.yaml`
- Create: `agents/research/department.yaml` + `lina.yaml sami.yaml dalia.yaml yara.yaml`
- Create: `agents/finance/department.yaml` + `faris.yaml salim.yaml`
- Create: `agents/life/department.yaml` + `jasmine.yaml`
- Create: `agents/clients/department.yaml` + `halalo.yaml`
- Create: `src/agents/registry/extras.ts`
- Test: `test/registry-live-tree.test.ts`

**Interfaces:**
- Produces: `buildExtras(cfg: { vaultPath: string; vaultSubdir: string; financeCompany: string; financeMembers: FinanceMember[] }): Record<string, AgentExtras>` in extras.ts.
- The real tree loads with `loadRegistry(join(process.cwd(), "agents"), join(process.cwd(), "playbooks"), buildExtras(...))`.

**Department manifests (exact content):**

```yaml
# agents/operations/department.yaml
department: operations
mission: Intake, triage, routing, and follow-up. The front door of AIOS.
lead: rami
memoDomain: general
actions: []
playbooks: []
```

```yaml
# agents/engineering/department.yaml
department: engineering
mission: Build, test, review, and operate software safely in sandboxed workspaces.
lead: kai
memoDomain: code
vaultSection: code
actions: [vault.write]
sandbox: true
playbooks: [code-build, code-analyze]
```

```yaml
# agents/research/department.yaml
department: research
mission: Investigate deeply, verify sources, grow the knowledge base.
lead: lina
memoDomain: research
vaultSection: knowledge
toolServer: research
actions: [vault.write]
playbooks: [research-report, market-research, product-design]
```

```yaml
# agents/finance/department.yaml
department: finance
mission: Personal money visibility (read-only) and the group expense ledger.
lead: faris
memoDomain: money
toolServer: money
actions: []
playbooks: []
```

```yaml
# agents/life/department.yaml
department: life
mission: Personal operations — open loops, errands, follow-ups.
lead: jasmine
memoDomain: lifeops
toolServer: lifeops
actions: []
playbooks: []
```

```yaml
# agents/clients/department.yaml
department: clients
mission: Client-project agents — read-only experts on external systems.
lead: halalo
memoDomain: general
actions: []
playbooks: []
```

**Agent manifests.** Two full exemplars; the rest follow the exact field table below with `prompt:` copied **verbatim** from the named source.

```yaml
# agents/engineering/maya.yaml
name: maya
title: Senior Engineer
department: engineering
charter: >
  Owns implementing code changes in sandboxed workspaces: features,
  refactors, fixes. Hand me an approved design or a bug report.
persona: >
  Pragmatic and terse. Ships small verifiable diffs, matches the existing
  style, and says "I don't know" instead of guessing.
prompt: >
  You are the Developer in a multi-agent system. Implement the approved
  design in the working directory. Write clean, idiomatic code matching the
  existing style. Run builds to verify. If test failures are provided, fix
  them. Finish with a markdown implementation summary: what was built, files
  changed, how to run it, notable decisions.
tools: [Read, Grep, Glob, Edit, Write, Bash, TodoWrite]
maxTurns: 80
permissionMode: bypassPermissions
aliases: [developer]
```

```yaml
# agents/finance/faris.yaml
name: faris
title: CFO
department: finance
charter: >
  Private personal CFO: bank transactions, subscriptions, budgets.
  Read-only on the bank; answers only in the user's private chat.
persona: >
  Discreet and precise. Speaks in amounts, categories, and trends;
  flags anomalies without drama.
prompt: >
  You are the user's private personal CFO. You have read-only visibility
  into their personal bank transactions (via the money tools) plus their
  subscriptions and budgets. You NEVER initiate or suggest payments or
  transfers — banking is strictly read-only. You discuss finances ONLY with
  the user in private; if anyone else is present or you are addressed from a
  shared/group context, refuse and say money topics are private. Be concise
  and concrete: amounts, categories, trends. Use set_category_rule when the
  user corrects a categorization so you learn it.
tools: []
maxTurns: 20
visibility: private
aliases: [cfo]
```

**Field table for the remaining manifests** (prompt sources are `src/agents/roles/index.ts` — copy each role's `systemPrompt` string verbatim into `prompt:`; write each `charter:`/`persona:` from the spec §3 roster, 1–3 sentences in the voice shown above):

| File | name | title | tools | maxTurns | permissionMode | visibility | outputSchema | skills | aliases | prompt source |
|---|---|---|---|---|---|---|---|---|---|---|
| operations/rami.yaml | rami | Chief of Staff | [] | 40 | dontAsk | shared | — | — | [moderator] | NEW (Task 7 wires it; prompt: "You are Rami, the Chief of Staff of AIOS." — session builds the operational body) |
| engineering/kai.yaml | kai | Architect | [Read, Grep, Glob] | 25 | dontAsk | shared | — | — | [architect] | roles.architect |
| engineering/tarek.yaml | tarek | QA Engineer | [Read, Grep, Glob, Edit, Write, Bash] | 40 | bypassPermissions | shared | test-report | — | [tester] | roles.tester |
| engineering/nadia.yaml | nadia | Code Reviewer | [Read, Grep, Glob, Bash] | 30 | dontAsk | shared | — | — | [code-reviewer] | roles["code-reviewer"] |
| engineering/omar.yaml | omar | DevOps Engineer | [Read, Grep, Glob, Edit, Write, WebSearch, WebFetch, TodoWrite] | 40 | default | shared | — | — | [devops] | roles.devops |
| engineering/ziad.yaml | ziad | Eng Researcher | [Read, Grep, Glob, WebSearch, WebFetch] | 30 | dontAsk | shared | — | — | [researcher] | roles.researcher |
| research/lina.yaml | lina | Analyst / Librarian | [Read, Grep, Glob, WebSearch, WebFetch, recall, vault_read, vault_write, mcp__research__save_source, mcp__research__list_sources, mcp__research__search_sources] | 25 | dontAsk | shared | — | — | [analyst] | roles.analyst |
| research/sami.yaml | sami | Market Researcher | [Read, Grep, Glob, WebSearch, WebFetch] | 40 | dontAsk | shared | — | [market-sizing] | [market-researcher] | roles["market-researcher"] |
| research/dalia.yaml | dalia | UI/UX Designer | [Read, Grep, Glob, WebSearch, WebFetch] | 30 | dontAsk | shared | — | [design-tokens] | [ui-ux-designer] | roles["ui-ux-designer"] |
| research/yara.yaml | yara | Research Reviewer | [Read, Grep, Glob] | 15 | dontAsk | shared | verdict | — | [reviewer] | roles.reviewer |
| finance/salim.yaml | salim | Bookkeeper | [mcp__ledger__add_expense, mcp__ledger__remove_expense, mcp__ledger__list_expenses, mcp__ledger__settle, mcp__ledger__export_csv, mcp__ledger__send_receipt, Read, mcp__aios_attachments__attach_file] | 30 | dontAsk | shared | — | — | [finance] | `financePrompt()` body from `src/finance/agent.ts:39-73` minus the roster line (roster comes via extras promptSuffix) |
| life/jasmine.yaml | jasmine | Personal Ops | [] | 20 | dontAsk | private | — | — | [] | roles.jasmine |
| clients/halalo.yaml | halalo | Halalo Project Agent | [Read, Grep, Glob, Write, WebSearch, WebFetch, TodoWrite, mcp__aios_attachments__attach_file, mcp__halalo_analytics__cloudflare_analytics] | 60 | default | shared | — | — | [] | roles.halalo (drop the two template-literal HALALO_EXPORTS_DIR interpolations by writing the literal path `~/.aios/halalo-exports` text as it resolves today — copy the resolved constant value from `HALALO_EXPORTS_DIR`) |

**Notes:** yara gets the shared `reviewer` alias (research owns the generic name; engineering pipelines reference `nadia`/`tarek` etc. — playbook role rename happens in Task 5). `visibility: private` for faris + jasmine.

**extras.ts (exact content):**

```ts
// src/agents/registry/extras.ts
import { join } from "node:path";
import { halaloToolChecks, HALALO_EXPORTS_DIR } from "../guards/halalo-readonly.js";
import type { AgentExtras } from "./loader.js";
import type { FinanceMember } from "../../config.js";

const HALALO_DIR =
  process.env.AIOS_HALALO_DIR ?? "/Users/ihabbishara/projects/halalo-php-source/halalo";

export interface ExtrasConfig {
  vaultPath: string;
  vaultSubdir: string;
  financeCompany: string;
  financeMembers: FinanceMember[];
}

/** Env-dependent role parts that cannot live in YAML: guards, machine paths, config-derived prompt bits. */
export function buildExtras(cfg: ExtrasConfig): Record<string, AgentExtras> {
  const roster = cfg.financeMembers
    .map((m) => (m.handle ? `${m.name} (@${m.handle})` : m.name)).join(", ");
  return {
    halalo: {
      cwd: HALALO_DIR,
      contextFiles: [join(HALALO_DIR, "CLAUDE.md")],
      toolChecks: halaloToolChecks(HALALO_DIR),
      toolCheckFallback: "deny",
      attachDirs: [HALALO_EXPORTS_DIR],
    },
    salim: {
      promptSuffix: `\n\nCompany: ${cfg.financeCompany}. Team members sharing costs equally (${cfg.financeMembers.length}): ${roster}.`,
      attachDirs: [join(cfg.vaultPath, cfg.vaultSubdir, "attachments"), "/tmp/aios-"],
    },
  };
}
```

- [ ] **Step 1: Write the failing live-tree test**

```ts
// test/registry-live-tree.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildExtras } from "../src/agents/registry/extras.js";
import { roles } from "../src/agents/roles/index.js";

const reg = loadRegistry(
  join(process.cwd(), "agents"),
  join(process.cwd(), "playbooks"),
  buildExtras({ vaultPath: "/tmp/v", vaultSubdir: "AIOS", financeCompany: "IDAMA", financeMembers: [{ name: "Ihab" }] }),
);

describe("live agents/ tree", () => {
  it("loads 6 departments and 15 agents", () => {
    expect([...reg.departments.keys()].sort()).toEqual(
      ["clients", "engineering", "finance", "life", "operations", "research"]);
    expect(reg.agents.size).toBe(15);
  });

  it("legacy @role aliases resolve", () => {
    for (const [alias, name] of Object.entries({
      developer: "maya", architect: "kai", tester: "tarek", "code-reviewer": "nadia",
      devops: "omar", researcher: "ziad", analyst: "lina", "market-researcher": "sami",
      "ui-ux-designer": "dalia", reviewer: "yara", cfo: "faris", finance: "salim",
    })) expect(reg.agentOf.get(alias), alias).toBe(name);
  });

  it("compiled roles preserve the legacy security surface", () => {
    const pin: Array<[string, string]> = [
      ["maya", "developer"], ["kai", "architect"], ["tarek", "tester"],
      ["nadia", "code-reviewer"], ["omar", "devops"], ["ziad", "researcher"],
      ["sami", "market-researcher"], ["dalia", "ui-ux-designer"], ["yara", "reviewer"],
      ["lina", "analyst"], ["faris", "cfo"], ["jasmine", "jasmine"], ["halalo", "halalo"],
    ];
    for (const [agent, legacy] of pin) {
      const compiled = reg.agents.get(agent)!.role;
      const old = roles[legacy];
      expect(compiled.permissionMode, agent).toBe(old.permissionMode);
      expect(compiled.maxTurns, agent).toBe(old.maxTurns);
      expect([...compiled.allowedTools].sort(), agent).toEqual([...old.allowedTools].sort());
      expect(!!compiled.privateOnly, agent).toBe(!!old.privateOnly);
      expect(!!compiled.outputSchema, agent).toBe(!!old.outputSchema);
    }
  });

  it("halalo extras wire the deterministic guard", () => {
    const h = reg.agents.get("halalo")!.role;
    expect(h.toolCheckFallback).toBe("deny");
    expect(h.toolChecks?.Bash).toBeDefined();
  });

  it("private agents are faris and jasmine only", () => {
    const priv = [...reg.agents.values()].filter((a) => a.role.privateOnly).map((a) => a.manifest.name).sort();
    expect(priv).toEqual(["faris", "jasmine"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** (`agents/` missing)

Run: `npx vitest run test/registry-live-tree.test.ts`
Expected: FAIL — departments empty

- [ ] **Step 3: Author all 21 manifests + extras.ts per the tables above.**
Note: playbooks referenced by engineering/research department.yaml already exist at `playbooks/code/*.yaml` and `playbooks/research/*.yaml` (scanned by subdir); `pack.yaml` files are NOT deleted yet (Task 5) — the scanner ignores them.
The salim tools listed will exist after Task 8; manifest can reference them now (tool names are data).

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/registry-live-tree.test.ts`
Expected: PASS. Then full suite still green: `npx vitest run` (registry is not yet wired — nothing changes).

- [ ] **Step 5: Commit**

```bash
git add agents/ src/agents/registry/extras.ts test/registry-live-tree.test.ts
git commit -m "feat(staff): the staff — 6 departments, 15 named agent manifests + extras"
```

---

### Task 4: Department resolver + registry-driven runner/direct

**Files:**
- Modify: `src/packs/resolve.ts`
- Modify: `src/agents/runner.ts` (makeRunSpecialist lookup)
- Modify: `src/agents/direct.ts` (registry lookup, sender prefix)
- Test: `test/registry-resolve.test.ts`

**Interfaces:**
- Consumes: `LoadedRegistry` (Task 2).
- Produces:
  - resolve.ts: `export function makeResolveDeptFor(reg: LoadedRegistry, deps: {store; vault; gate; toolServers?}): (key: string, origin, byAgent?: boolean, workspace?) => ResolvedPack | undefined` — `byAgent` resolves via `agentOf`→agent.department; else `ownerOfPlaybook`. Department → the existing `resolvePack` shape by adapting: `resolvePack({ pillar: d.department, persona: d.mission, memoDomain, vaultSection, toolServer, tools: d.toolsUnion, actions, roles: [], playbooks, sandbox }, deps)`. Keep `resolvePack`/`ResolvedPack`/`MCP_TOOL_NAMES` exports unchanged (money/code tests pin them). Keep `makeResolvePackFor` working during migration by re-export shim: `export const makeResolvePackFor = ...` stays until Task 5 deletes callers, then remove.
  - runner.ts: `makeRunSpecialist(deps: { store; bus; registry: LoadedRegistry })` — lookup `deps.registry.agents.get(deps.registry.agentOf.get(roleName) ?? roleName)?.role`; throw `Unknown agent: <name>` when absent. (Signature change: all constructors get registry from index.ts in Task 5; keep the old `roles`-map fallback OUT — tests construct with a registry.)
  - direct.ts: `DirectChatsDeps` gains `registry: LoadedRegistry`; `handle(role, channel, chatId, userText, sender?)` resolves via `agentOf` (aliases work), prefixes `[from: Name (@user)]\n` when `sender` provided; `roleNames()` becomes instance method `names()` returning `[...registry.agentOf.keys()]`; safeDirs append `def.attachDirs ?? []`; `parseDirectAddress(text, names)` now takes the names list (router passes registry names).

- [ ] **Step 1: Write the failing test**

```ts
// test/registry-resolve.test.ts
import { describe, it, expect } from "vitest";
// scaffold: reuse the Task-2 fixture builder (copy the scaffold() helper into this file),
// extend engineering/department.yaml with "toolServer: money"-free basics and add a
// finance dept with toolServer money to assert builder wiring:
//   agents/finance/department.yaml: department finance / mission m / memoDomain money / toolServer money
//   agents/finance/faris.yaml: tools [mcp__money__spending_summary, recall]
import { makeResolveDeptFor } from "../src/packs/resolve.js";
// build a LoadedRegistry via loadRegistry on the fixture, with in-memory Store/Vault/Gate
// exactly like test/code-pack-resolve.test.ts does today (copy its dep construction).

describe("makeResolveDeptFor", () => {
  it("resolves a playbook to its owning department (tools = union, mapped)", () => {
    const resolve = makeResolveDeptFor(reg, deps);
    const r = resolve("eng-build", { channel: "cli", chatId: "x" })!;
    expect(r.pillar).toBe("engineering");
    expect(r.tools).toContain("Read");
  });
  it("resolves an agent (and its alias) to its department", () => {
    const resolve = makeResolveDeptFor(reg, deps);
    expect(resolve("maya", { channel: "cli", chatId: "x" }, true)!.pillar).toBe("engineering");
    expect(resolve("developer", { channel: "cli", chatId: "x" }, true)!.pillar).toBe("engineering");
  });
  it("maps bare MCP names to the scoped pack server and builds the named toolServer", () => {
    const resolve = makeResolveDeptFor(reg, depsWithMoneyBuilder);
    const r = resolve("faris", { channel: "cli", chatId: "x" }, true)!;
    expect(r.tools).toContain("mcp__aios-pack__recall");
    expect(Object.keys(r.mcpServers)).toContain("money");
  });
  it("returns undefined for unknown keys", () => {
    const resolve = makeResolveDeptFor(reg, deps);
    expect(resolve("nope", { channel: "cli", chatId: "x" })).toBeUndefined();
    expect(resolve("nope", { channel: "cli", chatId: "x" }, true)).toBeUndefined();
  });
});
```

(Write the fixture/dep scaffolding concretely by copying the patterns from `test/code-pack-resolve.test.ts` — same Store/Vault/Gate fakes, same tmpdir manifests.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/registry-resolve.test.ts`
Expected: FAIL — `makeResolveDeptFor` not exported

- [ ] **Step 3: Implement** resolve.ts addition:

```ts
// append to src/packs/resolve.ts
import type { LoadedRegistry } from "../agents/registry/loader.js";

/** Registry-driven resolver: playbook → owning department; agent (byAgent) → its department. */
export function makeResolveDeptFor(
  reg: LoadedRegistry,
  deps: { store: Store; vault: VaultWriter; gate: ActionGate; toolServers?: Record<string, PackToolServerBuilder> },
) {
  return (
    key: string,
    origin: { channel: string; chatId: string },
    byAgent = false,
    workspace?: { taskDir: string; mode: "build" | "analyze" },
  ): ResolvedPack | undefined => {
    const deptName = byAgent
      ? reg.agents.get(reg.agentOf.get(key) ?? key)?.department
      : reg.ownerOfPlaybook.get(key);
    if (!deptName) return undefined;
    const d = reg.departments.get(deptName);
    if (!d) return undefined;
    return resolvePack(
      {
        pillar: d.department, persona: d.mission, memoDomain: d.memoDomain,
        vaultSection: d.vaultSection, toolServer: d.toolServer,
        tools: d.toolsUnion, actions: d.actions, roles: [], playbooks: d.playbooks, sandbox: d.sandbox,
      },
      { store: deps.store, vault: deps.vault, gate: deps.gate, origin, toolServers: deps.toolServers, workspace },
    );
  };
}
```

runner.ts: replace `import { roles, type RoleDef }` usage inside `makeRunSpecialist` —

```ts
export function makeRunSpecialist(deps: { store: Store; bus: EventBus; registry: LoadedRegistry }): SpecialistRunFn {
  return async (roleName, brief, opts) => {
    const canonical = deps.registry.agentOf.get(roleName) ?? roleName;
    const role = deps.registry.agents.get(canonical)?.role;
    if (!role) throw new Error(`Unknown agent: ${roleName}`);
    // ...rest identical...
```

direct.ts: deps gain `registry`; `handle` becomes

```ts
async handle(role: string, channel: string, chatId: string, userText: string,
             sender?: { name?: string; username?: string }) {
  const canonical = this.deps.registry.agentOf.get(role);
  const def = canonical ? this.deps.registry.agents.get(canonical)?.role : undefined;
  if (!def || !canonical) throw new Error(`Unknown specialist: ${role}`);
  // ...privateOnly check unchanged...
  const key = `direct-session:${canonical}:${channel}:${chatId}`;   // canonical → alias + name share one session
  const prompt = sender ? `[from: ${sender.name ?? "?"}${sender.username ? ` (@${sender.username})` : ""}]\n${userText}` : userText;
  // pack: this.deps.resolvePackFor?.(canonical, {channel, chatId})
  // safeDirs: [...existing, ...(def.attachDirs ?? [])]
  // resumableTurn prompt: prompt
```

`names(): string[] { return [...this.deps.registry.agentOf.keys()]; }` replaces static `roleNames()`. `parseDirectAddress(text: string, names: string[])` — drop the roles-map import; router supplies names. Keep the halalo cloudflare special-case keyed on `canonical === "halalo"`.

- [ ] **Step 4: Run tests** — new file passes; expect existing `test/direct.test.ts`, `test/cfo-role.test.ts`, `test/lifeops-role.test.ts`, `test/code-runner-clamp.test.ts` etc. to FAIL compilation (constructor deps changed). Update those constructors to pass a registry built from the live tree (`loadRegistry(join(process.cwd(),"agents"), join(process.cwd(),"playbooks"), buildExtras(...))` — export one shared helper `testRegistry()` from `test/fixtures/registry.ts` and reuse). Role-name strings in those tests keep working via aliases (`developer`, `cfo`, `jasmine`).

Run: `npx vitest run`
Expected: PASS (all updated)

- [ ] **Step 5: Commit**

```bash
git add -A src test
git commit -m "feat(staff): dept resolver + registry-driven runner/direct (aliases, sender prefix)"
```

---

### Task 5: Boot on the registry — index.ts switch, pack.yaml removal

**Files:**
- Modify: `src/index.ts`
- Modify: `src/router.ts` (reset command names from registry)
- Modify: `src/web/server.ts`, `src/web/permissions-view.ts`, `src/web/packs-view.ts` (compile fixes only: read departments from registry-shaped data; `/api/packs` keeps serving department cards by scanning `agents/*/department.yaml` instead of `playbooks/*/pack.yaml`)
- Delete: `playbooks/code/pack.yaml`, `playbooks/money/pack.yaml`, `playbooks/research/pack.yaml`, `playbooks/lifeops/pack.yaml`
- Delete: `src/packs/loader.ts` (+ its tests `test/code-pack-loader.test.ts` reworked against `loadRegistry`), `packSchema` usages migrate to `departmentSchema`
- Test: `test/registry-boot.test.ts` (+ update `test/code-killswitch.test.ts`, `test/pack-killswitch.test.ts` to the new loader)

**Interfaces:**
- Consumes: everything above.
- Produces: index.ts boots `const registry = loadRegistry(config.agentsDir, config.playbooksDir, buildExtras(config), log)` then `for (const d of disabledDepartments(process.env, registry.departments.keys())) dropDepartment(registry, d)`. `config.agentsDir` added to `src/config.ts` (default `join(process.cwd(), "agents")`, env `AIOS_AGENTS_DIR`). `reloadPacks` → `reloadRegistry` (same in-place Map mutation, now over 5 maps). JobManager gets `pillarOf: registry.ownerOfPlaybook`, `playbooks: registry.playbooks`, `resolvePackFor: (pb, origin, sandbox) => resolveDeptFor(pb, origin, false, sandbox)`. DirectChats gets `registry` + `resolvePackFor: (agent, origin) => resolveDeptFor(agent, origin, true)`. `makeRunSpecialist({store, bus, registry})`.
- Router: `/reset @x` validates against `directChats.names()`; `parseDirectAddress(msg.text, directChats.names())`. Moderator default branch unchanged this task.
- `prepareSandbox` in index.ts: `pillarOf.get(job.playbook) !== "code"` becomes `registry.ownerOfPlaybook.get(job.playbook) !== "engineering"`.
- Playbook stage roles: rename in `playbooks/code/*.yaml`, `playbooks/research/*.yaml`, `playbooks/code-inplace.yaml`, `playbooks/echo.yaml` — every `role:` value moves to the canonical agent (`researcher`→`ziad` in code playbooks, `developer`→`maya`, `tester`→`tarek`, `architect`→`kai`, `reviewer`→`yara` (research) / `nadia` for code-review stages, `market-researcher`→`sami`, `ui-ux-designer`→`dalia`). Runner resolves aliases anyway — do the rename for legibility, aliases guarantee no breakage if one is missed.
- `isUnsandboxedWrite` in `src/engine/jobs.ts` reads stage roles → checks `permissionMode === "bypassPermissions"` via the roles map today; switch its lookup to the registry (`deps.registry` threaded through `JobManagerDeps` — mirror the runner change).

- [ ] **Step 1: Write the failing boot test**

```ts
// test/registry-boot.test.ts
import { describe, it, expect } from "vitest";
import { testRegistry } from "./fixtures/registry.js";
import { dropDepartment, disabledDepartments } from "../src/agents/registry/loader.js";

describe("boot wiring", () => {
  it("legacy AIOS_CODE_DISABLED drops engineering (agents + playbooks)", () => {
    const reg = testRegistry();
    for (const d of disabledDepartments({ AIOS_CODE_DISABLED: "1" } as NodeJS.ProcessEnv, reg.departments.keys()))
      dropDepartment(reg, d);
    expect(reg.departments.has("engineering")).toBe(false);
    expect(reg.agents.has("maya")).toBe(false);
    expect(reg.playbooks.has("code-build")).toBe(false);
    expect(reg.playbooks.has("code-inplace")).toBe(true);   // packless survives
    expect(reg.departments.has("finance")).toBe(true);
  });
});
```

- [ ] **Step 2: Run** — PASS immediately if Task 2 correct (this is a wiring pin, cheap). The real work is the index.ts switch; the failing signal is `npx tsc --noEmit` after starting the edit.

- [ ] **Step 3: Do the switch** exactly per Interfaces above. Delete the four `pack.yaml` files and `src/packs/loader.ts`; rework `test/code-pack-loader.test.ts`/`test/pack-killswitch.test.ts`/`test/code-killswitch.test.ts` against `loadRegistry`+`dropDepartment` (same behavioral assertions: disabled dept invisible to jobs, money runtime unaffected). `src/web/packs-view.ts`: `buildPacksView` scans `agentsDir` for `*/department.yaml` (schema `departmentSchema`), `packDisableKey(dept)` unchanged shape (`AIOS_<DEPT>_DISABLED`) plus legacy alias awareness for display; file-edit endpoints re-point their directory root from `playbooksDir/<pillar>` to `agentsDir/<dept>` for department.yaml and stay on `playbooksDir` for playbook YAMLs.

- [ ] **Step 4: Full verification**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean + all green. Then `npm run build` clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(staff): boot on the agent registry; retire pack.yaml + packs/loader"
```

---

### Task 6: `route.decision` events

**Files:**
- Modify: `src/events.ts`
- Modify: `src/router.ts`
- Test: `test/route-decision.test.ts`

**Interfaces:**
- Produces: event union member
  `{ type: "route.decision"; to: string; via: "mention" | "binding" | "handoff" | "default" | "verdict" | "reset"; reason: string; channel: string; chatId: string }`.
- Router emits exactly one `route.decision` per handled message (null-reply mention-only silences excluded), before the agent turn: mention path (`via:"mention"`, reason `"@<name> addressed"` or `"mention of <name> in bound chat"`), binding default (`via:"binding"`, reason `"first bound agent"`), moderator fallback (`via:"default"`, reason `"no mention — chief of staff"`), gate verdict (`via:"verdict"`, reason `"/approve|/reject intercept"`), reset (`via:"reset"`). Task 7 adds `via:"handoff"` from the moderator tool.

- [ ] **Step 1: Write the failing test**

```ts
// test/route-decision.test.ts
import { describe, it, expect } from "vitest";
// Construct MessageRouter with stub moderator/directChats (record calls, return fixed text),
// a real EventBus over an in-memory Store — copy the harness from test/router-gate.test.ts.

describe("route.decision", () => {
  it("emits mention routing with agent name", async () => {
    await router.handle({ channel: "cli", chatId: "c", text: "@maya fix the bug" });
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.to).toBe("maya");
    expect(ev.via).toBe("mention");
  });
  it("emits default routing to the chief of staff", async () => {
    await router.handle({ channel: "cli", chatId: "c", text: "hello" });
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.to).toBe("rami");
    expect(ev.via).toBe("default");
  });
  it("emits verdict routing for /approve", async () => {
    await router.handle({ channel: "cli", chatId: "c", text: "/approve abc123" });
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.via).toBe("verdict");
  });
  it("mention-only silence emits nothing", async () => {
    await routerWithMentionOnlyBinding.handle({ channel: "tg", chatId: "g", text: "morning all" });
    expect(events.some((e) => e.event.type === "route.decision")).toBe(false);
  });
});
```

- [ ] **Step 2: Run** — FAIL (no such event emitted)

- [ ] **Step 3: Implement** — add the union member; in router.ts add a tiny helper and call it in each branch:

```ts
const routed = (to: string, via: "mention"|"binding"|"handoff"|"default"|"verdict"|"reset", reason: string) =>
  bus?.emit({ type: "route.decision", to, via, reason, channel: msg.channel, chatId: msg.chatId });
```

Alias mentions resolve to canonical before emitting. The router has no registry — ADD a method to `DirectChats` (src/agents/direct.ts):

```ts
/** Canonical agent name for a name-or-alias, undefined when unknown. */
canonical(nameOrAlias: string): string | undefined {
  return this.deps.registry.agentOf.get(nameOrAlias);
}
```

Router emits `to: directChats.canonical(addressed.role) ?? addressed.role`; the moderator branch emits `to: "rami"`.

- [ ] **Step 4: Run tests** — `npx vitest run test/route-decision.test.ts` PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/events.ts src/router.ts src/agents/direct.ts test/route-decision.test.ts
git commit -m "feat(staff): route.decision — every dispatch logged with a reason"
```

---

### Task 7: `hand_off` replaces `ask_specialist` + Rami prompt from registry

**Files:**
- Modify: `src/moderator/tools.ts`, `src/moderator/session.ts`, `src/moderator/prompt.ts`
- Modify: `src/index.ts` (consult wiring)
- Test: `test/hand-off.test.ts` (includes the capability-parity pin)

**Interfaces:**
- tools.ts: `ModeratorToolsDeps.consult` replaced by `handOff: (agent: string, task: string) => Promise<{ text: string }>`; `ModeratorToolsDeps.agentNames: string[]` (registry names for the enum). Tool def:

```ts
const handOff = tool(
  "hand_off",
  "Hand a task to a named agent and get their answer inline. The agent runs with their FULL " +
    "tools (same capability as when the user @-mentions them). Use for consultations and " +
    "delegations that fit in one sitting — NOT for multi-stage pipelines (use run_playbook/code_task).",
  {
    agent: z.enum(deps.agentNames as [string, ...string[]]),
    task: z.string().describe("The task/question, with all context the agent needs"),
  },
  async (args) => {
    const res = await deps.handOff(args.agent, args.task);
    return text(`[${args.agent}]\n${res.text}`);
  },
);
```

- session.ts: `MCP_TOOLS` entry `"mcp__aios__ask_specialist"` → `"mcp__aios__hand_off"`. `ModeratorDeps` gains `handOff` + `agentNames` passed through to `buildModeratorServer`; delete the local `consult:` closure.
- index.ts wires the parity-bearing implementation:

```ts
const handOff = async (agent: string, task: string) => {
  const origin = { channel: "system", chatId: "handoff" };
  bus.emit({ type: "route.decision", to: agent, via: "handoff", reason: "chief of staff hand_off", channel: origin.channel, chatId: origin.chatId });
  const pack = resolveDeptFor(agent, origin, true);
  const res = await runSpecialist(agent, task, { cwd: config.projectsRoot, model: config.specialistModel, pack });
  return { text: res.text };
};
```

- prompt.ts: `moderatorPrompt(playbooks, projectsRoot, memoBlock, roster)` where `roster: Array<{ name: string; title: string; charter: string; department: string }>` (built in session.ts from `registry`). Prompt body: replace the old team line with a department-grouped roster block and replace the `ask_specialist` rule with: `For a quick expert opinion or a delegated task that fits one sitting, use hand_off — the agent answers inline with their full tools. The user can reach anyone directly with @name (e.g. "@maya ..."); mention this when they ask how to reach the team.` Opening line becomes `You are Rami, Chief of Staff of AIOS — a local multi-agent system.` and session.ts prepends the rami manifest persona (from `registry.agents.get("rami")!.role.systemPrompt`).
- `Moderator` registers itself under name **rami**: `withDenialObserver(options, "rami", ...)` and `effectiveAllowedTools("rami", MODERATOR_ALLOWED_TOOLS, store)` — permission rows for pseudo-role "moderator" migrate: `Store` gets a one-time `UPDATE role_permissions SET role='rami' WHERE role='moderator'` in the constructor migration block (try/catch, mirrors existing ALTER pattern).

- [ ] **Step 1: Write the failing tests**

```ts
// test/hand-off.test.ts
import { describe, it, expect } from "vitest";
import { testRegistry } from "./fixtures/registry.js";
import { makeResolveDeptFor } from "../src/packs/resolve.js";
import { roleQueryOptions, packRunOptions } from "../src/agents/runner.js";

describe("capability parity", () => {
  it("hand_off and @mention resolve identical allowedTools for every agent", () => {
    const reg = testRegistry();
    const resolve = makeResolveDeptFor(reg, deps);   // same stub deps as Task 4
    for (const [name, def] of reg.agents) {
      const origin = { channel: "cli", chatId: "x" };
      const packA = resolve(name, origin, true);     // @mention path (DirectChats)
      const packB = resolve(name, origin, true);     // hand_off path (index.ts wiring)
      const base = roleQueryOptions(def.role, { cwd: "/tmp" });
      const a = packA ? packRunOptions(base, packA).allowedTools : base.allowedTools;
      const b = packB ? packRunOptions(base, packB).allowedTools : base.allowedTools;
      expect([...(a ?? [])].sort(), name).toEqual([...(b ?? [])].sort());
    }
  });
});

describe("hand_off tool", () => {
  it("routes through deps.handOff and prefixes the agent name", async () => {
    // build buildModeratorServer with a recording handOff stub; invoke the tool handler
    // via the server's tool list (same technique as test/code-task.test.ts uses for code_task)
    const calls: string[] = [];
    // ...construct deps { ..., agentNames: ["maya"], handOff: async (a, t) => { calls.push(`${a}:${t}`); return { text: "done" }; } }
    // invoke → expect(result text).toContain("[maya]"); expect(calls).toEqual(["maya:fix it"]);
  });
  it("ask_specialist no longer exists on the server", () => {
    // server tool names must not include ask_specialist, must include hand_off
  });
});
```

(Fill the two stubbed tests concretely following `test/code-task.test.ts`'s server-invocation pattern.)

- [ ] **Step 2: Run** — FAIL

- [ ] **Step 3: Implement** per Interfaces. Delete the `askSpecialist` tool entirely; update the server tool array; update `MODERATOR_ALLOWED_TOOLS`; migrate the permission row name.

- [ ] **Step 4: Run** — `npx vitest run` full suite green (update `test/permissions*`/`test/effective-allowed-tools.test.ts` expectations from "moderator" → "rami" where they pin the pseudo-role name; `/api/permissions` view label updates in `permissions-view.ts`).

- [ ] **Step 5: Commit**

```bash
git add -A src test
git commit -m "feat(staff): hand_off with full capability parity; Rami roster from registry"
```

---

### Task 8: Finance dissolution — `ledger` toolServer + salim

**Files:**
- Create: `src/finance/server.ts`
- Delete: `src/finance/agent.ts` (keep `src/finance/ledger.ts` untouched)
- Modify: `src/router.ts` (remove finance special-case), `src/index.ts` (drop FinanceAgent; register ledger toolServer), `src/web/server.ts` + `src/web/permissions-view.ts` (drop finance dep / pseudo-role — salim is a normal registry agent now)
- Test: `test/ledger-server.test.ts` (+ keep `test/ledger.test.ts` green untouched)

**Interfaces:**
- Produces: `buildLedgerServer(deps: { store: Store; vault: VaultWriter; gate: ActionGate; origin: { channel: string; chatId: string } }, cfg: { company: string; members: FinanceMember[] })` → `createSdkMcpServer({ name: "ledger", ... })` with the six tools moved VERBATIM from `FinanceAgent.buildServer` (`add_expense`, `remove_expense`, `list_expenses`, `settle`, `export_csv`, `send_receipt`), with two changes:
  - `ledger` key = `${deps.origin.channel}:${deps.origin.chatId}` (same value FinanceAgent used).
  - `export_csv` writes the CSV to `/tmp/aios-exports/<ledger-slug>-<month>.csv` (mkdirSync recursive) and returns `CSV written to <path>. Call attach_file with this exact path to deliver it into the chat.` `send_receipt` returns the stored `receipt_path` with the same attach_file instruction (path is under the vault attachments dir — covered by salim's `attachDirs` extras from Task 3). No `sendFile` dependency.
- index.ts: `toolServers` registry gains `ledger: (d) => buildLedgerServer(d, { company: config.financeCompany, members: config.financeMembers })`. Note `PackToolServerBuilder` receives `{store, vault, gate, origin}` — cfg is closed over.
- Router: delete both `addressed.role === "finance"` and `binding.agents[0] === "finance"` branches — bound agents route uniformly through `directChats.handle(name, channel, chatId, text, msg.sender)`. `finance` keeps working as salim's alias (Task 3 manifest).
- Config: `AIOS_CHAT_BINDINGS` values naming `finance` continue to resolve via the alias — no env migration needed.
- Sessions: old kv keys `finance-session:*` are orphaned (harmless); salim starts fresh sessions under `direct-session:salim:*`.

- [ ] **Step 1: Write the failing test**

```ts
// test/ledger-server.test.ts
import { describe, it, expect } from "vitest";
import { buildLedgerServer } from "../src/finance/server.js";
// in-memory Store + tmp vault, invoke tools via the server handler pattern from test/lifeops-server.test.ts

describe("ledger toolServer", () => {
  it("add_expense + list_expenses + settle round-trip in integer cents", async () => {
    // add 2 expenses for 2 members, settle, assert renderSettlement output matches computeSettlement
  });
  it("scopes the ledger to origin channel:chatId", async () => {
    // two servers with different origins: entries don't cross
  });
  it("export_csv writes under /tmp/aios-exports and instructs attach_file", async () => {
    // result text contains the path and 'attach_file'
    // file exists, first line is the CSV header used by FinanceAgent today
  });
});
```

(Write these concretely by copying the store/vault scaffolding from `test/ledger.test.ts` and the tool-invocation helper from `test/lifeops-server.test.ts`.)

- [ ] **Step 2: Run** — FAIL (module missing)

- [ ] **Step 3: Implement** — move the tool bodies from `src/finance/agent.ts` into `src/finance/server.ts` (they already use `store`/`vault`/`ledger` locals; adjust per Interfaces). Delete `agent.ts`, fix router/index/web imports. `financePrompt` dies with the class (salim's manifest + extras carry the content, Task 3).

- [ ] **Step 4: Run** — `npx vitest run` full suite green: rework `test/router-gate.test.ts`-style router constructions (no `finance` dep), and any test importing `FinanceAgent` or `FINANCE_TOOLS`.

Also run the behavior check: `npx vitest run test/ledger.test.ts test/ledger-server.test.ts`
Expected: PASS — settlement math pins prove byte-identical ledger behavior.

- [ ] **Step 5: Commit**

```bash
git add -A src test
git commit -m "refactor(staff): FinanceAgent dissolves — ledger toolServer + salim, uniform routing"
```

---

### Task 9: Final sweep — privacy pins, docs, full verification

**Files:**
- Modify: `docs/architecture/ARCHITECTURE.md` (routing + registry sections), `README.md` (staff table)
- Test: rerun everything; extend `test/cfo-role.test.ts` with alias assertions

**Steps:**

- [ ] **Step 1: Privacy pins.** `npx vitest run test/cfo-role.test.ts test/lifeops-privacy.test.ts test/money-privacy.test.ts test/bunq-recall-exclusion.test.ts test/email-recall-exclusion.test.ts` — all PASS. Add to `test/cfo-role.test.ts`:

```ts
it("@cfo alias hits faris and is refused from a group origin", async () => {
  const res = await direct.handle("cfo", "telegram", "group-123", "how much did I spend?");
  expect(res.text).toContain("private");
});
```

- [ ] **Step 2: Alias UX pins.** `/reset @developer` resets maya's session (router test); `@finance` in a bound group routes to salim with `[from: ...]` prefix (router test addition in `test/route-decision.test.ts`).

- [ ] **Step 3: Full verification.**

Run: `npx tsc --noEmit && npx vitest run && npm run build && (cd ui && npm run build)`
Expected: all clean. Suite ≥ baseline 620 + ~40 new.

- [ ] **Step 4: Docs.** Update ARCHITECTURE.md: replace pack/roleOf/pillarOf description with registry (agents/, agentOf, ownerOfPlaybook, route.decision, hand_off). README staff table = spec §3 roster.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(staff): architecture + staff roster; privacy and alias pins"
```

---

## Deploy (after merge, on request)

`npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios` — then confirm boot log shows `departments: clients, engineering, finance, life, operations, research` (log line updated in Task 5) and `curl :4280/api/packs` → 200. Web-listen lands ~65s after kickstart with Slack enabled — don't panic early.

## Out of scope (Phase 2+ plans)

Org/profile/chat/routing-trail UI views and `/api/org` endpoints; task graphs; budgets; mailbox; leads acting.
