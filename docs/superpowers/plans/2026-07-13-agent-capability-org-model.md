# Agent × Capability Org Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registry unification per `docs/superpowers/specs/2026-07-11-agent-capability-org-model-design.md`: new Capability primitive (`agents/_capabilities.yaml`), one `resolveAgent()` path for every seam, hermes as a normal `kind: coordinator` registry agent, one address parser, model tiering by kind, Pack struct + pseudo-role special cases deleted. All 15 agents stay; personas untouched.

**Architecture:** A golden-snapshot test pins today's resolved tool surface per agent FIRST; every later task keeps it green (edits to the fixture only at documented delta points). Loader v2 ships with back-compat shims (missing `capabilities` synthesized from dept `toolServer(s)` + manifest tools; missing `kind` inferred), the 21 YAMLs migrate to v2, then shims + dead code are deleted. `resolveAgent(name, origin, ctx)` (new `src/agents/resolve.ts`) subsumes the existing `specialistOptions` kernel and owns: capability-union allowedTools, one MCP builder registry, guard AND-composition, model tiering, gate ceiling, labels. Seams keep only run-scoped concerns (mail widening, attachments, StructuredOutput, denial observer last).

**Tech Stack:** TypeScript, zod, node:sqlite, vitest. No new dependencies.

## Global Constraints

- `node:sqlite` only; subscription auth only (never `ANTHROPIC_API_KEY`).
- All 15 named agents stay; personas/prompts untouched (hermes prompt MOVES but content is assembled from existing `moderatorPrompt` text, not rewritten).
- `role_permissions` table unchanged (keyed by canonical name). Alias set unchanged.
- Widen-before-wrap invariant preserved: every allowlist widening (mail tools, StructuredOutput) happens BEFORE `withDenialObserver`; observer is always last. `test/mail-pins.test.ts` must stay green.
- DB permission overrides stay fail-closed (`effectiveAllowedTools` returns base on store error).
- Run `npx vitest run` AND `npx tsc --noEmit` per task. Baseline: **1055 pass + 1 skip**. Suite green at the END of every task.
- Commit after every task.
- Worktree: `git worktree add .worktrees/org-model -b org-model && ln -s $PWD/node_modules .worktrees/org-model/node_modules`. Remove before trusting root counts.
- Label enforcement is OUT of scope (labels declared + surfaced only — Information-Flow Policy spec consumes them).
- No UI changes (Staff section reads the same views; `/api/packs` keeps serving).
- Deploy = `npm run build && launchctl kickstart -k gui/$(id -u)/com.ihab.aios` (daemon only — no ui build needed).

## Accepted deltas vs today (decisions — do not "fix")

1. **Critic/fixer nodes resolve their OWN capabilities.** Today `engine.ts:264` resolves the producer node's dept for both producer and critic (the closure ignores the role arg). Under `resolveAgent(name)`, minos/argus get their own dept context + servers. Tool surface is unchanged (clamp was already per-agent); only the context block + servers change.
2. **Facade-goal nodes get the agent's own dept context** (was: playbook-owner dept via `byAgent=false`). Same dept in every live playbook, so no observable change today.
3. **Leads move to the moderator model tier** (athena, midas, jasmine, clio, halalo) per spec §6. New env `AIOS_CRITIC_MODEL` (falls back to specialist).
4. **halalo's cloudflare server attaches at every seam** (was: direct-chat only via the `direct.ts:117` hardcode). Spec-intended — it's a capability now.
5. **Bound group chats require the `@` form** (`@halalo …`); bare `halalo: …` prefix no longer hijacks ordinary text in groups. DM/unbound prefix form stays. Spec §8.
6. **Alias collision = boot error** (was silent first-wins). `test/registry-loader.test.ts` expectation flips.
7. **Mail + attachments stay run-scoped mechanics, not capabilities.** The spec's §3 example lists them illustratively, but they are universal per-run widenings today (all agents get mail tools at run time; attachments are turn-scoped collectors). Modeling them as static capabilities would change every agent's resolved allowlist. They keep their current wiring; the capability file simply doesn't list them.
8. **`code_task` quirk left as-is**: absent from hermes' allowlist but callable (denial observer skips `mcp__*`). The coordination capability reproduces today's list exactly; no silent widening.
9. **themis stays `kind: worker`** (functionally a reviewer but has no outputSchema; making him critic would change his model tier for no benefit). **halalo is `kind: lead`** (clients dept lead field — spec inference rule).
10. **`packSchema`-shape tests deleted with the struct** (pack-schema/pack-resolve/pack-toolserver/pack-e2e/code-pack-*/money-pack et al are replaced by capability/resolveAgent tests, not ported).

## File structure

**Create:**
- `agents/_capabilities.yaml` — the capability definitions (Task 4).
- `src/agents/registry/capabilities.ts` — capability zod schema + types.
- `src/agents/resolve.ts` — `makeResolveAgent` + the ONE MCP builder registry.
- `scripts/gen-org-golden.ts` — golden fixture generator (Task 1, kept for regeneration).
- `test/fixtures/org-golden.json` — pinned per-agent resolution surface.
- `test/org-golden.test.ts`, `test/capabilities.test.ts`, `test/resolve-agent.test.ts`, `test/address-parser.test.ts`.

**Modify:** `src/agents/registry/types.ts` (schemas v2), `src/agents/registry/loader.ts` (capabilities load, shims, boot errors, model→RoleDef), `src/agents/registry/extras.ts` (guards move to named registry), `src/agents/guards/index.ts` (NAMED_GUARDS), `src/agents/runner.ts`, `src/agents/direct.ts`, `src/moderator/{session,prompt}.ts`, `src/moderator/handoff.ts`, `src/engine/{engine,workers}.ts`, `src/router.ts`, `src/web/{server,permissions-view,org-view,packs-view}.ts`, `src/config.ts` (criticModel), `src/index.ts` (wiring), all 21 `agents/**.yaml`.

**Delete (Task 8):** `src/packs/types.ts`, `src/packs/resolve.ts`, `MODERATOR_ALLOWED_TOOLS`, `isChiefOfStaff`, `parseDirectAddress`/`findAgentMention` (merged into one), loader shims, pack-shape tests.

**Keep:** `src/packs/server.ts` (`buildPackServer` — the `aios-pack` server is now built by the `aios-pack` entry in the builder registry; MCP tool names unchanged).

---

### Task 1: Golden snapshot — pin today's per-agent resolution surface

**Files:**
- Create: `scripts/gen-org-golden.ts`, `test/fixtures/org-golden.json` (generated), `test/org-golden.test.ts`

**Interfaces:**
- Consumes: current `loadRegistry` (loader.ts:99), `buildExtras` (extras.ts:20), `makeResolveDeptFor` (packs/resolve.ts:102), `specialistOptions` (runner.ts:127), `MODERATOR_ALLOWED_TOOLS` (session.ts:39), `effectiveAllowedTools` (permissions.ts:13). Setup mirrors `test/hand-off.test.ts:55-78` (the existing parity harness).
- Produces: `test/fixtures/org-golden.json` — `Record<agentName, { tools: string[]; permissionMode: string; maxTurns: number; guarded: boolean }>` for all 15 agents, sorted keys, sorted tools. `hermes.tools` = today's effective `MODERATOR_ALLOWED_TOOLS`. Later tasks assert `resolveAgent` output equals this fixture.

- [ ] **Step 1: Write the generator**

```ts
// scripts/gen-org-golden.ts — regenerate test/fixtures/org-golden.json from the CURRENT
// resolution path. Run with: npx tsx scripts/gen-org-golden.ts
// The fixture is the acceptance bar for the capability migration: resolveAgent must
// reproduce this surface exactly (documented deltas edit the fixture explicitly).
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildExtras } from "../src/agents/registry/extras.js";
import { loadConfig } from "../src/config.js";
import { makeResolveDeptFor } from "../src/packs/resolve.js";
import { specialistOptions } from "../src/agents/runner.js";
import { MODERATOR_ALLOWED_TOOLS } from "../src/moderator/session.js";
import type { ActionGate } from "../src/kernel/gate.js";

const config = loadConfig(process.cwd());
const store = new Store(":memory:");
const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "golden-")));
const gate = { propose: async () => ({}) } as unknown as ActionGate;
const registry = loadRegistry("agents", "playbooks", buildExtras(config), () => {});
const resolveDeptFor = makeResolveDeptFor(registry, { store, vault, gate, toolServers: {} });

const origin = { channel: "web", chatId: "ui" };
const golden: Record<string, { tools: string[]; permissionMode: string; maxTurns: number; guarded: boolean }> = {};

for (const name of [...registry.agents.keys()].sort()) {
  const def = registry.agents.get(name)!;
  if (name === "hermes") {
    golden[name] = {
      tools: [...MODERATOR_ALLOWED_TOOLS].sort(),
      permissionMode: "dontAsk", maxTurns: 40, guarded: false,
    };
    continue;
  }
  const pack = resolveDeptFor(name, origin, true);
  const opts = specialistOptions(def.role, name, { cwd: "/tmp", pack }, store);
  golden[name] = {
    tools: [...(opts.allowedTools ?? [])].sort(),
    permissionMode: def.role.permissionMode,
    maxTurns: def.role.maxTurns,
    guarded: !!def.role.toolChecks,
  };
}

writeFileSync("test/fixtures/org-golden.json", JSON.stringify(golden, null, 2) + "\n");
console.log(`wrote ${Object.keys(golden).length} agents to test/fixtures/org-golden.json`);
```

(If any import name differs — e.g. `specialistOptions` not exported — export it; it exists at runner.ts:127. `MODERATOR_ALLOWED_TOOLS` is exported at session.ts:39. `resolveDeptFor` with an empty `toolServers` map is fail-soft: named servers are skipped, the tool allowlist is unaffected — this matches how `test/hand-off.test.ts` builds Path A.)

- [ ] **Step 2: Generate the fixture**

Run: `npx tsx scripts/gen-org-golden.ts`
Expected: `wrote 15 agents to test/fixtures/org-golden.json`. Inspect: vulcan must list `Bash, Edit, Grep, Glob, Read, TodoWrite, Write, mcp__aios-pack__recall, mcp__aios-pack__vault_read, mcp__aios-pack__vault_write, mcp__code__sh`-style entries (bare `recall`/`vault_read`/`vault_write` are clamped to their fq `mcp__aios-pack__*` forms by `clampTools` — whatever the current output is IS the truth being pinned); hermes lists 24 tools (19 `mcp__aios__*` + Read/Grep/Glob/WebSearch/WebFetch).

- [ ] **Step 3: Write the pin test**

```ts
// test/org-golden.test.ts — the migration's acceptance bar. The fixture pins the resolved
// tool surface per agent; capability migration must reproduce it exactly. Regenerate ONLY
// at documented delta points: npx tsx scripts/gen-org-golden.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildExtras } from "../src/agents/registry/extras.js";
import { loadConfig } from "../src/config.js";
import { makeResolveDeptFor } from "../src/packs/resolve.js";
import { specialistOptions } from "../src/agents/runner.js";
import { MODERATOR_ALLOWED_TOOLS } from "../src/moderator/session.js";
import type { ActionGate } from "../src/kernel/gate.js";

const golden = JSON.parse(readFileSync("test/fixtures/org-golden.json", "utf8")) as
  Record<string, { tools: string[]; permissionMode: string; maxTurns: number; guarded: boolean }>;

describe("org golden surface", () => {
  const config = loadConfig(process.cwd());
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "golden-")));
  const gate = { propose: async () => ({}) } as unknown as ActionGate;
  const registry = loadRegistry("agents", "playbooks", buildExtras(config), () => {});
  const resolveDeptFor = makeResolveDeptFor(registry, { store, vault, gate, toolServers: {} });
  const origin = { channel: "web", chatId: "ui" };

  it("fixture covers exactly the live registry", () => {
    expect(Object.keys(golden).sort()).toEqual([...registry.agents.keys()].sort());
  });

  for (const name of Object.keys(golden)) {
    it(`${name} resolves to the pinned surface`, () => {
      const def = registry.agents.get(name)!;
      if (name === "hermes") {
        expect([...MODERATOR_ALLOWED_TOOLS].sort()).toEqual(golden[name].tools);
        return;
      }
      const opts = specialistOptions(def.role, name, { cwd: "/tmp", pack: resolveDeptFor(name, origin, true) }, store);
      expect([...(opts.allowedTools ?? [])].sort()).toEqual(golden[name].tools);
      expect(def.role.permissionMode).toBe(golden[name].permissionMode);
      expect(def.role.maxTurns).toBe(golden[name].maxTurns);
      expect(!!def.role.toolChecks).toBe(golden[name].guarded);
    });
  }
});
```

- [ ] **Step 4: Run, verify green, commit**

Run: `npx vitest run test/org-golden.test.ts` → 16 tests pass. `npx vitest run && npx tsc --noEmit` → 1055+16 baseline… (count grows; 1 skip unchanged).

```bash
git add scripts/gen-org-golden.ts test/fixtures/org-golden.json test/org-golden.test.ts
git commit -m "test(org): golden snapshot of per-agent resolution surface — migration acceptance bar"
```

---

### Task 2: Capability schema, named guards, loader v2 with shims + boot errors

**Files:**
- Create: `src/agents/registry/capabilities.ts`
- Modify: `src/agents/registry/types.ts` (agentSchema: `kind?`, `capabilities?`; departmentSchema: `capabilities?`), `src/agents/registry/loader.ts` (load `_capabilities.yaml`, shims, boot errors, model→RoleDef, coordinator accessor), `src/agents/guards/index.ts` (NAMED_GUARDS registry), `src/agents/registry/extras.ts` (extras lose toolChecks for guard-named agents — Task 4 flips YAMLs; extras keep cwd/contextFiles/attachDirs/promptSuffix), `src/config.ts` (criticModel), `src/web/server.ts` CONFIG_KEYS (+AIOS_CRITIC_MODEL)
- Test: `test/capabilities.test.ts` (create), modify `test/registry-loader.test.ts` (alias collision now throws)

**Interfaces:**
- Consumes: `AgentExtras` (loader.ts:15), `guardOptions` (guards/index.ts:16), guard impls `halaloToolChecks` (guards/halalo-readonly.ts:185), `ledgerReadCheck` (guards/read-confined.ts:30), `atlasMutatingChecks` (guards/atlas-mutating.ts:28).
- Produces (later tasks depend on exact names):
  - capabilities.ts: `capabilitySchema` (zod), `interface CapabilityDef { server?: string; tools: string[]; actions: string[]; guard?: string; sandbox?: boolean; labels: string[] }`, `loadCapabilities(path: string): Map<string, CapabilityDef>` (missing file → empty map).
  - types.ts: `agentSchema` gains `kind: z.enum(["coordinator","lead","worker","critic"]).optional()`, `capabilities: z.array(z.string()).default([])`; `departmentSchema` gains `capabilities: z.array(z.string()).default([])`.
  - loader.ts: `AgentDef` gains `kind: "coordinator"|"lead"|"worker"|"critic"`, `capabilities: string[]` (post-shim, deduped `[...dept.capabilities, ...agent.capabilities]`); `LoadedRegistry` gains `capabilities: Map<string, CapabilityDef>`, `coordinator: string` (canonical name); `RoleDef` gains `model?: string` (wired from manifest in `compile`). Boot errors (loader throws `Error`): alias collision, unknown capability name, unknown guard name, zero or ≥2 coordinators.
  - guards/index.ts: `NAMED_GUARDS: Record<string, (cfg: GuardConfig) => { checks: ToolChecks; fallback?: "deny" }>` with keys `halalo-readonly`, `ledger-read-confine`, `atlas-mutating`; `GuardConfig = { repoDir: string; dataDir: string }` (whatever the three impls need — halaloToolChecks takes repoDir, ledgerReadCheck takes roots derived from cfg, atlasMutatingChecks takes nothing).
  - config.ts: `criticModel?: string` = `process.env.AIOS_CRITIC_MODEL ?? process.env.AIOS_SPECIALIST_MODEL`.
- **Shims (deleted in Task 8):** agent without `capabilities` → synthesized pseudo-capability `__legacy:<name>` `{ tools: manifest.tools, actions: dept.actions, sandbox: dept.sandbox }` plus dept-server pseudo-capabilities from `toolServer`/`toolServers`; missing `kind` → inferred: name === "hermes" → coordinator, else `outputSchema` set → critic, else `dept.lead === name` → lead, else worker (coordinator check FIRST — hermes is also the ops lead).

- [ ] **Step 1: Write failing tests**

```ts
// test/capabilities.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCapabilities } from "../src/agents/registry/capabilities.js";
import { loadRegistry } from "../src/agents/registry/loader.js";

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "caps-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const HERMES = `
name: hermes
title: Chief of Staff
department: operations
charter: routes
persona: decisive
prompt: You are Hermes.
kind: coordinator
capabilities: [files-ro]
`;
const OPS_DEPT = `
department: operations
mission: front door
lead: hermes
memoDomain: general
`;
const CAPS = `
files-ro: { tools: [Read, Grep, Glob] }
web:      { tools: [WebSearch, WebFetch] }
guarded:  { tools: [Bash], guard: atlas-mutating }
labeled:  { server: money, tools: [mcp__money__spending_summary], labels: [personal.finance], actions: [ledger.write] }
`;

function agentYaml(name: string, extra = ""): string {
  return `\nname: ${name}\ntitle: T\ndepartment: operations\ncharter: c\npersona: p\nprompt: pr\n${extra}`;
}

describe("loadCapabilities", () => {
  it("parses defs with defaults and tolerates a missing file", () => {
    const dir = tree({ "_capabilities.yaml": CAPS });
    const caps = loadCapabilities(join(dir, "_capabilities.yaml"));
    expect(caps.get("files-ro")).toEqual({ tools: ["Read", "Grep", "Glob"], actions: [], labels: [], server: undefined, guard: undefined, sandbox: false });
    expect(caps.get("labeled")!.labels).toEqual(["personal.finance"]);
    expect(loadCapabilities(join(dir, "nope.yaml")).size).toBe(0);
  });
});

describe("loader v2", () => {
  it("boot error on alias collision", () => {
    const dir = tree({
      "_capabilities.yaml": CAPS,
      "operations/department.yaml": OPS_DEPT,
      "operations/hermes.yaml": HERMES,
      "operations/a.yaml": agentYaml("aaa", "aliases: [shared]\ncapabilities: [files-ro]\nkind: worker"),
      "operations/b.yaml": agentYaml("bbb", "aliases: [shared]\ncapabilities: [files-ro]\nkind: worker"),
    });
    expect(() => loadRegistry(dir, join(dir, "nopb"), {}, () => {})).toThrow(/alias/i);
  });

  it("boot error on unknown capability and unknown guard", () => {
    const base = {
      "operations/department.yaml": OPS_DEPT,
      "operations/hermes.yaml": HERMES,
    };
    const d1 = tree({ ...base, "_capabilities.yaml": CAPS,
      "operations/x.yaml": agentYaml("xxx", "capabilities: [nope]\nkind: worker") });
    expect(() => loadRegistry(d1, join(d1, "nopb"), {}, () => {})).toThrow(/capability/i);
    const d2 = tree({ ...base, "_capabilities.yaml": "bad: { tools: [Bash], guard: ghost }\n",
      "operations/x.yaml": agentYaml("xxx", "capabilities: [bad]\nkind: worker") });
    expect(() => loadRegistry(d2, join(d2, "nopb"), {}, () => {})).toThrow(/guard/i);
  });

  it("boot error on zero or two coordinators", () => {
    const d1 = tree({ "_capabilities.yaml": CAPS,
      "operations/department.yaml": OPS_DEPT,
      "operations/solo.yaml": agentYaml("solo", "kind: worker\ncapabilities: [files-ro]") });
    expect(() => loadRegistry(d1, join(d1, "nopb"), {}, () => {})).toThrow(/coordinator/i);
    const d2 = tree({ "_capabilities.yaml": CAPS,
      "operations/department.yaml": OPS_DEPT,
      "operations/hermes.yaml": HERMES,
      "operations/dup.yaml": agentYaml("dup", "kind: coordinator\ncapabilities: [files-ro]") });
    expect(() => loadRegistry(d2, join(d2, "nopb"), {}, () => {})).toThrow(/coordinator/i);
  });

  it("kind inference shim: hermes→coordinator wins over lead; outputSchema→critic; dept lead→lead; else worker", () => {
    const dir = tree({
      "_capabilities.yaml": CAPS,
      "operations/department.yaml": `\ndepartment: operations\nmission: m\nlead: leader\nmemoDomain: general\n`,
      "operations/hermes.yaml": agentYaml("hermes"), // no kind, no capabilities → shims
      "operations/leader.yaml": agentYaml("leader"),
      "operations/judge.yaml": agentYaml("judge", "outputSchema: verdict"),
      "operations/pleb.yaml": agentYaml("pleb"),
    });
    const reg = loadRegistry(dir, join(dir, "nopb"), {}, () => {});
    expect(reg.agents.get("hermes")!.kind).toBe("coordinator");
    expect(reg.agents.get("leader")!.kind).toBe("lead");
    expect(reg.agents.get("judge")!.kind).toBe("critic");
    expect(reg.agents.get("pleb")!.kind).toBe("worker");
    expect(reg.coordinator).toBe("hermes");
  });

  it("capability synthesis shim preserves manifest tools; dept capabilities are inherited", () => {
    const dir = tree({
      "_capabilities.yaml": CAPS,
      "operations/department.yaml": OPS_DEPT + "capabilities: [web]\n",
      "operations/hermes.yaml": HERMES,
      "operations/old.yaml": agentYaml("old", "tools: [Read, Bash]\nkind: worker"), // v1 agent, no capabilities
    });
    const reg = loadRegistry(dir, join(dir, "nopb"), {}, () => {});
    const old = reg.agents.get("old")!;
    expect(old.capabilities).toContain("web"); // dept default inherited
    const legacy = reg.capabilities.get(`__legacy:old`);
    expect(legacy!.tools).toEqual(["Read", "Bash"]);
  });

  it("manifest model: flows into RoleDef", () => {
    const dir = tree({
      "_capabilities.yaml": CAPS,
      "operations/department.yaml": OPS_DEPT,
      "operations/hermes.yaml": HERMES,
      "operations/m.yaml": agentYaml("mmm", "model: claude-haiku-4-5-20251001\nkind: worker\ncapabilities: [files-ro]"),
    });
    expect(loadRegistry(dir, join(dir, "nopb"), {}, () => {}).agents.get("mmm")!.role.model)
      .toBe("claude-haiku-4-5-20251001");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/capabilities.test.ts` → FAIL (`capabilities.js` missing).

- [ ] **Step 3: Implement capabilities.ts**

```ts
// src/agents/registry/capabilities.ts — the Capability primitive (org-model spec §3).
// One struct owns what was smeared across pack manifests, dept manifests, and hardcoded wiring.
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const capabilitySchema = z.object({
  /** Name in the single MCP builder registry (src/agents/resolve.ts SERVER_BUILDERS). */
  server: z.string().optional(),
  tools: z.array(z.string()).default([]),
  /** Gate action-ceiling contribution (union across the agent's capabilities). */
  actions: z.array(z.string()).default([]),
  /** Named deterministic ToolChecks (guards/index.ts NAMED_GUARDS). Guards AND-compose. */
  guard: z.string().optional(),
  sandbox: z.boolean().default(false),
  /** Data-scope labels — consumed by the Information-Flow Policy spec. */
  labels: z.array(z.string()).default([]),
});

export type CapabilityDef = z.infer<typeof capabilitySchema>;

export function loadCapabilities(path: string): Map<string, CapabilityDef> {
  const out = new Map<string, CapabilityDef>();
  if (!existsSync(path)) return out;
  const raw = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown> | null;
  for (const [name, def] of Object.entries(raw ?? {})) {
    out.set(name, capabilitySchema.parse(def));
  }
  return out;
}
```

- [ ] **Step 4: Schema v2 fields**

In `src/agents/registry/types.ts`:
- `agentSchema`: add `kind: z.enum(["coordinator", "lead", "worker", "critic"]).optional(),` and `capabilities: z.array(z.string()).default([]),` (keep `tools` — the shim consumes it until Task 8).
- `departmentSchema`: add `capabilities: z.array(z.string()).default([]),` (keep `toolServer`/`toolServers`/`tools` for the shim).

- [ ] **Step 5: NAMED_GUARDS registry**

In `src/agents/guards/index.ts` add (keeping `guardOptions` as-is):

```ts
import { halaloToolChecks } from "./halalo-readonly.js";
import { ledgerReadCheck } from "./read-confined.js";
import { atlasMutatingChecks } from "./atlas-mutating.js";

export interface GuardConfig { repoDir: string; dataDir: string }
export interface NamedGuard { checks: ToolChecks; fallback?: "deny" }

/** Named deterministic guards referenced by capability `guard:` fields (spec §3).
 *  Unknown names are a boot error (loader validates). Guards AND-compose. */
export const NAMED_GUARDS: Record<string, (cfg: GuardConfig) => NamedGuard> = {
  "halalo-readonly": (cfg) => ({ checks: halaloToolChecks(cfg.repoDir), fallback: "deny" }),
  "ledger-read-confine": (cfg) => ({ checks: ledgerReadCheck([cfg.dataDir]) }),
  "atlas-mutating": () => ({ checks: atlasMutatingChecks() }),
};
```

(Adjust the exact constructor args to match the three implementations' current signatures — mirror how `buildExtras` (extras.ts:20-54) calls them today, including halalo's `fallback: "deny"`. The guard config the extras used is what GuardConfig must carry.)

- [ ] **Step 6: Loader v2**

In `src/agents/registry/loader.ts`:
1. `AgentDef` (loader.ts:24) gains `kind` + `capabilities: string[]`; `LoadedRegistry` (loader.ts:32) gains `capabilities: Map<string, CapabilityDef>` and `coordinator: string`.
2. `compile()` (loader.ts:54): copy `m.model` into the RoleDef (`model: m.model`) — add `model?: string` to `RoleDef` in `src/agents/roles/index.ts`.
3. At the top of `loadRegistry`: `const capabilities = loadCapabilities(join(agentsDir, "_capabilities.yaml"));` and skip `_capabilities.yaml` (and any `_*.yaml`) in the per-dept file scan alongside `department.yaml`.
4. Alias registration (loader.ts:143): replace the `continue`-with-log branch with `throw new Error(\`alias collision: "\${a}" already registered (while loading \${m.name})\`)` — same for a duplicate canonical name.
5. Per agent, after parse:

```ts
      // ---- v2 kind (shim: infer when absent; delete with the shims in the cleanup task) ----
      const kind = m.kind
        ?? (m.name === "hermes" ? "coordinator"
          : m.outputSchema ? "critic"
          : dept.lead === m.name ? "lead"
          : "worker");

      // ---- v2 capabilities (shim: synthesize from v1 fields when absent) ----
      let capNames = [...new Set([...dept.capabilities, ...m.capabilities])];
      if (m.capabilities.length === 0 && dept.capabilities.length === 0) {
        const legacy = `__legacy:${m.name}`;
        capabilities.set(legacy, capabilitySchema.parse({
          tools: m.tools, actions: dept.actions, sandbox: dept.sandbox,
        }));
        capNames = [legacy];
        for (const server of [dept.toolServer, ...(dept.toolServers ?? [])].filter(Boolean) as string[]) {
          const key = `__legacy-server:${dept.department}:${server}`;
          if (!capabilities.has(key)) capabilities.set(key, capabilitySchema.parse({ server }));
          capNames.push(key);
        }
      }
      for (const c of capNames) {
        const def = capabilities.get(c);
        if (!def) throw new Error(`unknown capability "${c}" on agent ${m.name}`);
        if (def.guard && !(def.guard in NAMED_GUARDS)) {
          throw new Error(`unknown guard "${def.guard}" in capability "${c}"`);
        }
      }
```

6. After the load loop: coordinator check —

```ts
  const coordinators = [...agents.values()].filter((a) => a.kind === "coordinator").map((a) => a.manifest.name);
  if (coordinators.length !== 1) {
    throw new Error(`exactly one kind: coordinator agent required, found ${coordinators.length} [${coordinators.join(", ")}]`);
  }
```

Return `{ ...existing, capabilities, coordinator: coordinators[0] }`.
7. `reloadRegistry` in `src/index.ts:131-150` mutates maps in place — it must also refresh `capabilities` in place and re-run the boot checks inside a try/catch (a hot-reload failure logs + keeps the old registry; only cold boot dies).

- [ ] **Step 7: criticModel config**

`src/config.ts`: add `criticModel?: string;` to the Config interface (next to `specialistModel`, :30) and `criticModel: process.env.AIOS_CRITIC_MODEL ?? process.env.AIOS_SPECIALIST_MODEL,` in loadConfig (after :207). Add `{ key: "AIOS_CRITIC_MODEL", secret: false },` to CONFIG_KEYS in `src/web/server.ts` (after AIOS_SPECIALIST_MODEL).

- [ ] **Step 8: Fix the flipped loader test**

`test/registry-loader.test.ts` has an alias-collision test asserting first-wins (around :51-59). Rewrite that case to `expect(() => loadRegistry(...)).toThrow(/alias/i)`. Any other loader fixtures without a coordinator agent must gain a minimal hermes-style coordinator YAML (or the fixture loader helper adds one) — run the suite and fix each failing fixture the same way: add `operations/hermes.yaml` with `kind: coordinator` (or rely on the hermes-name inference by naming the fixture agent hermes).
**Important:** `test/fixtures/registry.ts` loads the REAL live tree — untouched. Fixture-tree tests (`registry-loader`, `pack-loader`, `registry-boot`, `createjob-inplace`, etc.) may now throw "exactly one coordinator" — for each, add the minimal coordinator agent to the fixture tree. Do this mechanically; do not weaken the boot check.

- [ ] **Step 9: Run full suite + typecheck, then commit**

Run: `npx vitest run && npx tsc --noEmit`
Expected: green (golden test still passes — shims preserve resolution; alias-collision test flipped).

```bash
git add src/agents src/config.ts src/web/server.ts test/capabilities.test.ts test/registry-loader.test.ts test/fixtures
git commit -m "feat(org): capability schema + loader v2 — shims, boot errors, named guards, model in RoleDef, AIOS_CRITIC_MODEL"
```

---

### Task 3: `resolveAgent` — one resolution path + the single MCP builder registry

**Files:**
- Create: `src/agents/resolve.ts`
- Modify: `src/index.ts` (construct `resolveAgent`, keep old wiring alive in parallel until Tasks 5-6 cut seams over)
- Test: `test/resolve-agent.test.ts` (create)

**Interfaces:**
- Consumes: `LoadedRegistry` (+`capabilities`, `coordinator` from Task 2), `NAMED_GUARDS`/`guardOptions` (guards), `roleSystemPrompt`/`clampTools` (runner.ts:27,63), `withEffectiveTools` (permissions.ts:29), `buildPackServer` (packs/server.ts:56), `buildCodeServer` (code/exec.ts:63), `buildMoneyServer`/`buildResearchServer`/`buildLifeopsServer`/`buildLedgerServer`/`buildCloudflareServer`, `memoContextForDomain` (packs/resolve.ts internals — lift it), config.
- Produces (Tasks 5-8 depend on exact names):

```ts
export interface ResolveCtx { workspace?: string; idempotencyKey?: string; cwd?: string }
export interface ResolvedAgent {
  canonical: string;
  kind: "coordinator" | "lead" | "worker" | "critic";
  def: AgentDef;
  /** SDK options: prompt + capability-union allowedTools (clamped, DB-effective) + static MCP servers + guards + tiered model. NO denial observer (seams wrap last). */
  options: Options;
  /** Gate action ceiling = union of capability actions. */
  ceiling: string[];
  /** Data-scope labels = union of capability labels (policy spec consumes). */
  labels: string[];
}
export type ResolveAgentFn = (name: string, origin: { channel: string; chatId: string }, ctx?: ResolveCtx) => ResolvedAgent | undefined;
export function makeResolveAgent(deps: ResolveAgentDeps): ResolveAgentFn;
export interface ResolveAgentDeps {
  registry: LoadedRegistry; store: Store; vault: VaultWriter; gate: ActionGate; config: Config;
}
```

- Internal composition order (preserves widen-before-wrap; observer stays at seams):
  1. `canonical = registry.agentOf.get(name.toLowerCase())`; miss → `undefined`.
  2. `caps` = the agent's capability defs (already validated at boot).
  3. `allowedTools` = capability tool union → `clampTools`-style fq-normalization for bare `aios-pack` names (`recall` → `mcp__aios-pack__recall` — reuse the exact mapping `clampTools` applies today so the golden fixture matches).
  4. `systemPrompt` = `roleSystemPrompt(def.role)` + dept context block (dept mission + `memoContextForDomain(store, vault, dept.memoDomain)` — lift the block-building from `makeResolveDeptFor`'s synthesized `contextBlock` verbatim; `privateMemo` handling preserved).
  5. Static `mcpServers`: for each capability with `server`, call `SERVER_BUILDERS[cap.server](buildCtx)`. `SERVER_BUILDERS` lives IN resolve.ts — the one registry:

```ts
type ServerBuilder = (ctx: {
  store: Store; vault: VaultWriter; gate: ActionGate; config: Config;
  origin: { channel: string; chatId: string };
  agent: string; dept: LoadedDepartment; ceiling: string[];
  workspace?: string; idempotencyKey?: string;
}) => { key: string; server: unknown } | undefined;

const SERVER_BUILDERS: Record<string, ServerBuilder> = {
  "aios-pack": (c) => ({ key: "aios-pack", server: buildPackServer({/* exact deps buildPackServer takes today: store, vault, gate, origin, memoDomain: c.dept.memoDomain, vaultSection: c.dept.vaultSection, actions: c.ceiling, idempotencyKey: c.idempotencyKey */}) }),
  money:      (c) => ({ key: "money", server: buildMoneyServer({ store: c.store, categorize: c.config /* wire the real categorize dep via ResolveAgentDeps */ }) }),
  research:   (c) => ({ key: "research", server: buildResearchServer({ store: c.store }) }),
  lifeops:    (c) => ({ key: "lifeops", server: buildLifeopsServer({ store: c.store }) }),
  ledger:     (c) => ({ key: "ledger", server: buildLedgerServer(/* same deps index.ts:214 passes today */) }),
  cloudflare: () => ({ key: "halalo_analytics", server: buildCloudflareServer() }),
  code:       (c) => c.workspace ? { key: "code", server: buildCodeServer({ taskDir: c.workspace, mode: "sandbox" /* mirror resolve.ts:87 exactly */ }) } : undefined,
};
```

  (During implementation, copy each builder's EXACT current call — `index.ts:210-218` for money/research/lifeops/ledger, `resolve.ts:60` for aios-pack, `resolve.ts:87` for code, `direct.ts:117` for cloudflare. The extra deps they need — `categorize`, `financeCompany/financeMembers` — ride in via `ResolveAgentDeps` fields added as needed. The comment-marked argument lists above are the recon pointers, not final signatures.)
  6. Guards: AND-compose — collect every capability guard via `NAMED_GUARDS[name](cfg)` PLUS the agent's legacy `extras.toolChecks` if present (shim era); merge with `guardOptions` semantics: each check must allow. Compose by chaining: run checks sequentially, first deny wins (that IS "every guard must allow"). `fallback: "deny"` if ANY guard declares it.
  7. Model tiering: `model = def.role.model ?? (kind === "coordinator" || kind === "lead" ? config.moderatorModel : kind === "critic" ? config.criticModel : config.specialistModel)`.
  8. `options = withEffectiveTools(assembled, canonical, store)` — DB grant/revoke last, fail-closed.
  9. `ceiling` = union of capability `actions`; `labels` = union of `labels`; sandbox: any capability `sandbox: true` + `ctx.workspace` → code server + confinement (mirror `packRunOptions` confinement block).

- [ ] **Step 1: Failing tests**

```ts
// test/resolve-agent.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildExtras } from "../src/agents/registry/extras.js";
import { loadConfig } from "../src/config.js";
import { makeResolveAgent } from "../src/agents/resolve.js";
import type { ActionGate } from "../src/kernel/gate.js";

const golden = JSON.parse(readFileSync("test/fixtures/org-golden.json", "utf8")) as
  Record<string, { tools: string[] }>;

function setup() {
  const config = loadConfig(process.cwd());
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "ra-")));
  const gate = { propose: async () => ({}) } as unknown as ActionGate;
  const registry = loadRegistry("agents", "playbooks", buildExtras(config), () => {});
  return { registry, store, config,
    resolve: makeResolveAgent({ registry, store, vault, gate, config }) };
}
const origin = { channel: "web", chatId: "ui" };

describe("resolveAgent", () => {
  it("matches the golden surface for every agent except hermes (fixed by YAML migration)", () => {
    const { resolve, registry } = setup();
    for (const name of [...registry.agents.keys()]) {
      if (name === "hermes") continue; // hermes carries tools:[] until Task 4 migrates its YAML
      const r = resolve(name, origin)!;
      expect([...(r.options.allowedTools ?? [])].sort(), name).toEqual(golden[name].tools);
    }
  });

  it("clamp invariant: no agent ever gains a tool outside its capability union", () => {
    const { resolve, registry } = setup();
    for (const name of [...registry.agents.keys()]) {
      const r = resolve(name, origin)!;
      const union = new Set(
        registry.agents.get(name)!.capabilities
          .flatMap((c) => registry.capabilities.get(c)!.tools)
          .map((t) => (["recall", "vault_read", "vault_write", "propose_action"].includes(t) ? `mcp__aios-pack__${t}` : t)),
      );
      for (const t of r.options.allowedTools ?? []) {
        expect(union.has(t), `${name} leaked ${t}`).toBe(true);
      }
    }
  });

  it("model tiering by kind with per-agent override", () => {
    const { resolve, registry, config } = setup();
    const byKind = (k: string) => [...registry.agents.values()].find((a) => a.kind === k && !a.role.model)?.manifest.name;
    const worker = byKind("worker"); const lead = byKind("lead"); const critic = byKind("critic");
    if (worker) expect(resolve(worker, origin)!.options.model).toBe(config.specialistModel);
    if (lead) expect(resolve(lead, origin)!.options.model).toBe(config.moderatorModel);
    if (critic) expect(resolve(critic, origin)!.options.model).toBe(config.criticModel);
  });

  it("ceiling and labels are capability unions; unknown agent → undefined", () => {
    const { resolve } = setup();
    expect(resolve("no-such-agent", origin)).toBeUndefined();
    const vulcan = resolve("vulcan", origin)!;
    expect(vulcan.ceiling).toContain("vault.write"); // engineering vault-write capability (legacy shim: dept actions)
    const jasmine = resolve("jasmine", origin)!;
    expect(Array.isArray(jasmine.labels)).toBe(true); // non-empty after Task 4 assigns lifeops labels
  });

  it("DB revoke row is honored (fail-closed layering preserved)", () => {
    const { resolve, registry, store } = setup();
    const worker = [...registry.agents.values()].find((a) => a.kind === "worker")!.manifest.name;
    const before = resolve(worker, origin)!.options.allowedTools ?? [];
    const victim = before[0];
    store.setRolePermission(worker, victim, 0, "test");
    const after = resolve(worker, origin)!.options.allowedTools ?? [];
    expect(after).not.toContain(victim);
  });

  it("guards AND-compose: halalo keeps its readonly guard through resolveAgent", () => {
    const { resolve } = setup();
    const r = resolve("halalo", origin)!;
    expect(r.options.canUseTool ?? r.options.hooks).toBeTruthy(); // guard wiring present (guardOptions output)
  });
});
```

(Adjust the guard assertion to whatever `guardOptions` actually sets on options — `canUseTool` + `hooks.PreToolUse`; assert on the concrete field.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/resolve-agent.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/agents/resolve.ts`** per the Interfaces block above. Implementation notes (each maps to an existing code site — copy, don't reinvent):
  - fq-normalization of bare aios-pack tool names: reuse/lift `clampTools` (runner.ts:63-70) — under capabilities the "clamp" IS the union, so what remains of clampTools is only the bare→fq mapping. Extract that mapping into a small helper `fqPackTools(tools: string[]): string[]` used by both (old path untouched until Task 5).
  - dept context block: lift verbatim from `makeResolveDeptFor` (packs/resolve.ts:118-139) — mission/persona line + memo block + privateMemo condition.
  - `withEffectiveTools` LAST among widenings; observer NOT applied here.
  - `sandbox` confinement: copy the confinement branch from `packRunOptions` (runner.ts:76-91).
  - In `src/index.ts`, construct once: `const resolveAgent = makeResolveAgent({ registry, store, vault, gate, config, ...serverDeps })` right after the existing `resolveDeptFor` (index.ts:210-218) — both live side by side until the seams cut over.

- [ ] **Step 4: Run + commit**

Run: `npx vitest run && npx tsc --noEmit` → green (golden untouched; resolve-agent tests pass via shim capabilities).

```bash
git add src/agents/resolve.ts src/index.ts test/resolve-agent.test.ts src/agents/runner.ts
git commit -m "feat(org): resolveAgent — one resolution path + single MCP builder registry"
```

---

### Task 4: YAML migration — `_capabilities.yaml` + 21 manifests to v2

**Files:**
- Create: `agents/_capabilities.yaml`
- Modify: all 15 agent YAMLs (add `kind:` + `capabilities:`, delete `tools:`), all 6 `department.yaml` (add `capabilities:`, delete `toolServer`/`toolServers`), `src/agents/registry/extras.ts` (drop toolChecks for halalo/juno/atlas — guards now ride capabilities; KEEP cwd/contextFiles/attachDirs/promptSuffix extras), `src/moderator/prompt.ts` + `agents/operations/hermes.yaml` (prompt text moves), `test/fixtures/org-golden.json` (hermes entry note + halalo unchanged-tools confirmation)
- Test: golden + capabilities + resolve-agent suites prove the migration.

**Interfaces:**
- Consumes: capability schema (Task 2), resolveAgent golden test (Task 3).
- Produces: v2 live tree — shims stop firing (every agent declares `capabilities`; every dept declares defaults). `registry.capabilities` has NO `__legacy:*` entries when loading the live tree (asserted).

- [ ] **Step 1: Write `agents/_capabilities.yaml`**

Structure below is normative for the bundles; for the four domain-server capabilities (`money-analysis`, `ledger`, `research-kb`, `lifeops`) copy the EXACT tool lists from the current agent manifests (`agents/finance/midas.yaml` tools → money-analysis; `agents/finance/juno.yaml` ledger tools → ledger; `agents/research/*.yaml` → research-kb; `agents/life/jasmine.yaml` → lifeops). Golden equality is the arbiter — if a list is off, the org-golden test names the agent and the missing/extra tool.

```yaml
# agents/_capabilities.yaml — the Capability primitive (org-model spec §3).
# server: name in SERVER_BUILDERS (src/agents/resolve.ts). guard: name in NAMED_GUARDS.
# labels feed the Information-Flow Policy spec (declared here, enforced there).

# -- generic tool bundles ------------------------------------------------
files-ro:    { tools: [Read, Grep, Glob] }
editing:     { tools: [Edit, Write] }
todo:        { tools: [TodoWrite] }
shell:       { tools: [Bash] }
web:         { tools: [WebSearch, WebFetch] }

# -- memory / vault (aios-pack server) ------------------------------------
memory:      { server: aios-pack, tools: [recall, vault_read] }
vault-write: { server: aios-pack, tools: [vault_write, propose_action], actions: [vault.write] }

# -- sandboxed code execution ---------------------------------------------
code-sandbox: { server: code, tools: [mcp__code__sh], sandbox: true }

# -- domain servers ---------------------------------------------------------
money-analysis: { server: money, labels: [personal.finance], tools: [] }   # ← paste midas's mcp__money__* list
ledger:         { server: ledger, tools: [] }                               # ← paste juno's mcp__ledger__* list
research-kb:    { server: research, tools: [] }                             # ← paste research agents' mcp__research__* list
lifeops:        { server: lifeops, labels: [personal.tasks], tools: [] }    # ← paste jasmine's mcp__lifeops__* list

# -- client systems ----------------------------------------------------------
halalo-aws:  { server: cloudflare, tools: [mcp__halalo_analytics__cloudflare_analytics], guard: halalo-readonly }
attach:      { tools: [mcp__aios_attachments__attach_file] }

# -- guard-only modifiers -----------------------------------------------------
ops-guardrail:  { guard: atlas-mutating }
ledger-confine: { guard: ledger-read-confine }

# -- coordination (hermes; the aios moderator server itself is seam-attached) --
coordination:
  tools: [mcp__aios__run_playbook, mcp__aios__goal_status, mcp__aios__plan_goal,
          mcp__aios__list_playbooks, mcp__aios__hand_off, mcp__aios__send_mail,
          mcp__aios__vault_write, mcp__aios__vault_read, mcp__aios__vault_list,
          mcp__aios__propose_action, mcp__aios__add_reminder, mcp__aios__list_reminders,
          mcp__aios__cancel_reminder, mcp__aios__add_triage_rule, mcp__aios__list_inbox,
          mcp__aios__read_email, mcp__aios__recall, mcp__aios__remember, mcp__aios__forget]
```

The three `← paste` markers are filled during this step from the live manifests (open each file, copy its `mcp__<server>__*` entries verbatim). If bare `recall`/`vault_read`/`vault_write` appear in a domain agent's manifest they belong to memory/vault-write, not the domain capability.

- [ ] **Step 2: Migrate department manifests (full v2 contents)**

```yaml
# agents/engineering/department.yaml
department: engineering
mission: Build, test, review, and operate software safely in sandboxed workspaces.
lead: athena
memoDomain: code
vaultSection: code
capabilities: [files-ro, code-sandbox, memory, vault-write]
playbooks: [code-build, code-analyze]
sandbox: true
```

(Task 8 deletes the dept `actions:`/`toolServer` schema fields; until then just REMOVE those keys from the YAML — the vault.write action now rides the `vault-write` capability.)

```yaml
# agents/research/department.yaml
department: research
mission: Investigate deeply, verify sources, grow the knowledge base.
lead: clio
memoDomain: research
vaultSection: knowledge
capabilities: [files-ro, web, memory, vault-write, research-kb]
playbooks: [research-report, market-research, product-design]
```

```yaml
# agents/finance/department.yaml
department: finance
mission: Personal money visibility (read-only) and the group expense ledger.
lead: midas
memoDomain: money
capabilities: [memory]
playbooks: []
privateMemo: true
```

```yaml
# agents/life/department.yaml
department: life
mission: Personal operations — open loops, errands, follow-ups.
lead: jasmine
memoDomain: lifeops
capabilities: [memory, lifeops]
playbooks: []
```

```yaml
# agents/operations/department.yaml
department: operations
mission: Intake, triage, routing, and follow-up. The front door of AIOS.
lead: hermes
memoDomain: general
capabilities: []
playbooks: []
```

```yaml
# agents/clients/department.yaml
department: clients
mission: Client-project agents — read-only experts on external systems.
lead: halalo
memoDomain: general
capabilities: []
playbooks: []
```

(Copy the mission lines from the CURRENT files verbatim — the ones above are from recon; diff before committing. Keep any field the current file has that v2 keeps.)

- [ ] **Step 3: Migrate the 15 agent YAMLs**

Per agent: add `kind:` + `capabilities:` (extras beyond dept defaults), DELETE the `tools:` list. Everything else (name/title/charter/persona/prompt/maxTurns/permissionMode/aliases/skills/outputSchema/visibility/model) unchanged. Assignment table (dept defaults come free):

| Agent | kind | capabilities (beyond dept defaults) |
|---|---|---|
| athena | lead | — (dept defaults only) |
| vulcan | worker | `[editing, todo, shell]` |
| argus | critic | `[editing, shell]` |
| atlas | worker | `[editing, todo, web, ops-guardrail]` |
| odin | worker | `[web]` |
| themis | worker | `[shell]` |
| midas | lead | `[money-analysis]` |
| juno | worker | `[ledger, ledger-confine]` |
| jasmine | lead | — (dept defaults only) |
| clio | lead | — |
| janus | worker | — (keeps `skills: [market-sizing]`) |
| minos | critic | — |
| venus | worker | — (keeps `skills: [design-tokens]`) |
| halalo | lead | `[files-ro, halalo-aws, attach, memory]` (clients dept declares none) |
| hermes | coordinator | `[coordination, files-ro, web]` |

Discrepancy rule: after editing, run `npx vitest run test/org-golden.test.ts test/resolve-agent.test.ts`. Any agent whose resolved list ≠ golden → adjust that agent's capability line (or a capability's tool list) until equal. Do NOT edit the fixture except in Step 5.

- [ ] **Step 4: hermes.yaml v2 — prompt moves from code**

`agents/operations/hermes.yaml` keeps name/title/charter/persona/aliases/maxTurns/permissionMode, gains `kind: coordinator`, `capabilities: [coordination, files-ro, web]`, loses `tools: []`. Its `prompt:` becomes the STATIC portion of `moderatorPrompt` (src/moderator/prompt.ts): copy the template literal text minus the generated blocks (team roster, playbook list, memo block, projectsRoot line) — including the attachment-rules text (prompt.ts:64-75). Do not rewrite a word; cut/paste. `src/moderator/prompt.ts` shrinks in Task 6 (session cutover) — for THIS task, hermes.yaml only gains the text (nothing reads it yet beyond the persona prepend, which now includes the full static prompt — the moderator seam still builds its own prompt until Task 6, so temporarily the persona-prepend at session.ts:131 would DOUBLE the text. Prevent that: in this task change session.ts:129 to read only the first line — NO. Simpler: hold the prompt move until Task 6 and in THIS task keep hermes `prompt:` as-is ("You are Hermes…"). Mark the move as Task 6 Step 3.)

**Correction (binding):** hermes.yaml in THIS task = v2 fields only (`kind`, `capabilities`, drop `tools`), prompt line unchanged. The prompt text moves in Task 6 together with the session cutover, atomically.

- [ ] **Step 5: Update the golden fixture for hermes (documented delta)**

Now `resolveAgent("hermes")` produces the coordination+files-ro+web union == the old `MODERATOR_ALLOWED_TOOLS` — the fixture's hermes entry should ALREADY match (same 24 tools). Verify: `npx vitest run test/org-golden.test.ts` — if green, no fixture edit needed. Also update `test/resolve-agent.test.ts`: remove the `if (name === "hermes") continue;` skip (hermes now resolves like everyone).

- [ ] **Step 6: extras.ts slim-down**

`buildExtras` (extras.ts:20-54): remove the `toolChecks`/`toolCheckFallback` entries for halalo/juno/atlas (guards now come from capabilities via resolveAgent). KEEP halalo's `cwd`/`attachDirs`/`contextFiles`/`promptSuffix` and anything similar for others. **Gotcha:** until Task 5/6 cut the seams over, the OLD path (`compile()` merging extras.toolChecks) is what actually guards live runs — so in THIS task keep extras intact and make resolveAgent DEDUPE (capability guard + extras guard both present → compose once by name). Simplest: leave extras.ts untouched here; Task 8 removes the toolChecks entries after all seams use resolveAgent. Add a TODO(org-model Task 8) comment only.

- [ ] **Step 7: Assert no legacy shim capabilities fire on the live tree**

Append to `test/capabilities.test.ts`:

```ts
describe("live tree is fully v2", () => {
  it("no __legacy shim capabilities are synthesized", () => {
    const { loadConfig } = require("../src/config.js");
    const reg = loadRegistry("agents", "playbooks", {}, () => {});
    expect([...reg.capabilities.keys()].filter((k) => k.startsWith("__legacy"))).toEqual([]);
    expect(reg.coordinator).toBe("hermes");
    expect(reg.agents.get("argus")!.kind).toBe("critic");
    expect(reg.agents.get("minos")!.kind).toBe("critic");
    expect(reg.agents.get("athena")!.kind).toBe("lead");
  });
});
```

(Use ESM imports, not require — match the file's existing import style.)

- [ ] **Step 8: Full suite + typecheck + commit**

Run: `npx vitest run && npx tsc --noEmit` → green. The registry-live-tree clamp pins (cfo/midas money tools, juno ledger-not-money, vulcan sh + vault_write, athena no-Edit) are the sharpest check that the capability assignment is right.

```bash
git add agents src/agents test/capabilities.test.ts test/resolve-agent.test.ts test/fixtures/org-golden.json
git commit -m "feat(org): migrate 21 manifests to v2 — capabilities + kinds; _capabilities.yaml is live"
```

---

### Task 5: Seam cutover A — runner, engine, handoff

**Files:**
- Modify: `src/agents/runner.ts` (makeRunSpecialist consumes resolveAgent; RunOptions drops `pack`, gains `workspace?`/`idempotencyKey?`), `src/engine/engine.ts:264-266` (stop resolving dept; pass workspace/idem), `src/engine/workers.ts` (WorkerDeps drops resolvePack), `src/moderator/handoff.ts` (drop resolveDeptFor + model), `src/index.ts` (wiring: engine/planner/handoff get resolveAgent)
- Test: modify `test/hand-off.test.ts` (parity paths now both call resolveAgent — the pin stays as a regression tripwire), `test/pack-regression.test.ts` (rename intent: node runner threads workspace, not pack)

**Interfaces:**
- Consumes: `ResolveAgentFn` (Task 3).
- Produces:
  - runner.ts: `RunOptions = { cwd, additionalDirectories?, model?, signal?, outputSchema?, mailCtx?, workspace?, idempotencyKey? }` (NO `pack`); `makeRunSpecialist(deps: { store, bus, registry, mailbox?, resolveAgent: ResolveAgentFn })`. Layer order inside becomes: `resolveAgent(role, origin, {workspace, idempotencyKey, cwd})` → merge run opts (cwd/signal) → `withMailOptions` → StructuredOutput widen → `withDenialObserver` → query. `specialistOptions` DELETED (resolveAgent replaced it); `roleQueryOptions`/`packRunOptions` kept only if still referenced (direct.ts until Task 6), else deleted in Task 8.
  - Origin for node runs: the goal's `{ origin_channel, origin_chat_id }` — thread through RunOptions as `origin?: { channel, chatId }` with a safe default `{channel: "engine", chatId: "goals"}` (mirror what resolveDeptFor received at engine.ts:264 today).
  - engine.ts: worker() passes `workspace: <same value previously passed as workspace arg to resolveDeptFor>` and `idempotencyKey: \`${goalId}:${nodeKey}:${attempt}\`` — the sandbox/code-server behavior must stay byte-identical for engineering nodes.
  - handoff.ts: `makeHandOff` deps drop `resolveDeptFor` + `model`; body becomes canonicalize → privateOnly wall (unchanged) → `runSpecialist(agent, task, { cwd: projectsRoot, mailCtx, origin })`.
  - Model: engine/planner/handoff/direct STOP passing `config.specialistModel`; resolveAgent tiering owns model. `RunOptions.model` stays as an explicit override used only by non-registry one-shot callers (dream/speculate/curator) if they go through the runner — check call sites; leave those untouched.

- [ ] **Step 1: Update the parity test first (it defines the contract)** — in `test/hand-off.test.ts`, Path A and Path B both become `makeResolveAgent(...)(name, origin)` vs `makeRunSpecialist`-internal resolution observed via its options (keep asserting hand_off ≡ @mention allowedTools for every agent, and the deny-row test — the assertions stay, the plumbing changes). Run: FAIL (resolveAgent not yet wired into runner).
- [ ] **Step 2: Rewire runner.ts** per Interfaces. Keep `withMailOptions` exported + used (mail-pins test greps for it). Keep `fqPackTools` helper.
- [ ] **Step 3: Rewire engine.ts/workers.ts** — delete `resolvePack` from WorkerDeps (workers.ts:104) and the closure at engine.ts:264-266; pass `{workspace, idempotencyKey, origin}` through `deps.run`'s RunOptions at workers.ts:139-148. Critic/fixer calls unchanged (`runAgent(spec.critic!, …)`) — they now resolve their own caps (accepted delta 1).
- [ ] **Step 4: Rewire handoff.ts + index.ts wiring.** GoalEngine/planner/DirectChats deps: remove `model: config.specialistModel` where resolveAgent now owns it (planner's own one-shot planning call keeps its explicit model if it doesn't run through resolveAgent — verify; the plan_goal planner is a bare query(), untouched).
- [ ] **Step 5: Full suite + typecheck.** Expect fallout in `pack-regression.test.ts` (rewrite to assert workspace threading), possibly `code-runner-clamp`/`mail-runner` (update construction to the new makeRunSpecialist deps — assertions unchanged). Golden + registry-live-tree pins must stay green untouched.
- [ ] **Step 6: Commit**

```bash
git add src/agents/runner.ts src/engine src/moderator/handoff.ts src/index.ts test
git commit -m "feat(org): runner/engine/handoff seams consume resolveAgent — pack threading deleted"
```

---

### Task 6: Seam cutover B — direct chats, moderator session, web views

**Files:**
- Modify: `src/agents/direct.ts` (resolveAgent; cloudflare hardcode deleted), `src/moderator/session.ts` (hermes via resolveAgent; MODERATOR_ALLOWED_TOOLS deleted; prompt from YAML + generated blocks), `src/moderator/prompt.ts` (shrinks to block builders), `agents/operations/hermes.yaml` (prompt text moves in, atomically with this task), `src/web/permissions-view.ts:42-66` (pseudo-role dies), `src/web/org-view.ts:95` (same), `src/web/server.ts:62` (isChiefOfStaff → coordinator lookup)
- Test: modify `test/permissions-view.test.ts` (hermes row now comes from the registry like everyone), any session tests

**Interfaces:**
- Consumes: `ResolveAgentFn`, `registry.coordinator` (Task 2).
- Produces:
  - direct.ts handle flow: canonicalize → privateOnly wall → lock → `const resolved = resolveAgent(canonical, {channel, chatId}, {cwd: def.cwd ?? projectsRoot})` → mail widen (inline block unchanged) → attachments server (unchanged, still turn-scoped) → `withDenialObserver` last. `roleServers` cloudflare line (direct.ts:117-118) DELETED — halalo's cloudflare server now arrives inside `resolved.options.mcpServers` via the halalo-aws capability.
  - session.ts: `MODERATOR_ALLOWED_TOOLS`, `MCP_TOOLS` consts deleted. Options built as: `const resolved = resolveAgent(registry.coordinator, origin, {})!;` then `{ ...resolved.options, mcpServers: { ...resolved.options.mcpServers, aios: server }, permissionMode: "dontAsk", settingSources: [], strictMcpConfig: true, maxTurns: 40, env: {...} }` → systemPrompt = `resolved.options.systemPrompt` (hermes YAML full prompt + dept block) + generated blocks → `withDenialObserver(…, "hermes", …)`. The persona-prepend special case (session.ts:129-131) dies — the YAML prompt IS the base now.
  - prompt.ts: `moderatorPrompt(...)` replaced by `moderatorBlocks({ playbooks, projectsRoot, memoBlock, roster }): string` returning ONLY the generated sections (team roster via buildTeamBlock, playbook list, projects-root line, memo). The static text it used to emit is now in hermes.yaml (cut/paste verbatim, including attachment rules).
  - server.ts: `isChiefOfStaff` deleted; the two call sites (:247, :265) use a local `const toCoordinator = (t?: string) => !t || (registry.agentOf.get(t.toLowerCase()) ?? "") === registry.coordinator;` (WebDeps already has registry).
  - permissions-view.ts: delete the synthetic hermes entry + `MODERATOR_ALLOWED_TOOLS` import; hermes flows through the normal catalog (its base = resolved capability union — expose via a `baseToolsOf(name)` helper backed by resolveAgent or registry capability union). org-view.ts:95 same fix.

- [ ] **Step 1: Move the prompt text** — cut the static template from prompt.ts into hermes.yaml `prompt: |` (YAML block scalar; watch backtick/`${}` remnants — interpolations become either generated-block content or plain text). `session.ts` assembles YAML prompt + `moderatorBlocks(...)`.
- [ ] **Step 2: Rewire session.ts + direct.ts + web views** per Interfaces.
- [ ] **Step 3: Run suite.** Expected fallout: `permissions-view.test.ts` (hermes row shape — update expectations: same tools list, now sourced from registry), `org-view.test.ts` if it pinned MODERATOR_ALLOWED_TOOLS, moderator/session tests (prompt content moved — tests asserting prompt substrings should now find them via the registry-loaded YAML; update imports), `direct.test.ts` halalo cloudflare (server now via capability — assertion target moves from roleServers to options.mcpServers).
- [ ] **Step 4: Grep guard** — `grep -rn "MODERATOR_ALLOWED_TOOLS\|isChiefOfStaff" src/ test/` → only historical docs. Full suite + tsc green.
- [ ] **Step 5: Commit**

```bash
git add src/agents/direct.ts src/moderator agents/operations/hermes.yaml src/web test
git commit -m "feat(org): hermes is a normal coordinator agent — pseudo-role paths deleted; direct seam on resolveAgent"
```

---

### Task 7: One address parser

**Files:**
- Modify: `src/agents/direct.ts:163-203` (merge parsers), `src/router.ts:139,157` (one call, `requireAt` by binding)
- Test: `test/address-parser.test.ts` (create — table tests), update `test/direct.test.ts` (drop tests of deleted exports; keep behavior cases by porting them to the new fn)

**Interfaces:**
- Produces: `parseAddress(text: string, names: string[], opts?: { requireAt?: boolean }): { role: string; text: string } | undefined` — matches `@name` ANYWHERE (`(^|\s)@name\b[:,]?`, mention stripped) always; matches bare `name:`/`name,` PREFIX only when `!opts.requireAt`. Case-insensitive, names regex-escaped, role lowercased, must leave non-empty remaining text. `parseDirectAddress`/`findAgentMention`/`parseAgentAddress` deleted.
- router.ts: bound-group path calls `parseAddress(text, binding.agents, { requireAt: true })`; DM/unbound path `parseAddress(text, directChats.names())`. Fallback branches (mentionOnly silence, first-bound-agent default, moderator default) unchanged.

- [ ] **Step 1: Failing table test**

```ts
// test/address-parser.test.ts
import { describe, it, expect } from "vitest";
import { parseAddress } from "../src/agents/direct.js";

const names = ["halalo", "market-researcher", "cfo"];

describe("parseAddress", () => {
  const cases: Array<[string, { requireAt?: boolean } | undefined, string | undefined, string?]> = [
    // [input, opts, expected role, expected text]
    ["@halalo how are sales?", undefined, "halalo", "how are sales?"],
    ["halalo: how are sales?", undefined, "halalo", "how are sales?"],
    ["Hey @halalo, quick one", undefined, "halalo", "Hey , quick one"],
    ["@Market-Researcher: sizing please", undefined, "market-researcher", "sizing please"],
    ["finance: revenue up 10%", undefined, undefined],            // not a known name
    ["email halalo@example.com about it", undefined, undefined],  // emails never match
    ["@halalo", undefined, undefined],                            // no remaining text
    // bound groups: @ required
    ["halalo: how are sales?", { requireAt: true }, undefined],
    ["@halalo how are sales?", { requireAt: true }, "halalo", "how are sales?"],
    ["mid-sentence ping @cfo runway?", { requireAt: true }, "cfo", "mid-sentence ping runway?"],
  ];
  for (const [input, opts, role, text] of cases) {
    it(`${JSON.stringify(input)} ${opts?.requireAt ? "(bound)" : ""} → ${role ?? "no match"}`, () => {
      const r = parseAddress(input, names, opts);
      if (!role) expect(r).toBeUndefined();
      else {
        expect(r!.role).toBe(role);
        if (text !== undefined) expect(r!.text).toBe(text);
      }
    });
  }
});
```

(Exact stripped-text expectations for mid-sentence mentions: port the CURRENT `findAgentMention` stripping behavior from `test/direct.test.ts:8-33` — whatever whitespace normalization it does today is the contract; adjust the two mid-sentence expected strings to match observed output rather than inventing new normalization.)

- [ ] **Step 2: Implement + rewire router** per Interfaces (implementation = today's `findAgentMention` body with the prefix branch gated on `!requireAt`; delete the two old exports; update `test/direct.test.ts` imports).
- [ ] **Step 3: Full suite + tsc + commit**

```bash
git add src/agents/direct.ts src/router.ts test/address-parser.test.ts test/direct.test.ts
git commit -m "feat(org): one address parser — @ anywhere, prefix only in DMs; bound groups require @"
```

---

### Task 8: Deletion sweep — Pack struct, shims, dead code, packs-view fix

**Files:**
- Delete: `src/packs/types.ts`, `src/packs/resolve.ts`
- Modify: `src/agents/registry/loader.ts` (shims out: `capabilities` + `kind` now REQUIRED by schema — `agentSchema.kind` loses `.optional()` → required; agent `tools` field deleted from schema; dept `toolServer`/`toolServers`/`tools`/`actions` fields deleted from schema; `toolsUnion` deleted), `src/agents/registry/types.ts` (same), `src/agents/registry/extras.ts` (toolChecks entries for halalo/juno/atlas removed — guards live on capabilities), `src/agents/runner.ts` (delete `packRunOptions`, `clampTools` remnants, `roleQueryOptions` if now internal-only), `src/index.ts` (delete `resolveDeptFor` + the 4-server inline registry — SERVER_BUILDERS owns them), `src/web/packs-view.ts` (v2: read `capabilities` for the tools display)
- Delete tests: `pack-schema`, `pack-resolve`, `pack-toolserver`, `pack-e2e`, `code-pack-schema`, `code-pack-resolve`, `code-pack-loader`, `money-pack` (the packSchema-shape parts — keep/port any money PRIVACY assertions into `test/money-privacy.test.ts` if they only exist there), `pack-loader` (port its playbook-scan cases into `registry-loader.test.ts`), `pack-runner`, `pack-regression` (superseded by Task 5's workspace test)
- Modify tests: `registry-resolve.test.ts` → retarget to resolveAgent (or delete if fully covered by `resolve-agent.test.ts`), fixture trees gain required `kind`/`capabilities` fields

**Interfaces:**
- Consumes: everything green from Tasks 1-7.
- Produces: `grep -rn "makeResolveDeptFor\|resolvePack\|packSchema\|PackRegistry\|pillarOf\|roleOf\|MODERATOR_ALLOWED_TOOLS\|isChiefOfStaff\|parseDirectAddress\|findAgentMention\|toolsUnion" src/` → zero hits. packs-view.ts keeps `/api/packs` shape (PackView unchanged — additive-only web API): tools display = union of the dept's + members' capability tool lists (parse `_capabilities.yaml` alongside the manifests it already re-parses from disk).

- [ ] **Step 1: Schema hardening + shim removal** — make `kind` + `capabilities` required (`capabilities` keeps `.default([])` at DEPT level only; agent level required non-empty? No — an agent may rely purely on dept defaults: keep agent `capabilities` defaulting to `[]` but DELETE the `tools` field so v1 files fail loudly). Delete the `__legacy` synthesis block and the kind-inference chain (loader). `registry-loader`/fixture trees updated to v2 (each fixture agent gains `kind:` + capability files).
- [ ] **Step 2: Delete packs/{types,resolve}.ts + index.ts wiring + runner remnants + extras toolChecks.** Fix every import the compiler flags. `memoContextForDomain` moves into resolve.ts (or a small `src/agents/context.ts`) if it lived in packs/resolve.ts.
- [ ] **Step 3: packs-view v2** — in `buildPacksView`, load `agents/_capabilities.yaml` once (reuse `loadCapabilities`), and build `toolsSet` from `[...dept.capabilities, ...member.capabilities]` unions instead of `m.tools`. Roles view unchanged otherwise. `test/packs-view.test.ts` expectations updated (tools list now capability-derived — same effective content for engineering).
- [ ] **Step 4: Test sweep** — delete/port per Files list. Run `npx vitest run` repeatedly until green; every deletion must be justified by "shape test of a deleted struct" — behavior tests get PORTED not dropped (money privacy, playbook scanning, dept enable/disable).
- [ ] **Step 5: Grep guards + full suite + tsc.** Also re-run `npx tsx scripts/gen-org-golden.ts` — script now needs updating to generate FROM resolveAgent (it imported the deleted path): rewrite generator to call `makeResolveAgent` (same fixture format), regenerate, confirm `git diff test/fixtures/org-golden.json` is EMPTY (proof the final path equals the pinned surface).
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(org)!: delete Pack struct, loader shims, pseudo-role paths, second parser — capabilities are the only model"
```

---

### Task 9: Merge, deploy, live smoke

- [ ] **Step 1: Final suites in worktree** — `npx vitest run && npx tsc --noEmit` (expect ≈1055±(new−deleted) pass + 1 skip; record the new baseline number for the memory update).
- [ ] **Step 2: Merge** — `git checkout main && git merge --ff-only org-model && git worktree remove .worktrees/org-model && git branch -d org-model`, re-run suite on main.
- [ ] **Step 3: Deploy** — `npm run build && launchctl kickstart -k gui/$(id -u)/com.ihab.aios`. Boot log MUST show the registry loading 6 depts / 15 agents with zero boot errors (a capability/guard/alias/coordinator error would crash-loop launchd — watch `data/aios.log` for 60s).
- [ ] **Step 4: Live smoke**
  1. `curl /api/state` — 15 agents listed; hermes present.
  2. `curl /api/permissions` — hermes row present WITHOUT the pseudo-role special case (tools = coordination∪files-ro∪web).
  3. Web chat → hermes: "run an echo test goal" → goal done (coordinator seam + engine seam).
  4. Web chat → `@vulcan hello` (direct seam, engineering caps).
  5. `curl /api/attention` + Staff UI loads (org-view without MODERATOR_ALLOWED_TOOLS).
  6. Verify model tiering visible: `sqlite3` the last agent.end events or check logs for model ids per kind (spot-check one lead vs one worker) — only if AIOS_MODERATOR_MODEL/AIOS_SPECIALIST_MODEL are actually set in .env; otherwise all inherit daemon default (fine).
- [ ] **Step 5: Push** — `git push`; update memory (`aios-project.md`): new baseline count, capabilities live, spec 4 of 7 done.

## Self-review notes (already applied)

1. **Spec coverage:** §3 capability primitive → Tasks 2+4; §4 schema v2 → Tasks 2 (fields) + 8 (hardening); §5 hermes/pseudo-roles → Task 6; §6 model tiering → Tasks 2 (config) + 3 (resolveAgent); §7 one resolution path + Pack deletion → Tasks 3+5+8; §8 one parser → Task 7; §9 migration order (shims → YAMLs → delete) → Tasks 2→4→8; §10 testing: golden (T1), clamp property (T3), boot errors (T2), seam parity retained (T5), parser table (T7).
2. **Deliberate deviations from the spec's illustrative YAML:** mail/attachments not capabilities (delta 7); no `mcp__money__*` wildcards — explicit tool lists (wildcard expansion would need server introspection at load; explicit lists keep the golden test exact); capability names differ where the spec's sketch was approximate (`web`, `files-ro` kept; `money-analysis` etc. kept; `halalo-aws` kept as the spec named it even though the server is cloudflare).
3. **Sequencing hazards called out in-task:** hermes prompt move is atomic with the session cutover (Task 6, NOT Task 4 — Task 4 Step 4 contains the correction); extras.toolChecks stay until all seams resolve through capabilities (Task 8); both resolution paths coexist Tasks 3-6.
4. **Type consistency:** `ResolveAgentFn`/`ResolvedAgent`/`ResolveCtx` (T3) consumed with the same names in T5/T6; `NAMED_GUARDS`/`GuardConfig` (T2) consumed in T3; `registry.coordinator: string` (T2) consumed in T6; `parseAddress` (T7) is the only parser export after T8.
5. **Known execution freedom:** exact tool lists for the four domain capabilities are copied from live manifests at execution time (source files named); fixture equality is the arbiter, so a transcription slip is caught by name.
