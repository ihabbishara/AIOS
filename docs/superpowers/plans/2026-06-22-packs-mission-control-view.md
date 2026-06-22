# Packs Mission Control View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Packs" Mission Control tab reflecting every bound pillar (config + live activity) with launch, enable/disable, and playbook-edit actions.

**Architecture:** A new `buildPacksView(config, store)` scans `playbooks/*/pack.yaml` from disk (so disabled packs stay visible) and joins live job/workspace/memo signals from the store; served at `GET /api/packs`. Three small mutating endpoints (`run`, `enabled`, pillar-scoped file edit) reuse the existing job/env/reload machinery. A new `ui/src/views/Packs.tsx` renders pillar cards. The code-only kill-switch generalizes to a per-pillar `AIOS_<PILLAR>_DISABLED` flag via `dropPack`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 23 `node:sqlite`, vitest (backend), React + Vite (ui), zod.

## Global Constraints

- Node 23 built-in `node:sqlite` only; subscription auth, no API keys.
- ESM: every relative import ends in `.js`. Backend tests: `import { describe, it, expect } from "vitest"`; run `npx vitest run <file>`.
- Commit EXPLICIT paths only (`git add <path> …`) — NEVER `git add -A`. The uncommitted pdf-attachments WIP in the main checkout must never be staged.
- Work in the isolated worktree's absolute path. `src/index.ts` is a WIP-overlap file — it 3-way merges at deploy; edit normally in the worktree (off clean HEAD).
- No DB schema change this cycle.
- The view reads pack DEFINITIONS from disk (`config.playbooksDir`), NOT the live in-memory registry — a disabled pack is dropped from the registry but must still appear (greyed, re-enableable).
- Backend mutating endpoints inherit the existing token-auth gate (server.ts:115-118); no new exposure.
- UI has no component-test harness — UI tasks verify via `cd ui && npm run build` (type-checks + builds) plus a scripted `curl`/manual render check. Data-shape correctness is tested at the backend builder/endpoint level.

**Module map.** New: `src/web/packs-view.ts` (view builder + types), `ui/src/views/Packs.tsx` (the view). Modified: `src/web/server.ts` (4 endpoints), `src/packs/loader.ts` (`dropPack`), `src/index.ts` (per-pillar kill-switch loop), `ui/src/api.ts` (client + types), `ui/src/App.tsx` (nav tab).

---

### Task 1: Generalized per-pillar kill-switch

**Files:**
- Modify: `src/packs/loader.ts` (add `dropPack`, keep `dropCodePack` as alias)
- Modify: `src/index.ts` (per-pillar env loop, after `loadPacks` and in `reloadPacks`)
- Test: `test/pack-killswitch.test.ts`

**Interfaces:**
- Consumes: `LoadedPacks` (loader.ts).
- Produces: `dropPack(reg: LoadedPacks, pillar: string): void` — drops the pillar's pack + its playbooks (from `playbooks`+`pillarOf`) + its `roleOf` entries; null-safe. `dropCodePack(reg)` becomes `dropPack(reg, "code")`.

- [ ] **Step 1: Write the failing test**

```ts
// test/pack-killswitch.test.ts
import { describe, it, expect } from "vitest";
import type { LoadedPacks } from "../src/packs/loader.js";
import { dropPack, dropCodePack } from "../src/packs/loader.js";

function reg(): LoadedPacks {
  return {
    packs: new Map([
      ["code", { pillar: "code", roles: ["devops", "developer"], playbooks: ["code-build"] } as any],
      ["money", { pillar: "money", roles: ["cfo"], playbooks: [] } as any],
    ]),
    pillarOf: new Map([["code-build", "code"]]),
    roleOf: new Map([["devops", "code"], ["developer", "code"], ["cfo", "money"]]),
    playbooks: new Map([["code-build", {} as any]]),
  };
}

describe("dropPack", () => {
  it("drops a named pillar's pack, playbooks, and roleOf entries; leaves others", () => {
    const r = reg();
    dropPack(r, "code");
    expect(r.packs.has("code")).toBe(false);
    expect(r.playbooks.has("code-build")).toBe(false);
    expect(r.pillarOf.has("code-build")).toBe(false);
    expect(r.roleOf.has("devops")).toBe(false);
    expect(r.roleOf.has("developer")).toBe(false);
    // money untouched
    expect(r.packs.has("money")).toBe(true);
    expect(r.roleOf.get("cfo")).toBe("money");
  });

  it("drops money independently", () => {
    const r = reg();
    dropPack(r, "money");
    expect(r.packs.has("money")).toBe(false);
    expect(r.roleOf.has("cfo")).toBe(false);
    expect(r.packs.has("code")).toBe(true);
  });

  it("is a no-op for an absent pillar", () => {
    const r = reg();
    expect(() => dropPack(r, "nope")).not.toThrow();
    expect(r.packs.size).toBe(2);
  });

  it("dropCodePack is dropPack(reg,'code')", () => {
    const r = reg();
    dropCodePack(r);
    expect(r.packs.has("code")).toBe(false);
    expect(r.packs.has("money")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pack-killswitch.test.ts`
Expected: FAIL — `dropPack` not exported.

- [ ] **Step 3: Implement**

In `src/packs/loader.ts`, find the existing `dropCodePack` and replace it with the generalized version (keep the alias):
```ts
/** Strip a pillar's pack + its playbooks + its roleOf entries from a loaded registry. Null-safe. */
export function dropPack(reg: LoadedPacks, pillar: string): void {
  const pack = reg.packs.get(pillar);
  if (!pack) return;
  for (const pb of pack.playbooks) { reg.playbooks.delete(pb); reg.pillarOf.delete(pb); }
  for (const role of pack.roles) { if (reg.roleOf.get(role) === pillar) reg.roleOf.delete(role); }
  reg.packs.delete(pillar);
}

/** Back-compat alias for the code-only kill-switch. */
export function dropCodePack(reg: LoadedPacks): void {
  dropPack(reg, "code");
}
```
> If `dropCodePack` previously lived elsewhere or had a different body, replace it; keep its exported name so `test/code-killswitch.test.ts` still imports it.

In `src/index.ts`, replace the single `if (config.codeDisabled) dropCodePack({ playbooks, packs, pillarOf, roleOf } as LoadedPacks);` (near line 73) with a per-pillar loop:
```ts
import { loadPacks, dropPack } from "./packs/loader.js";   // update the existing import
// ...after loadPacks:
for (const pillar of [...packs.keys()]) {
  if (process.env[`AIOS_${pillar.toUpperCase()}_DISABLED`] === "1") {
    dropPack({ playbooks, packs, pillarOf, roleOf } as LoadedPacks, pillar);
  }
}
```
Apply the SAME loop inside `reloadPacks` to the `fresh` registry before the in-place merge. `AIOS_CODE_DISABLED=1` now matches `AIOS_${"code".toUpperCase()}_DISABLED` — backward-compatible.

- [ ] **Step 4: Run test + type-check**

Run: `npx vitest run test/pack-killswitch.test.ts test/code-killswitch.test.ts && npx tsc --noEmit`
Expected: PASS (both files) + clean tsc.

- [ ] **Step 5: Commit**

```bash
git add src/packs/loader.ts src/index.ts test/pack-killswitch.test.ts
git commit -m "feat(packs-view): generalized per-pillar kill-switch (dropPack + AIOS_<PILLAR>_DISABLED)"
```

---

### Task 2: `buildPacksView` + `GET /api/packs`

**Files:**
- Create: `src/web/packs-view.ts`
- Modify: `src/web/server.ts` (add the `GET /api/packs` route + import)
- Test: `test/packs-view.test.ts`

**Interfaces:**
- Consumes: `Config` (`src/config.js`), `Store` (`src/store/db.js`), `packSchema` (`src/packs/types.js`), `loadPlaybook` (`src/engine/playbook.js`), `roles` (`src/agents/roles/index.js`). Store methods: `store.listJobs(limit)`, `store.memoryStats(domain) → {count, avgLen}`.
- Produces: `buildPacksView(config, store): PackView[]` and the `PackView`/`PackRoleView`/`PackPlaybookView`/`PackJobView`/`PackWorkspaceView` types (exported).

- [ ] **Step 1: Write the failing test**

```ts
// test/packs-view.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { buildPacksView } from "../src/web/packs-view.js";

function fixtureConfig(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "pv-"));
  const playbooksDir = join(root, "playbooks");
  const codeDir = join(playbooksDir, "code");
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(join(codeDir, "pack.yaml"),
    `pillar: code\nsandbox: true\npersona: "engineer"\nmemoDomain: code\nactions: [vault.write]\n` +
    `roles: [developer, devops]\ntools: [Read, mcp__code__sh]\nplaybooks: [code-build]\n`);
  writeFileSync(join(codeDir, "code-build.yaml"),
    `name: code-build\ndescription: build\nneedsProjectDir: false\nstages:\n  - type: single\n    id: implement\n    role: developer\n    brief: do it\n`);
  const moneyDir = join(playbooksDir, "money");
  mkdirSync(moneyDir, { recursive: true });
  writeFileSync(join(moneyDir, "pack.yaml"),
    `pillar: money\npersona: "cfo"\nmemoDomain: money\nactions: []\nroles: [cfo]\ntools: [mcp__money__x]\nplaybooks: []\n`);
  return { playbooksDir, workspaceRoot: join(root, "ws"), projectsRoot: root, ...overrides } as any;
}

describe("buildPacksView", () => {
  it("returns one card per pack on disk, with config", () => {
    const view = buildPacksView(fixtureConfig(), new Store(":memory:"));
    const code = view.find((p) => p.pillar === "code")!;
    expect(code.sandbox).toBe(true);
    expect(code.actions).toEqual(["vault.write"]);
    expect(code.tools).toContain("mcp__code__sh");
    expect(code.enabled).toBe(true);
    expect(code.playbooks[0].name).toBe("code-build");
    expect(code.playbooks[0].stages[0]).toMatchObject({ id: "implement", type: "single", role: "developer" });
    // sandbox pack → roles flagged advisoryInDirect
    expect(code.roles.find((r) => r.name === "developer")!.advisoryInDirect).toBe(true);
    const money = view.find((p) => p.pillar === "money")!;
    expect(money.playbooks).toEqual([]);
    expect(money.sandbox).toBe(false);
  });

  it("marks a pack disabled via AIOS_<PILLAR>_DISABLED but still returns it", () => {
    process.env.AIOS_CODE_DISABLED = "1";
    try {
      const view = buildPacksView(fixtureConfig(), new Store(":memory:"));
      const code = view.find((p) => p.pillar === "code")!;
      expect(code.enabled).toBe(false);
      expect(code.pillar).toBe("code"); // still present → re-enableable
    } finally {
      delete process.env.AIOS_CODE_DISABLED;
    }
  });

  it("joins live jobs + workspaces + memo count", () => {
    const config = fixtureConfig();
    const store = new Store(":memory:");
    const taskDir = join(config.workspaceRoot, "2026-06-22-x-ab12");
    store.insertJob({ id: "j1", slug: "x", title: "build x", playbook: "code-build", request: "r",
      project_dir: taskDir, channel: "web", chat_id: "packs-view", status: "queued", error: null } as any);
    store.updateJobStatus("j1", "done");
    const view = buildPacksView(config, store);
    const code = view.find((p) => p.pillar === "code")!;
    expect(code.recentJobs.map((j) => j.id)).toContain("j1");
    expect(code.workspaces.map((w) => w.taskDir)).toContain(taskDir);
    expect(code.workspaces[0].exists).toBe(false); // never created on disk
    expect(typeof code.memoCount).toBe("number");
  });

  it("degrades a manifest role missing from the roles record, not throws", () => {
    const config = fixtureConfig();
    // money pack references cfo which exists; add a bogus role to code's manifest via a rewrite
    const code = buildPacksView(config, new Store(":memory:")).find((p) => p.pillar === "code")!;
    expect(code.roles.every((r) => typeof r.description === "string")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/packs-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/web/packs-view.ts
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config } from "../config.js";
import type { Store } from "../store/db.js";
import { packSchema } from "../packs/types.js";
import { loadPlaybook } from "../engine/playbook.js";
import { roles } from "../agents/roles/index.js";

export interface PackRoleView {
  name: string;
  description: string;
  privateOnly: boolean;
  advisoryInDirect: boolean;
  permissionMode: string;
  allowedTools: string[];
}
export interface PackPlaybookView {
  name: string;
  description: string;
  needsProjectDir: boolean;
  stages: Array<{ id: string; type: string; role: string }>;
}
export interface PackJobView {
  id: string; title: string; playbook: string; status: string; created_at: string; projectDir: string | null;
}
export interface PackWorkspaceView { taskDir: string; exists: boolean; jobId: string; title: string; status: string; }
export interface PackView {
  pillar: string;
  persona: string;
  memoDomain: string;
  vaultSection: string;
  sandbox: boolean;
  enabled: boolean;
  toolServer?: string;
  tools: string[];
  actions: string[];
  roles: PackRoleView[];
  playbooks: PackPlaybookView[];
  recentJobs: PackJobView[];
  workspaces: PackWorkspaceView[];
  memoCount: number;
}

function stageRole(s: { type: string; role?: string; producer?: string; runner?: string }): string {
  return s.role ?? s.producer ?? s.runner ?? "?";
}

export function buildPacksView(config: Config, store: Store): PackView[] {
  const out: PackView[] = [];
  let entries: string[];
  try { entries = readdirSync(config.playbooksDir); } catch { return out; }

  const recentJobs = store.listJobs(100);

  for (const entry of entries) {
    const manifestPath = join(config.playbooksDir, entry, "pack.yaml");
    if (!existsSync(manifestPath)) continue;
    let pack: ReturnType<typeof packSchema.parse>;
    try { pack = packSchema.parse(parseYaml(readFileSync(manifestPath, "utf8"))); }
    catch { continue; } // skip a malformed manifest, like the loader

    const enabled = process.env[`AIOS_${pack.pillar.toUpperCase()}_DISABLED`] !== "1";

    const roleViews: PackRoleView[] = pack.roles.map((name) => {
      const def = roles[name];
      if (!def) return { name, description: "(missing role def)", privateOnly: false, advisoryInDirect: pack.sandbox, permissionMode: "?", allowedTools: [] };
      return {
        name,
        description: def.description,
        privateOnly: !!def.privateOnly,
        advisoryInDirect: pack.sandbox,
        permissionMode: def.permissionMode,
        allowedTools: def.allowedTools,
      };
    });

    const playbookViews: PackPlaybookView[] = [];
    for (const pbName of pack.playbooks) {
      const pbPath = join(config.playbooksDir, entry, `${pbName}.yaml`);
      if (!existsSync(pbPath)) continue;
      try {
        const pb = loadPlaybook(pbPath);
        playbookViews.push({
          name: pb.name,
          description: pb.description,
          needsProjectDir: !!pb.needsProjectDir,
          stages: pb.stages.map((s) => ({ id: s.id, type: s.type, role: stageRole(s as never) })),
        });
      } catch { /* skip an unparseable playbook */ }
    }

    const myJobs = recentJobs.filter((j) => pack.playbooks.includes(j.playbook)).slice(0, 10);
    const jobViews: PackJobView[] = myJobs.map((j) => ({
      id: j.id, title: j.title, playbook: j.playbook, status: j.status, created_at: j.created_at, projectDir: j.project_dir,
    }));

    const workspaces: PackWorkspaceView[] = [];
    if (pack.sandbox) {
      const seen = new Set<string>();
      for (const j of myJobs) {
        const dir = j.project_dir;
        if (!dir || seen.has(dir) || !dir.startsWith(config.workspaceRoot)) continue;
        seen.add(dir);
        let exists = false;
        try { exists = statSync(dir).isDirectory(); } catch { exists = false; }
        workspaces.push({ taskDir: dir, exists, jobId: j.id, title: j.title, status: j.status });
      }
    }

    out.push({
      pillar: pack.pillar,
      persona: pack.persona,
      memoDomain: pack.memoDomain,
      vaultSection: pack.vaultSection,
      sandbox: pack.sandbox,
      enabled,
      toolServer: pack.toolServer,
      tools: pack.tools,
      actions: pack.actions,
      roles: roleViews,
      playbooks: playbookViews,
      recentJobs: jobViews,
      workspaces,
      memoCount: store.memoryStats(pack.memoDomain).count,
    });
  }
  return out;
}
```

In `src/web/server.ts`: add the import near the other view import (`import { buildPermissionsView, ... }`):
```ts
import { buildPacksView } from "./packs-view.js";
```
And add the route alongside `/api/permissions` (GET):
```ts
        if (path === "/api/packs" && req.method === "GET") {
          return json(res, 200, buildPacksView(config, store));
        }
```

- [ ] **Step 4: Run test + type-check**

Run: `npx vitest run test/packs-view.test.ts && npx tsc --noEmit`
Expected: PASS + clean tsc.

- [ ] **Step 5: Commit**

```bash
git add src/web/packs-view.ts src/web/server.ts test/packs-view.test.ts
git commit -m "feat(packs-view): buildPacksView + GET /api/packs (disk-sourced, live signals)"
```

---

### Task 3: `Packs.tsx` read-only view + nav tab + `api.packs()`

**Files:**
- Create: `ui/src/views/Packs.tsx`
- Modify: `ui/src/api.ts` (add `PackView` types + `packs()`)
- Modify: `ui/src/App.tsx` (import + "Packs" tab)

**Interfaces:**
- Consumes: `GET /api/packs` → `PackView[]` (Task 2 shape).
- Produces: `api.packs()`; the `Packs` component. (Run/toggle/edit added in Tasks 4-6.)

- [ ] **Step 1: Add the API client + types**

In `ui/src/api.ts`, add the types (mirror Task 2) and the client method:
```ts
export interface PackRoleView { name: string; description: string; privateOnly: boolean; advisoryInDirect: boolean; permissionMode: string; allowedTools: string[]; }
export interface PackPlaybookView { name: string; description: string; needsProjectDir: boolean; stages: Array<{ id: string; type: string; role: string }>; }
export interface PackJobView { id: string; title: string; playbook: string; status: string; created_at: string; projectDir: string | null; }
export interface PackWorkspaceView { taskDir: string; exists: boolean; jobId: string; title: string; status: string; }
export interface PackView {
  pillar: string; persona: string; memoDomain: string; vaultSection: string; sandbox: boolean; enabled: boolean;
  toolServer?: string; tools: string[]; actions: string[];
  roles: PackRoleView[]; playbooks: PackPlaybookView[]; recentJobs: PackJobView[]; workspaces: PackWorkspaceView[]; memoCount: number;
}
```
and in the `api` object:
```ts
  packs: () => request<PackView[]>("/api/packs"),
```

- [ ] **Step 2: Create the view**

```tsx
// ui/src/views/Packs.tsx
import { useMemo } from "react";
import { api, type PackView, type StoredEvent } from "../api.js";
import { usePoll } from "../hooks.js";

export function Packs({ events }: { events: StoredEvent[] }) {
  const lastEvt = useMemo(
    () => events.filter((e) => e.event.type.startsWith("job.") || e.event.type.startsWith("stage.")).at(-1)?.id,
    [events],
  );
  const { data: packs } = usePoll(() => api.packs(), [lastEvt]);

  return (
    <div className="flex flex-col gap-4 overflow-auto h-full min-h-0 pr-1">
      {(packs ?? []).map((p, i) => <PackCard key={p.pillar} pack={p} i={i} />)}
      {packs && packs.length === 0 && (
        <div className="border border-dashed border-line text-dim text-[11px] p-4 text-center">no packs bound</div>
      )}
    </div>
  );
}

function PackCard({ pack, i }: { pack: PackView; i: number }) {
  const dim = pack.enabled ? "" : "opacity-50";
  return (
    <section className={`boot hud p-4 ${dim}`} style={{ animationDelay: `${i * 60}ms` }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="font-display uppercase tracking-[0.2em] text-[13px] text-phosphor glow-green">{pack.pillar}</span>
        {pack.sandbox && <span className="text-[9px] text-cyan border border-cyan px-1">sandbox</span>}
        <span className={`text-[10px] ml-auto ${pack.enabled ? "text-phosphor" : "text-dim"}`}>
          {pack.enabled ? "● enabled" : "○ disabled"}
        </span>
      </div>
      <div className="text-[11px] text-dim mb-2 line-clamp-2">{pack.persona}</div>
      <div className="text-[10px] text-dim mb-2">
        memo: {pack.memoDomain} · vault: {pack.vaultSection} · actions: [{pack.actions.join(", ") || "none"}] · memos: {pack.memoCount}
      </div>
      <div className="mb-2">
        <span className="label">Roles</span>
        <div className="flex flex-wrap gap-1 mt-1">
          {pack.roles.map((r) => (
            <span key={r.name} title={`${r.description} · ${r.permissionMode}`}
              className="text-[10px] border border-line px-1 text-fg">
              {r.name}{r.privateOnly ? " (private)" : ""}{r.advisoryInDirect ? " ★" : ""}
            </span>
          ))}
        </div>
      </div>
      {pack.playbooks.length > 0 ? (
        <div className="mb-2">
          <span className="label">Playbooks</span>
          {pack.playbooks.map((pb) => (
            <div key={pb.name} className="text-[10px] text-fg mt-1">
              <span className="text-cyan">{pb.name}</span>{" "}
              <span className="text-dim">{pb.stages.map((s) => s.id).join("→")}{pb.needsProjectDir ? " · needs project_dir" : ""}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[10px] text-dim mb-2">direct-chat pillar — no playbooks/jobs</div>
      )}
      {pack.recentJobs.length > 0 && (
        <div className="mb-2">
          <span className="label">Recent jobs</span>
          {pack.recentJobs.map((j) => (
            <div key={j.id} className="text-[10px] mt-1">
              <span className={j.status === "done" ? "text-phosphor" : j.status === "failed" ? "text-alert" : "text-amber"}>{j.status}</span>{" "}
              <span className="text-fg">{j.title}</span> <span className="text-dim">{j.created_at.slice(5, 16).replace("T", " ")}</span>
            </div>
          ))}
        </div>
      )}
      {pack.workspaces.length > 0 && (
        <div>
          <span className="label">Workspaces</span>
          {pack.workspaces.map((w) => (
            <div key={w.taskDir} className="text-[10px] text-dim mt-1 font-mono">
              {w.taskDir} {w.exists ? "✓" : "✗(removed)"}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

In `ui/src/App.tsx`: add the import (`import { Packs } from "./views/Packs.js";`), add `"Packs"` to the `TABS` array, and render `<Packs events={events} />` when that tab is active (match how the other tabs are conditionally shown — they stay mounted/hidden per the App.tsx comment).

- [ ] **Step 3: Verify (no UI test harness — build + render check)**

Run: `cd ui && npm run build`
Expected: type-checks + builds clean (no TS errors).
Then, with the daemon running (or after deploy): `curl -s localhost:4280/api/packs` returns the `code` + `money` objects; open `:4280`, click **Packs**, confirm both cards render (code shows roles/playbooks/sandbox badge; money shows "direct-chat pillar").

- [ ] **Step 4: Commit**

```bash
git add ui/src/views/Packs.tsx ui/src/api.ts ui/src/App.tsx
git commit -m "feat(packs-view): Packs tab — read-only pillar cards"
```

---

### Task 4: Launch endpoint + Run action

**Files:**
- Modify: `src/web/server.ts` (`POST /api/packs/:pillar/run`)
- Modify: `ui/src/api.ts` (`runPack`)
- Modify: `ui/src/views/Packs.tsx` (Run form per playbook)
- Test: `test/packs-run-endpoint.test.ts`

**Interfaces:**
- Consumes: `jobs.createJob({ playbook, title, request, projectDir, channel, chatId })` (JobManager); `config.projectsRoot`, `config.playbooksDir`.
- Produces: `POST /api/packs/:pillar/run {playbook, project_dir?} → {id}` (400 on bad pillar/playbook/dir). `api.runPack(pillar, playbook, projectDir?)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/packs-run-endpoint.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateRunRequest } from "../src/web/packs-view.js";

function cfg() {
  const root = mkdtempSync(join(tmpdir(), "run-"));
  const codeDir = join(root, "playbooks", "code");
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(join(codeDir, "pack.yaml"),
    `pillar: code\nsandbox: true\npersona: p\nmemoDomain: code\nactions: []\nroles: []\ntools: []\nplaybooks: [code-build, code-analyze]\n`);
  return { playbooksDir: join(root, "playbooks"), projectsRoot: root } as any;
}

describe("validateRunRequest", () => {
  it("accepts a known pillar+playbook with a project_dir under projectsRoot", () => {
    const c = cfg();
    const r = validateRunRequest(c, "code", "code-build", join(c.projectsRoot, "app"));
    expect(r.ok).toBe(true);
  });
  it("rejects an unknown pillar", () => {
    expect(validateRunRequest(cfg(), "nope", "code-build", undefined).ok).toBe(false);
  });
  it("rejects a playbook not in the pillar", () => {
    expect(validateRunRequest(cfg(), "code", "software-feature", undefined).ok).toBe(false);
  });
  it("rejects a project_dir outside projectsRoot", () => {
    expect(validateRunRequest(cfg(), "code", "code-build", "/etc").ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/packs-run-endpoint.test.ts`
Expected: FAIL — `validateRunRequest` not exported.

- [ ] **Step 3: Implement the pure validator + the route**

In `src/web/packs-view.ts`, add (reuses the disk manifest read):
```ts
import { resolve } from "node:path";

export interface RunValidation { ok: boolean; error?: string; projectDir?: string; }

/** Validate a pack-run request against the on-disk manifest + the projects-root guard. */
export function validateRunRequest(config: Config, pillar: string, playbook: string, projectDir?: string): RunValidation {
  const manifestPath = join(config.playbooksDir, pillar, "pack.yaml");
  if (!existsSync(manifestPath)) return { ok: false, error: `unknown pillar: ${pillar}` };
  let pack: ReturnType<typeof packSchema.parse>;
  try { pack = packSchema.parse(parseYaml(readFileSync(manifestPath, "utf8"))); }
  catch (e) { return { ok: false, error: `bad manifest: ${(e as Error).message}` }; }
  if (!pack.playbooks.includes(playbook)) return { ok: false, error: `playbook ${playbook} not in pillar ${pillar}` };
  if (projectDir) {
    const dir = resolve(projectDir);
    if (!dir.startsWith(config.projectsRoot)) return { ok: false, error: `project_dir must be under ${config.projectsRoot}` };
    return { ok: true, projectDir: dir };
  }
  return { ok: true };
}
```
In `src/web/server.ts`, add the route (and `import { buildPacksView, validateRunRequest } from "./packs-view.js";`):
```ts
        const runMatch = /^\/api\/packs\/([\w-]+)\/run$/.exec(path);
        if (runMatch && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { playbook?: string; project_dir?: string };
          if (!body.playbook) return json(res, 400, { error: "playbook required" });
          const v = validateRunRequest(config, runMatch[1], body.playbook, body.project_dir);
          if (!v.ok) return json(res, 400, { error: v.error });
          const job = jobs.createJob({
            playbook: body.playbook,
            title: `${body.playbook}: ${v.projectDir ?? "new workspace"}`,
            request: `Run ${body.playbook} from the Packs view${v.projectDir ? ` on ${v.projectDir}` : ""}.`,
            projectDir: v.projectDir,
            channel: "web", chatId: "packs-view",
          });
          return json(res, 200, { id: job.id });
        }
```

- [ ] **Step 4: Run test + type-check**

Run: `npx vitest run test/packs-run-endpoint.test.ts && npx tsc --noEmit`
Expected: PASS + clean tsc.

- [ ] **Step 5: Wire the UI Run form**

In `ui/src/api.ts`:
```ts
  runPack: (pillar: string, playbook: string, projectDir?: string) =>
    request<{ id: string }>(`/api/packs/${pillar}/run`, { method: "POST", body: JSON.stringify({ playbook, project_dir: projectDir }) }),
```
In `ui/src/views/Packs.tsx`, add per-playbook a `[Run]` button that opens an inline form (a `useState` for the open playbook + a `project_dir` input). On submit call `api.runPack(pack.pillar, pb.name, dir || undefined)`; if `pb.needsProjectDir && !dir` block with an inline message; on success show the returned id (e.g. an inline "queued <id>" line). Keep it minimal and within the card.

- [ ] **Step 6: Verify UI + commit**

Run: `cd ui && npm run build` (clean).
```bash
git add src/web/packs-view.ts src/web/server.ts ui/src/api.ts ui/src/views/Packs.tsx test/packs-run-endpoint.test.ts
git commit -m "feat(packs-view): launch endpoint + Run action (validated job create)"
```

---

### Task 5: Enable/disable toggle endpoint + UI

**Files:**
- Modify: `src/web/server.ts` (`POST /api/packs/:pillar/enabled`)
- Modify: `ui/src/api.ts` (`setPackEnabled`)
- Modify: `ui/src/views/Packs.tsx` (toggle button + confirm)
- Test: `test/packs-toggle.test.ts`

**Interfaces:**
- Consumes: the local `updateEnvFile(envPath, key, value)` (server.ts) + `deps.envPath`; the existing restart pattern (`process.exit(0)` after response).
- Produces: a pure `packDisableKey(pillar) → "AIOS_<PILLAR>_DISABLED"` helper (testable); `POST /api/packs/:pillar/enabled {enabled} → {ok, restarting}`. `api.setPackEnabled(pillar, enabled)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/packs-toggle.test.ts
import { describe, it, expect } from "vitest";
import { packDisableKey } from "../src/web/packs-view.js";

describe("packDisableKey", () => {
  it("maps a pillar to its disable env key (matches the boot kill-switch pattern)", () => {
    expect(packDisableKey("code")).toBe("AIOS_CODE_DISABLED");
    expect(packDisableKey("money")).toBe("AIOS_MONEY_DISABLED");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/packs-toggle.test.ts`
Expected: FAIL — `packDisableKey` not exported.

- [ ] **Step 3: Implement helper + route**

In `src/web/packs-view.ts`:
```ts
/** The env var that disables a pillar's pack at boot (consumed by index.ts's kill-switch loop). */
export function packDisableKey(pillar: string): string {
  return `AIOS_${pillar.toUpperCase()}_DISABLED`;
}
```
In `src/web/server.ts` (import `packDisableKey` from `./packs-view.js`), add the route:
```ts
        const enabledMatch = /^\/api\/packs\/([\w-]+)\/enabled$/.exec(path);
        if (enabledMatch && req.method === "POST") {
          const pillar = enabledMatch[1];
          if (!existsSync(join(config.playbooksDir, pillar, "pack.yaml"))) {
            return json(res, 404, { error: `unknown pillar: ${pillar}` });
          }
          const body = JSON.parse(await readBody(req)) as { enabled?: boolean };
          updateEnvFile(deps.envPath, packDisableKey(pillar), body.enabled === false ? "1" : "");
          json(res, 200, { ok: true, restarting: true });
          log(`pack ${pillar} ${body.enabled === false ? "disabled" : "enabled"} from UI — restarting`);
          setTimeout(() => process.exit(0), 300);
          return;
        }
```
> `existsSync` and `join` are already imported in server.ts (used by the playbooks routes). Confirm; add if missing.

- [ ] **Step 4: Run test + type-check**

Run: `npx vitest run test/packs-toggle.test.ts && npx tsc --noEmit`
Expected: PASS + clean tsc.

- [ ] **Step 5: Wire the UI toggle**

In `ui/src/api.ts`:
```ts
  setPackEnabled: (pillar: string, enabled: boolean) =>
    request<{ ok: boolean; restarting: boolean }>(`/api/packs/${pillar}/enabled`, { method: "POST", body: JSON.stringify({ enabled }) }),
```
In `Packs.tsx`, make the enabled/disabled indicator a button: on click, `window.confirm("Toggle <pillar>? This restarts the daemon (~10s).")`; if confirmed call `api.setPackEnabled(pack.pillar, !pack.enabled)`, then show a "restarting…" state and re-poll after a short delay.

- [ ] **Step 6: Verify UI + commit**

Run: `cd ui && npm run build` (clean).
```bash
git add src/web/packs-view.ts src/web/server.ts ui/src/api.ts ui/src/views/Packs.tsx test/packs-toggle.test.ts
git commit -m "feat(packs-view): enable/disable toggle (per-pillar kill-switch + restart)"
```

---

### Task 6: Pillar-scoped playbook file editing

**Files:**
- Modify: `src/web/server.ts` (`GET /api/packs/:pillar/files`, `PUT /api/packs/:pillar/files/:file`)
- Modify: `ui/src/api.ts` (`packFiles`, `savePackFile`)
- Modify: `ui/src/views/Packs.tsx` (Edit YAML expander)
- Test: `test/packs-files.test.ts`

**Note:** the existing `/api/playbooks` GET/PUT is TOP-LEVEL-only (it `readdirSync`s `playbooksDir` for `*.yaml` and validates `playbookSchema`); it cannot read/write a pillar's subdir files (`playbooks/code/code-build.yaml`, `pack.yaml`). This task adds pillar-scoped file endpoints that validate `pack.yaml` with `packSchema` and playbook files with `playbookSchema`, with a path-traversal guard.

**Interfaces:**
- Consumes: `packSchema` (`src/packs/types.js`), `playbookSchema` (`src/engine/playbook.js`), `reloadPacks` (`deps`), `config.playbooksDir`.
- Produces: a pure `validatePackFile(name, yaml) → {ok, error?}` (packSchema for `pack.yaml`, playbookSchema otherwise); `GET /api/packs/:pillar/files → [{file, yaml}]`; `PUT /api/packs/:pillar/files/:file {yaml} → {ok, reloaded}`. `api.packFiles(pillar)`, `api.savePackFile(pillar, file, yaml)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/packs-files.test.ts
import { describe, it, expect } from "vitest";
import { validatePackFile } from "../src/web/packs-view.js";

describe("validatePackFile", () => {
  it("validates pack.yaml with packSchema", () => {
    const ok = validatePackFile("pack.yaml", `pillar: code\npersona: p\nmemoDomain: code\n`);
    expect(ok.ok).toBe(true);
    expect(validatePackFile("pack.yaml", `persona: p\n`).ok).toBe(false); // missing pillar
  });
  it("validates a playbook file with playbookSchema", () => {
    const ok = validatePackFile("code-build.yaml",
      `name: code-build\ndescription: d\nstages:\n  - type: single\n    id: x\n    role: developer\n    brief: b\n`);
    expect(ok.ok).toBe(true);
    expect(validatePackFile("code-build.yaml", `name: x\n`).ok).toBe(false); // no stages
  });
  it("rejects a non-yaml or traversal filename", () => {
    expect(validatePackFile("../escape.yaml", `x: 1`).ok).toBe(false);
    expect(validatePackFile("notes.txt", `x: 1`).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/packs-files.test.ts`
Expected: FAIL — `validatePackFile` not exported.

- [ ] **Step 3: Implement validator + routes**

In `src/web/packs-view.ts` (import `playbookSchema` from `../engine/playbook.js`):
```ts
import { playbookSchema } from "../engine/playbook.js";

export interface FileValidation { ok: boolean; error?: string; }

/** Validate a pillar file before write: pack.yaml→packSchema, *.yaml→playbookSchema. Rejects traversal/non-yaml. */
export function validatePackFile(name: string, yaml: string): FileValidation {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return { ok: false, error: "illegal filename" };
  if (!/^[\w.-]+\.ya?ml$/.test(name)) return { ok: false, error: "must be a .yaml file" };
  try {
    const parsed = parseYaml(yaml);
    if (name === "pack.yaml") packSchema.parse(parsed);
    else playbookSchema.parse(parsed);
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
```
In `src/web/server.ts`, add the routes:
```ts
        const filesMatch = /^\/api\/packs\/([\w-]+)\/files$/.exec(path);
        if (filesMatch && req.method === "GET") {
          const dir = join(config.playbooksDir, filesMatch[1]);
          if (!existsSync(join(dir, "pack.yaml"))) return json(res, 404, { error: "unknown pillar" });
          const out = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
            .map((f) => ({ file: f, yaml: readFileSync(join(dir, f), "utf8") }));
          return json(res, 200, out);
        }
        const fileMatch = /^\/api\/packs\/([\w-]+)\/files\/([\w.-]+\.ya?ml)$/.exec(path);
        if (fileMatch && req.method === "PUT") {
          const [, pillar, file] = fileMatch;
          const dir = join(config.playbooksDir, pillar);
          if (!existsSync(join(dir, "pack.yaml"))) return json(res, 404, { error: "unknown pillar" });
          const body = JSON.parse(await readBody(req)) as { yaml: string };
          const v = validatePackFile(file, body.yaml);
          if (!v.ok) return json(res, 400, { error: `invalid ${file}: ${v.error}` });
          writeFileSync(join(dir, file), body.yaml);
          reloadPacks();
          return json(res, 200, { ok: true, reloaded: true });
        }
```
> `readdirSync`/`readFileSync`/`writeFileSync`/`join`/`existsSync` are already imported in server.ts (used by the playbooks/config routes). Confirm; add any missing.

- [ ] **Step 4: Run test + type-check**

Run: `npx vitest run test/packs-files.test.ts && npx tsc --noEmit`
Expected: PASS + clean tsc.

- [ ] **Step 5: Wire the UI editor**

In `ui/src/api.ts`:
```ts
  packFiles: (pillar: string) => request<Array<{ file: string; yaml: string }>>(`/api/packs/${pillar}/files`),
  savePackFile: (pillar: string, file: string, yaml: string) =>
    request<{ ok: boolean; reloaded: boolean }>(`/api/packs/${pillar}/files/${file}`, { method: "PUT", body: JSON.stringify({ yaml }) }),
```
In `Packs.tsx`, add an `[Edit YAML ▾]` toggle on the card that, when expanded, lazy-loads `api.packFiles(pack.pillar)`, shows a `<select>` of files + a `<textarea>` of the chosen file's yaml, and a Save button → `api.savePackFile(...)` then collapses + re-polls. Disable when `!pack.enabled`.

- [ ] **Step 6: Verify UI + commit**

Run: `cd ui && npm run build` (clean).
```bash
git add src/web/packs-view.ts src/web/server.ts ui/src/api.ts ui/src/views/Packs.tsx test/packs-files.test.ts
git commit -m "feat(packs-view): pillar-scoped playbook file editing (packSchema/playbookSchema validated)"
```

---

### Task 7: Full verification + build

**Files:** none (verification only)

- [ ] **Step 1: Backend suite + type-check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green (prior baseline + the new `test/pack-killswitch`, `packs-view`, `packs-run-endpoint`, `packs-toggle`, `packs-files`), tsc clean.

- [ ] **Step 2: Builds**

Run: `npm run build && (cd ui && npm run build)`
Expected: both clean; backend emits `dist/src/web/packs-view.js`.

- [ ] **Step 3: Manual smoke (after deploy or against a running daemon)**

`curl -s localhost:4280/api/packs` → `code` + `money` objects with roles/playbooks/jobs. Open `:4280` → **Packs**: both cards render; `[Run]` on `code-analyze` with a `~/projects/<repo>` dir enqueues a job (appears on Board); the toggle prompts a restart confirm; `[Edit YAML]` loads + saves a pillar file.

- [ ] **Step 4: Commit (if any verification-driven fixes were needed)**

```bash
git add -p   # stage only intended files explicitly
git commit -m "test(packs-view): full-suite + build verification"
```
> If nothing changed, skip the commit.

---

## Self-Review

**Spec coverage:**
- §4.1 `buildPacksView` (disk-sourced, disabled-visible, live signals, missing-role degrade) → Task 2. §4.2 `/api/packs` → T2; `run` → T4; `enabled` → T5; playbook edit → T6 (spec said "reuse `/api/playbooks`" — corrected: that endpoint is top-level-only, so T6 adds pillar-scoped file endpoints; documented in T6's Note). §4.3 generalized kill-switch (`dropPack` + per-pillar env) → T1.
- §5 UI (cards, Run form, toggle+confirm, Edit expander, graceful chat-only + disabled rendering) → T3 (cards) + T4/T5/T6 (actions). §6 safety (validation, token auth, fail-closed) → T1/T4/T5/T6. §7 TDD → each task test-first (backend); UI build-verified. §8 ship (no migration) → T7.

**Placeholder scan:** no TBD/TODO; all code steps show real code. UI wiring steps in T3-T6 describe the interaction precisely with the exact api calls; the React form/expander markup is left to the implementer's judgment within the shown component (acceptable — the data flow + api calls are fully specified, and there's no UI test to satisfy).

**Type consistency:** `PackView` + sub-types identical in T2 (packs-view.ts) and T3 (api.ts); `validateRunRequest`/`validatePackFile`/`packDisableKey` signatures consistent T4/T5/T6; endpoint shapes (`{id}`, `{ok,restarting}`, `{ok,reloaded}`) match between server routes and the api client. `dropPack(reg, pillar)` consistent T1.

**Note on UI testability:** backend logic (builder, validators, kill-switch) is fully unit-tested; the React view is verified by `cd ui && npm run build` (type-check + bundle) plus the T7 manual smoke — consistent with the repo having no UI component-test harness.
