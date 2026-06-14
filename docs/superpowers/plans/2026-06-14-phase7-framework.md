# Phase 7 — Pillar Packs Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pillar-pack framework — load declarative `pack.yaml` manifests, and inject each pack's persona + pillar memory + tool allowlist + scoped MCP server (recall/vault/propose with an action ceiling) into the agents of any playbook the pack owns. Ships with **zero packs**, so behavior is unchanged until the per-pack plans land.

**Architecture:** A loader builds a pack registry (`pillar → Pack`, `playbook → pillar`) from `playbooks/<pillar>/pack.yaml`. The `JobManager` resolves the owning pack for a job's playbook into a runtime `ResolvedPack` bundle (using daemon singletons store/vault/gate) and threads it through the `PlaybookExecutor` into `runSpecialist`, which applies it via a pure `packRunOptions` merge. A scoped MCP server (`aios-pack`) exposes recall + gated vault/propose, with `propose_action`/`vault_write` refusing any action type outside the pack's `actions` ceiling. Packless playbooks and existing `@role` chats are untouched.

**Tech Stack:** TypeScript ESM, `node:sqlite`, `@anthropic-ai/claude-agent-sdk` (subscription auth — never an API key), `yaml`, `zod`, vitest. Zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-14-phase7-pillar-packs-design.md`

---

## File Structure

**New files:**
- `src/packs/types.ts` — `Pack` interface, zod `packSchema`, `PackRegistry` type.
- `src/packs/loader.ts` — `loadPacks(dir)` → `{ playbooks, packs, pillarOf, roleOf }`; merges pack playbooks into the playbook map; skip-on-error.
- `src/packs/server.ts` — `buildPackServer(deps)` scoped MCP server + `withinCeiling(type, actions)` pure helper.
- `src/packs/resolve.ts` — `ResolvedPack` type + `resolvePack(pack, deps)` builder (context block, fq tool names, mcpServers).
- Tests: `test/pack-schema.test.ts`, `test/pack-loader.test.ts`, `test/pack-server.test.ts`, `test/pack-resolve.test.ts`, `test/pack-runner.test.ts`, `test/pack-regression.test.ts`.

**Modified files:**
- `src/memory/memos.ts` — add `memoContextForDomain(store, vault, domain)`.
- `src/agents/runner.ts` — `RunOptions.pack?: ResolvedPack`; pure `packRunOptions(base, pack)`; apply in `runSpecialist`.
- `src/engine/executor.ts` — `ExecutorDeps.pack?: ResolvedPack`; include in `runOpts`.
- `src/engine/jobs.ts` — `JobManagerDeps` gains `resolvePackFor?`; resolve per job, pass to executor; `listPlaybooks` returns pillar.
- `src/moderator/tools.ts` — `list_playbooks` groups by pillar.
- `src/moderator/prompt.ts` — short "Pillars" line.
- `src/agents/direct.ts` — `@role` inherits its pack when the role maps to exactly one.
- `src/index.ts` — use `loadPacks`; pass registry + gate + a `resolvePackFor` closure to `JobManager` and `DirectChats`.

---

## Shared contracts (locked — identical across tasks)

```ts
// src/packs/types.ts
export interface Pack {
  pillar: string;
  persona: string;
  memoDomain: string;
  vaultSection: string;
  tools: string[];     // SDK allowedTools: built-in names + MCP short names (recall/vault_read/vault_write/propose_action)
  actions: string[];   // gated action-type ceiling
  roles: string[];
  playbooks: string[];
}
export interface PackRegistry {
  packs: Map<string, Pack>;       // pillar -> Pack
  pillarOf: Map<string, string>;  // playbook name -> pillar
  roleOf: Map<string, string>;    // role name -> pillar (only when the role is in exactly one pack)
}
```
```ts
// src/packs/resolve.ts
export interface ResolvedPack {
  pillar: string;
  contextBlock: string;                  // persona + pillar memo, appended to the role systemPrompt
  tools: string[];                       // allowedTools incl. fully-qualified mcp__aios-pack__* names
  mcpServers: Record<string, unknown>;   // { "aios-pack": <server> }
}
```

The four MCP tool short names recognized in `tools`: `recall`, `vault_read`, `vault_write`, `propose_action`. Anything else in `tools` is treated as a built-in tool name (passed through verbatim).

---

## Task 1: Pack schema + types

**Files:**
- Create: `src/packs/types.ts`
- Test: `test/pack-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/pack-schema.test.ts
import { describe, it, expect } from "vitest";
import { packSchema } from "../src/packs/types.js";

const valid = {
  pillar: "money",
  persona: "You are the Money specialist.",
  memoDomain: "money",
  vaultSection: "money",
  tools: ["Read", "recall", "vault_write"],
  actions: ["vault.write", "email.draft"],
  roles: ["finance"],
  playbooks: ["subscription-audit"],
};

describe("packSchema", () => {
  it("parses a valid manifest", () => {
    const p = packSchema.parse(valid);
    expect(p.pillar).toBe("money");
    expect(p.tools).toContain("recall");
  });
  it("defaults vaultSection to the pillar and lists to empty", () => {
    const p = packSchema.parse({ pillar: "code", persona: "x", memoDomain: "code" });
    expect(p.vaultSection).toBe("code");
    expect(p.tools).toEqual([]);
    expect(p.actions).toEqual([]);
    expect(p.roles).toEqual([]);
    expect(p.playbooks).toEqual([]);
  });
  it("rejects a manifest missing pillar/persona/memoDomain", () => {
    expect(() => packSchema.parse({ pillar: "x", persona: "y" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pack-schema.test.ts`
Expected: FAIL — cannot find module `types.js`.

- [ ] **Step 3: Implement `src/packs/types.ts`**

```ts
// src/packs/types.ts
import { z } from "zod";

export const packSchema = z.object({
  pillar: z.string().min(1),
  persona: z.string().min(1),
  memoDomain: z.string().min(1),
  vaultSection: z.string().optional(),
  tools: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
  roles: z.array(z.string()).default([]),
  playbooks: z.array(z.string()).default([]),
}).transform((p) => ({ ...p, vaultSection: p.vaultSection ?? p.pillar }));

export type Pack = z.infer<typeof packSchema>;

export interface PackRegistry {
  packs: Map<string, Pack>;
  pillarOf: Map<string, string>;
  roleOf: Map<string, string>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pack-schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/packs/types.ts test/pack-schema.test.ts
git commit -m "feat(packs): pack manifest schema + types"
```

---

## Task 2: Pack loader

**Files:**
- Create: `src/packs/loader.ts`
- Test: `test/pack-loader.test.ts`

Reference (read it): `src/engine/playbook.ts` exposes `loadPlaybook(path): Playbook`, `loadPlaybooks(dir): Map<string, Playbook>` (flat, top-level `.yaml` only), and `playbookSchema`/`Playbook`.

- [ ] **Step 1: Write the failing test**

```ts
// test/pack-loader.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPacks } from "../src/packs/loader.js";

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), "pb-"));
  // flat packless playbook
  writeFileSync(join(root, "echo.yaml"), "name: echo\ndescription: echo\nstages:\n  - { type: single, id: s1, role: researcher }\n");
  // a money pack with one playbook
  mkdirSync(join(root, "money"));
  writeFileSync(join(root, "money", "pack.yaml"),
    "pillar: money\npersona: Money specialist.\nmemoDomain: money\ntools: [Read, recall]\nactions: [vault.write]\nroles: [finance]\nplaybooks: [sub-audit]\n");
  writeFileSync(join(root, "money", "sub-audit.yaml"),
    "name: sub-audit\ndescription: audit subs\nstages:\n  - { type: single, id: s1, role: finance }\n");
  return root;
}

describe("loadPacks", () => {
  it("loads flat + pack playbooks into one map and builds the registry", () => {
    const root = scaffold();
    const { playbooks, packs, pillarOf, roleOf } = loadPacks(root);
    expect([...playbooks.keys()].sort()).toEqual(["echo", "sub-audit"]);
    expect(packs.get("money")?.persona).toContain("Money");
    expect(pillarOf.get("sub-audit")).toBe("money");
    expect(pillarOf.get("echo")).toBeUndefined(); // packless
    expect(roleOf.get("finance")).toBe("money");
    rmSync(root, { recursive: true, force: true });
  });

  it("skips a pack whose manifest references a missing playbook file (logged, not thrown)", () => {
    const root = mkdtempSync(join(tmpdir(), "pb-"));
    mkdirSync(join(root, "bad"));
    writeFileSync(join(root, "bad", "pack.yaml"),
      "pillar: bad\npersona: x\nmemoDomain: bad\nplaybooks: [does-not-exist]\n");
    const logs: string[] = [];
    const { packs } = loadPacks(root, (l) => logs.push(l));
    expect(packs.has("bad")).toBe(false);
    expect(logs.join(" ")).toMatch(/bad/);
    rmSync(root, { recursive: true, force: true });
  });

  it("skips a duplicate pillar (second one logged, first kept)", () => {
    const root = mkdtempSync(join(tmpdir(), "pb-"));
    for (const d of ["a", "b"]) {
      mkdirSync(join(root, d));
      writeFileSync(join(root, d, "pack.yaml"), "pillar: dup\npersona: x\nmemoDomain: dup\n");
    }
    const logs: string[] = [];
    const { packs } = loadPacks(root, (l) => logs.push(l));
    expect(packs.size).toBe(1);
    expect(logs.join(" ")).toMatch(/dup/);
    rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pack-loader.test.ts`
Expected: FAIL — cannot find module `loader.js`.

- [ ] **Step 3: Implement `src/packs/loader.ts`**

```ts
// src/packs/loader.ts
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadPlaybook, type Playbook } from "../engine/playbook.js";
import { packSchema, type Pack, type PackRegistry } from "./types.js";

export interface LoadedPacks extends PackRegistry {
  playbooks: Map<string, Playbook>;
}

/** Scans <dir>: top-level *.yaml = packless playbooks; each subdir with pack.yaml = a pack. */
export function loadPacks(dir: string, log: (line: string) => void = () => {}): LoadedPacks {
  const playbooks = new Map<string, Playbook>();
  const packs = new Map<string, Pack>();
  const pillarOf = new Map<string, string>();
  const roleCount = new Map<string, Set<string>>(); // role -> set of pillars

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      loadPackDir(full, entry, { playbooks, packs, pillarOf, roleCount }, log);
    } else if (entry.endsWith(".yaml") || entry.endsWith(".yml")) {
      try {
        const pb = loadPlaybook(full);
        playbooks.set(pb.name, pb);
      } catch (err) {
        log(`playbook ${entry} skipped: ${(err as Error).message}`);
      }
    }
  }

  // A role maps to a pillar only when it belongs to exactly one pack.
  const roleOf = new Map<string, string>();
  for (const [role, pillars] of roleCount) {
    if (pillars.size === 1) roleOf.set(role, [...pillars][0]);
  }
  return { playbooks, packs, pillarOf, roleOf };
}

function loadPackDir(
  dirPath: string,
  dirName: string,
  acc: { playbooks: Map<string, Playbook>; packs: Map<string, Pack>; pillarOf: Map<string, string>; roleCount: Map<string, Set<string>> },
  log: (line: string) => void,
): void {
  const manifestPath = join(dirPath, "pack.yaml");
  if (!existsSync(manifestPath)) return; // a plain subdir, not a pack
  let pack: Pack;
  try {
    pack = packSchema.parse(parse(readFileSync(manifestPath, "utf8")));
  } catch (err) {
    log(`pack ${dirName} skipped: invalid manifest — ${(err as Error).message}`);
    return;
  }
  if (acc.packs.has(pack.pillar)) {
    log(`pack ${dirName} skipped: duplicate pillar "${pack.pillar}"`);
    return;
  }
  // Load the pack's playbooks; a missing/invalid file fails the whole pack (fail loud).
  const loaded: Playbook[] = [];
  for (const name of pack.playbooks) {
    const pbPath = join(dirPath, `${name}.yaml`);
    if (!existsSync(pbPath)) {
      log(`pack ${dirName} skipped: playbook file missing — ${name}.yaml`);
      return;
    }
    try {
      loaded.push(loadPlaybook(pbPath));
    } catch (err) {
      log(`pack ${dirName} skipped: playbook ${name} invalid — ${(err as Error).message}`);
      return;
    }
  }
  // Commit the pack atomically.
  acc.packs.set(pack.pillar, pack);
  for (const pb of loaded) {
    acc.playbooks.set(pb.name, pb);
    acc.pillarOf.set(pb.name, pack.pillar);
  }
  for (const role of pack.roles) {
    const set = acc.roleCount.get(role) ?? new Set<string>();
    set.add(pack.pillar);
    acc.roleCount.set(role, set);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pack-loader.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/packs/loader.ts test/pack-loader.test.ts
git commit -m "feat(packs): loader — registry + pack playbooks, skip-on-error"
```

---

## Task 3: Pillar-scoped memoContext

**Files:**
- Modify: `src/memory/memos.ts`
- Test: `test/pack-resolve.test.ts` (create now; extended in Task 5)

Reference: `src/memory/memos.ts` already has `memoContext(store, vault)` (moderator-scoped: profile + general + inbox + pending teachings) and `memoRelPath(domain)`. `Store.listUnconsolidatedTeachings(domain?)` exists.

- [ ] **Step 1: Write the failing test** — create `test/pack-resolve.test.ts`

```ts
// test/pack-resolve.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { memoContextForDomain } from "../src/memory/memos.js";

function freshVault() {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const vault = new VaultWriter(root, "AIOS");
  vault.init();
  return { root, vault };
}

describe("memoContextForDomain", () => {
  it("loads profile + the given domain's memo + that domain's pending teachings only", () => {
    const { root, vault } = freshVault();
    const s = new Store(":memory:");
    vault.writeNote("memos/profile.md", "# Profile\nSara is my partner");
    vault.writeNote("memos/money.md", "# Money\napprove invoices under fifty");
    vault.writeNote("memos/inbox.md", "# Inbox\narchive newsletters");
    s.addTeaching({ text: "always CC Sara", domain: "money", kind: "preference" });
    s.addTeaching({ text: "ignore promos", domain: "inbox", kind: "preference" });
    const block = memoContextForDomain(s, vault, "money");
    expect(block).toContain("Sara is my partner");      // profile always
    expect(block).toContain("approve invoices under fifty"); // money memo
    expect(block).toContain("always CC Sara");          // money pending teaching
    expect(block).not.toContain("archive newsletters"); // inbox memo NOT loaded
    expect(block).not.toContain("ignore promos");       // inbox teaching NOT loaded
    rmSync(root, { recursive: true, force: true });
  });
  it("returns '' when nothing relevant exists", () => {
    const { root, vault } = freshVault();
    expect(memoContextForDomain(new Store(":memory:"), vault, "code")).toBe("");
    rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pack-resolve.test.ts`
Expected: FAIL — `memoContextForDomain` is not exported.

- [ ] **Step 3: Add `memoContextForDomain` to `src/memory/memos.ts`**

```ts
/** Pillar-scoped variant of memoContext: profile + one domain's memo + that domain's pending
 *  teachings. Used by pack agents (not the moderator's general/inbox set). */
export function memoContextForDomain(store: Store, vault: VaultWriter, domain: string): string {
  const parts: string[] = [];
  const profile = vault.readNote("memos/profile.md");
  if (profile?.trim()) parts.push(profile.trim());
  const memo = vault.readNote(`memos/${domain}.md`);
  if (memo?.trim()) parts.push(memo.trim());
  const pending = store.listUnconsolidatedTeachings(domain);
  if (pending.length) {
    parts.push("## Pending (not yet distilled)\n" + pending.map((t) => `- ${t.text}`).join("\n"));
  }
  if (!parts.length) return "";
  let block = "## Learned preferences & profile\n\n" + parts.join("\n\n");
  if (block.length > 3000) block = block.slice(0, 3000) + "\n…(more in memos/)";
  return block;
}
```

(`Store` and `VaultWriter` types are already imported in memos.ts.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pack-resolve.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/memory/memos.ts test/pack-resolve.test.ts
git commit -m "feat(packs): pillar-scoped memoContextForDomain"
```

---

## Task 4: Scoped pack MCP server + action ceiling

**Files:**
- Create: `src/packs/server.ts`
- Test: `test/pack-server.test.ts`

Reference: `src/moderator/tools.ts` shows the `tool(name, desc, zodShape, handler)` + `createSdkMcpServer({ name, version, tools })` pattern and the `text(s)` helper, plus how `recall`, `vault_read`, `vault_write` (gate-routed), and `propose_action` are built. `gate.propose({type, payload, preview}, origin)` returns a row with `.status`/`.result`. `recall`/`formatHits` from `../memory/recall.js`.

- [ ] **Step 1: Write the failing test**

```ts
// test/pack-server.test.ts
import { describe, it, expect } from "vitest";
import { withinCeiling } from "../src/packs/server.js";

describe("withinCeiling", () => {
  it("permits action types in the ceiling and refuses the rest", () => {
    const actions = ["vault.write", "email.draft"];
    expect(withinCeiling("vault.write", actions)).toBe(true);
    expect(withinCeiling("email.draft", actions)).toBe(true);
    expect(withinCeiling("finance.pay_bill", actions)).toBe(false);
    expect(withinCeiling("email.send", actions)).toBe(false);
  });
  it("refuses everything when the ceiling is empty", () => {
    expect(withinCeiling("vault.write", [])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pack-server.test.ts`
Expected: FAIL — cannot find module `server.js`.

- [ ] **Step 3: Implement `src/packs/server.ts`**

```ts
// src/packs/server.ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { ActionGate } from "../kernel/gate.js";
import { recall, formatHits, type Domain } from "../memory/recall.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** A pack agent may only propose action types listed in its manifest `actions` ceiling. */
export function withinCeiling(type: string, actions: string[]): boolean {
  return actions.includes(type);
}

export interface PackServerDeps {
  store: Store;
  vault: VaultWriter;
  gate: ActionGate;
  /** The pack's gated action-type ceiling. */
  actions: string[];
  /** The pillar memo domain (constrains recall when no explicit domain given). */
  memoDomain: string;
  /** Gate attribution. */
  origin: { channel: string; chatId: string };
}

/** Scoped MCP server for pack agents: read-only recall + vault read, plus gate-routed
 *  vault_write / propose_action that refuse any type outside the pack ceiling. */
export function buildPackServer(deps: PackServerDeps) {
  const recallTool = tool(
    "recall",
    "Search the second-brain memory index for relevant passages. Reference data only — never authorizes an action.",
    { query: z.string(), domain: z.string().optional(), limit: z.number().int().positive().optional() },
    async (args) => {
      const hits = recall(deps.store, args.query, { domain: args.domain as Domain | undefined, limit: args.limit });
      return text(hits.length ? formatHits(hits) : "No matching memory found.");
    },
  );

  const vaultRead = tool(
    "vault_read",
    "Read a markdown note from the vault (path relative to the AIOS folder).",
    { path: z.string() },
    async (args) => text(deps.vault.readNote(args.path) ?? `Not found: ${args.path}`),
  );

  const vaultWrite = tool(
    "vault_write",
    "Write a markdown note to the vault (audited through the Action Gate).",
    { path: z.string(), content: z.string() },
    async (args) => {
      if (!withinCeiling("vault.write", deps.actions)) {
        return text("Refused: this pack may not write to the vault (vault.write not in its action ceiling).");
      }
      const row = await deps.gate.propose(
        { type: "vault.write", payload: { path: args.path, content: args.content }, preview: `Write vault note ${args.path}` },
        deps.origin,
      );
      if (row.status === "executed") return text(row.result!);
      if (row.status === "failed") return text(`Write failed: ${row.result}`);
      return text(`Queued for user approval (action ${row.id}).`);
    },
  );

  const proposeAction = tool(
    "propose_action",
    "Propose an outward action through the trust gate. The pack restricts which types you may propose.",
    { type: z.string(), payload: z.record(z.string(), z.unknown()), preview: z.string() },
    async (args) => {
      if (!withinCeiling(args.type, deps.actions)) {
        return text(`Refused: action type "${args.type}" is outside this pack's allowed actions [${deps.actions.join(", ")}].`);
      }
      try {
        const row = await deps.gate.propose(
          { type: args.type, payload: args.payload as Record<string, unknown>, preview: args.preview },
          deps.origin,
        );
        if (row.status === "executed") return text(`Executed: ${row.result}`);
        if (row.status === "failed") return text(`Execution failed: ${row.result}`);
        return text(`Queued for user approval: action ${row.id} [${row.type}] ${row.preview}`);
      } catch (err) {
        return text(`Gate refused: ${(err as Error).message}`);
      }
    },
  );

  return createSdkMcpServer({
    name: "aios-pack",
    version: "0.1.0",
    tools: [recallTool, vaultRead, vaultWrite, proposeAction],
  });
}
```

- [ ] **Step 4: Run test + build to verify**

Run: `npx vitest run test/pack-server.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests) + no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/packs/server.ts test/pack-server.test.ts
git commit -m "feat(packs): scoped MCP server with per-pack action ceiling"
```

---

## Task 5: resolvePack builder

**Files:**
- Create: `src/packs/resolve.ts`
- Test: extend `test/pack-resolve.test.ts`

- [ ] **Step 1: Write the failing test** (append to `test/pack-resolve.test.ts`)

```ts
import { resolvePack, MCP_TOOL_NAMES } from "../src/packs/resolve.js";
import { packSchema } from "../src/packs/types.js";
import { Store as S2 } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { ActionGate } from "../src/kernel/gate.js";
import { vaultWriteExecutor } from "../src/kernel/executors.js";

describe("resolvePack", () => {
  it("builds context block, fq tool names, and an mcp server", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    const store = new S2(":memory:");
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    vault.writeNote("memos/money.md", "# Money\napprove under fifty");
    const bus = new EventBus(store);
    const registry = new ExecutorRegistry();
    registry.register(vaultWriteExecutor(vault));
    const gate = new ActionGate({ store, registry, policy: { graduationStreak: 99, graduationAgeDays: 0, alwaysSupervised: new Set() }, bus, expiryMs: 60000 });
    const pack = packSchema.parse({
      pillar: "money", persona: "Money specialist.", memoDomain: "money",
      tools: ["Read", "Grep", "recall", "vault_write"], actions: ["vault.write"], roles: ["finance"], playbooks: [],
    });
    const r = resolvePack(pack, { store, vault, gate, origin: { channel: "cli", chatId: "x" } });
    expect(r.pillar).toBe("money");
    expect(r.contextBlock).toContain("## Pillar: money");
    expect(r.contextBlock).toContain("Money specialist.");
    expect(r.contextBlock).toContain("approve under fifty"); // pillar memo folded in
    // built-ins pass through; MCP tools become fully-qualified
    expect(r.tools).toContain("Read");
    expect(r.tools).toContain("Grep");
    expect(r.tools).toContain("mcp__aios-pack__recall");
    expect(r.tools).toContain("mcp__aios-pack__vault_write");
    expect(r.tools).not.toContain("recall"); // short name replaced
    expect(Object.keys(r.mcpServers)).toEqual(["aios-pack"]);
    expect(MCP_TOOL_NAMES).toContain("propose_action");
    rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pack-resolve.test.ts`
Expected: FAIL — cannot find module `resolve.js`.

- [ ] **Step 3: Implement `src/packs/resolve.ts`**

```ts
// src/packs/resolve.ts
import type { Store } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { ActionGate } from "../kernel/gate.js";
import type { Pack } from "./types.js";
import { buildPackServer } from "./server.js";
import { memoContextForDomain } from "../memory/memos.js";

/** Manifest `tools` entries that map to the scoped pack MCP server (everything else is built-in). */
export const MCP_TOOL_NAMES = ["recall", "vault_read", "vault_write", "propose_action"];
const SERVER_NAME = "aios-pack";

export interface ResolvedPack {
  pillar: string;
  contextBlock: string;
  tools: string[];
  mcpServers: Record<string, unknown>;
}

export interface ResolveDeps {
  store: Store;
  vault: VaultWriter;
  gate: ActionGate;
  origin: { channel: string; chatId: string };
}

export function resolvePack(pack: Pack, deps: ResolveDeps): ResolvedPack {
  const memo = memoContextForDomain(deps.store, deps.vault, pack.memoDomain);
  const contextBlock = [
    `## Pillar: ${pack.pillar}`,
    pack.persona.trim(),
    memo,
  ].filter(Boolean).join("\n\n");

  const tools = pack.tools.map((t) => (MCP_TOOL_NAMES.includes(t) ? `mcp__${SERVER_NAME}__${t}` : t));

  const server = buildPackServer({
    store: deps.store,
    vault: deps.vault,
    gate: deps.gate,
    actions: pack.actions,
    memoDomain: pack.memoDomain,
    origin: deps.origin,
  });

  return { pillar: pack.pillar, contextBlock, tools, mcpServers: { [SERVER_NAME]: server } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pack-resolve.test.ts`
Expected: PASS (3 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add src/packs/resolve.ts test/pack-resolve.test.ts
git commit -m "feat(packs): resolvePack — context block, fq tool names, scoped server"
```

---

## Task 6: runner.ts injection seam

**Files:**
- Modify: `src/agents/runner.ts`
- Test: `test/pack-runner.test.ts`

Reference: `src/agents/runner.ts` — `RunOptions { cwd; additionalDirectories?; model?; signal? }`, `roleQueryOptions(role, { cwd, model }): Options`, and `runSpecialist` builds `query({ prompt, options: { ...roleQueryOptions(...), ... } })`. The SDK `Options` type has `systemPrompt`, `allowedTools`, `mcpServers`.

- [ ] **Step 1: Write the failing test**

```ts
// test/pack-runner.test.ts
import { describe, it, expect } from "vitest";
import { roles } from "../src/agents/roles/index.js";
import { roleQueryOptions } from "../src/agents/runner.js";
import { packRunOptions } from "../src/agents/runner.js";
import type { ResolvedPack } from "../src/packs/resolve.js";

const fakePack: ResolvedPack = {
  pillar: "money",
  contextBlock: "## Pillar: money\nBe numerate.",
  tools: ["Read", "mcp__aios-pack__recall"],
  mcpServers: { "aios-pack": { __fake: true } as never },
};

describe("packRunOptions", () => {
  it("appends the pack context to systemPrompt, replaces allowedTools, adds mcpServers", () => {
    const base = roleQueryOptions(roles.researcher, { cwd: "/tmp" });
    const merged = packRunOptions(base, fakePack);
    expect(String(merged.systemPrompt)).toContain("Be numerate.");
    expect(String(merged.systemPrompt)).toContain(roles.researcher.systemPrompt.slice(0, 20)); // role prompt kept
    expect(merged.allowedTools).toEqual(["Read", "mcp__aios-pack__recall"]);
    expect(Object.keys(merged.mcpServers ?? {})).toContain("aios-pack");
  });
  it("is a pure function (does not mutate base)", () => {
    const base = roleQueryOptions(roles.researcher, { cwd: "/tmp" });
    const beforeTools = [...(base.allowedTools ?? [])];
    packRunOptions(base, fakePack);
    expect(base.allowedTools).toEqual(beforeTools);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pack-runner.test.ts`
Expected: FAIL — `packRunOptions` is not exported.

- [ ] **Step 3: Modify `src/agents/runner.ts`**

Add the import and the `pack` field, the pure merge, and apply it in `runSpecialist`.

At the top, add:
```ts
import type { ResolvedPack } from "../packs/resolve.js";
```
Add `pack` to `RunOptions`:
```ts
export interface RunOptions {
  cwd: string;
  additionalDirectories?: string[];
  model?: string;
  signal?: AbortSignal;
  /** When set, the owning pack's context (persona+memo), tool allowlist, and scoped MCP server. */
  pack?: ResolvedPack;
}
```
Add the pure merge (export it, place after `roleQueryOptions`):
```ts
/** Apply a resolved pack to base SDK options: persona+memo appended to the prompt,
 *  tool allowlist replaced, scoped MCP server added. Pure — returns a new object. */
export function packRunOptions(base: Options, pack: ResolvedPack): Options {
  return {
    ...base,
    systemPrompt: `${base.systemPrompt}\n\n${pack.contextBlock}`,
    allowedTools: pack.tools,
    mcpServers: { ...(base.mcpServers ?? {}), ...(pack.mcpServers as Options["mcpServers"]) },
  };
}
```
In `runSpecialist`, change the `query({ ... })` options construction so the base options are run through `packRunOptions` when a pack is present. Find:
```ts
    const q = query({
      prompt: brief,
      options: {
        ...roleQueryOptions(role, { cwd: opts.cwd, model: opts.model }),
        additionalDirectories: opts.additionalDirectories,
        persistSession: false,
        abortController: abort,
        ...(role.outputSchema
          ? { outputFormat: { type: "json_schema" as const, schema: role.outputSchema } }
          : {}),
      },
    });
```
Replace with:
```ts
    const baseOptions = roleQueryOptions(role, { cwd: opts.cwd, model: opts.model });
    const withPack = opts.pack ? packRunOptions(baseOptions, opts.pack) : baseOptions;
    const q = query({
      prompt: brief,
      options: {
        ...withPack,
        additionalDirectories: opts.additionalDirectories,
        persistSession: false,
        abortController: abort,
        ...(role.outputSchema
          ? { outputFormat: { type: "json_schema" as const, schema: role.outputSchema } }
          : {}),
      },
    });
```

- [ ] **Step 4: Run test + build to verify**

Run: `npx vitest run test/pack-runner.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests) + no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/agents/runner.ts test/pack-runner.test.ts
git commit -m "feat(packs): runner pack-injection seam (packRunOptions)"
```

---

## Task 7: Executor + JobManager threading + zero-regression

**Files:**
- Modify: `src/engine/executor.ts`, `src/engine/jobs.ts`
- Test: `test/pack-regression.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/pack-regression.test.ts
import { describe, it, expect } from "vitest";
import { PlaybookExecutor } from "../src/engine/executor.js";
import type { Playbook } from "../src/engine/playbook.js";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const playbook: Playbook = {
  name: "p", description: "d", needsProjectDir: false,
  stages: [{ type: "single", id: "s1", role: "researcher" }],
};

function harness(pack?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const store = new Store(":memory:");
  const vault = new VaultWriter(root, "AIOS");
  vault.init();
  const seen: Array<Record<string, unknown>> = [];
  const run = async (_role: string, _brief: string, opts: Record<string, unknown>) => {
    seen.push(opts);
    return { text: "ok", costUsd: 0, numTurns: 1 };
  };
  const exec = new PlaybookExecutor({ run: run as never, store, vault, wallTimeMs: 60000, pack: pack as never });
  return { root, store, vault, exec, seen };
}

describe("executor pack threading", () => {
  it("packless job passes NO pack in run opts (zero regression)", async () => {
    const { root, store, exec, seen } = harness(undefined);
    store.insertJob({ id: "j1", slug: "p", title: "P", playbook: "p", request: "do", project_dir: null, channel: "cli", chat_id: "x", status: "queued", error: null });
    await exec.execute(store.getJob("j1")!, playbook, "2026-06-14-p");
    expect(seen[0].pack).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
  it("passes the resolved pack through to every run opts when set", async () => {
    const fakePack = { pillar: "money", contextBlock: "x", tools: [], mcpServers: {} };
    const { root, store, exec, seen } = harness(fakePack);
    store.insertJob({ id: "j2", slug: "p", title: "P", playbook: "p", request: "do", project_dir: null, channel: "cli", chat_id: "x", status: "queued", error: null });
    await exec.execute(store.getJob("j2")!, playbook, "2026-06-14-p2");
    expect(seen[0].pack).toBe(fakePack);
    rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pack-regression.test.ts`
Expected: FAIL — `ExecutorDeps` has no `pack` (tsc/property error or assertion fails).

- [ ] **Step 3: Thread the pack through `src/engine/executor.ts`**

Add `pack` to `ExecutorDeps`:
```ts
export interface ExecutorDeps {
  run: SpecialistRunFn;
  store: Store;
  vault: VaultWriter;
  model?: string;
  wallTimeMs: number;
  log?: (line: string) => void;
  onEvent?: (event: import("../events.js").AiosEvent) => void;
  /** Resolved pack for this job's playbook (undefined for packless playbooks). */
  pack?: import("../packs/resolve.js").ResolvedPack;
}
```
Include it in `runOpts`:
```ts
  private runOpts(ctx: JobContext) {
    return {
      cwd: ctx.job.project_dir ?? process.cwd(),
      model: this.deps.model,
      pack: this.deps.pack,
    };
  }
```

- [ ] **Step 4: Resolve + pass the pack in `src/engine/jobs.ts`**

Add to `JobManagerDeps`:
```ts
  /** Resolve the pack for a playbook, given gate-attribution origin. Undefined for packless. */
  resolvePackFor?: (playbookName: string, origin: { channel: string; chatId: string }) => import("../packs/resolve.js").ResolvedPack | undefined;
```
In `runJob`, build the pack before constructing the executor and pass it in:
```ts
    const pack = this.deps.resolvePackFor?.(job.playbook, { channel: job.channel, chatId: job.chat_id });
    const executor = new PlaybookExecutor({
      run: this.deps.run,
      store,
      vault,
      model: this.deps.model,
      wallTimeMs: this.deps.wallTimeMs,
      log: (l) => log(`[${job.slug}] ${l}`),
      onEvent: this.deps.onEvent,
      pack,
    });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/pack-regression.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests) + no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/executor.ts src/engine/jobs.ts test/pack-regression.test.ts
git commit -m "feat(packs): thread resolved pack through executor + job manager"
```

---

## Task 8: list_playbooks grouping + Pillars prompt line

**Files:**
- Modify: `src/engine/jobs.ts` (listPlaybooks returns pillar), `src/moderator/tools.ts` (group), `src/moderator/prompt.ts` (Pillars line)
- Test: `test/pack-loader.test.ts` (extend — listPlaybooks pillar)

- [ ] **Step 1: Write the failing test** (append to `test/pack-loader.test.ts`)

```ts
import { JobManager } from "../src/engine/jobs.js";

describe("listPlaybooks pillar grouping", () => {
  it("annotates each playbook with its pillar (or undefined when packless)", () => {
    const root = scaffold();
    const { playbooks, pillarOf } = loadPacks(root);
    const jm = new JobManager({
      store: {} as never, vault: {} as never, run: (async () => ({})) as never,
      playbooks, pillarOf, wallTimeMs: 1, maxConcurrent: 1, onComplete: async () => {},
    });
    const list = jm.listPlaybooks();
    expect(list.find((p) => p.name === "sub-audit")?.pillar).toBe("money");
    expect(list.find((p) => p.name === "echo")?.pillar).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pack-loader.test.ts -t "pillar grouping"`
Expected: FAIL — `JobManagerDeps` has no `pillarOf`; `listPlaybooks` has no `pillar`.

- [ ] **Step 3: Add `pillarOf` to JobManager** (`src/engine/jobs.ts`)

Add to `JobManagerDeps`:
```ts
  /** playbook name -> pillar (from the pack loader); packless playbooks are absent. */
  pillarOf?: Map<string, string>;
```
Change `listPlaybooks`:
```ts
  listPlaybooks(): Array<{ name: string; description: string; pillar?: string }> {
    return [...this.deps.playbooks.values()].map((p) => ({
      name: p.name, description: p.description, pillar: this.deps.pillarOf?.get(p.name),
    }));
  }
```

- [ ] **Step 4: Group in `list_playbooks` tool** (`src/moderator/tools.ts`)

Find the `listPlaybooks` tool definition and replace its handler body to group by pillar:
```ts
  const listPlaybooks = tool(
    "list_playbooks",
    "List available playbooks, grouped by pillar.",
    {},
    async () => {
      const byPillar = new Map<string, string[]>();
      for (const p of deps.jobs.listPlaybooks()) {
        const key = p.pillar ?? "general";
        const arr = byPillar.get(key) ?? [];
        arr.push(`${p.name}: ${p.description}`);
        byPillar.set(key, arr);
      }
      const out = [...byPillar.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([pillar, items]) => `## ${pillar}\n${items.map((i) => `- ${i}`).join("\n")}`)
        .join("\n\n");
      return text(out || "No playbooks.");
    },
  );
```

- [ ] **Step 5: Add the Pillars line to the moderator prompt** (`src/moderator/prompt.ts`)

In the `## Available playbooks` area, append after the playbook list a short line (keep it inside the existing template):
```
\nPlaybooks are organized into pillars (money, code, research, lifeops, …). When you run \
a pillar playbook, its specialist automatically gets that pillar's persona, preferences, \
and tools — just pick the right playbook with run_playbook.
```
(Read prompt.ts to place this cleanly after the `${playbooks.map(...)}` block; it is plain prose appended to the template string.)

- [ ] **Step 6: Run test + build**

Run: `npx vitest run test/pack-loader.test.ts && npx tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/engine/jobs.ts src/moderator/tools.ts src/moderator/prompt.ts test/pack-loader.test.ts
git commit -m "feat(packs): list_playbooks grouped by pillar + moderator pillars hint"
```

---

## Task 9: Direct @role pack inheritance

**Files:**
- Modify: `src/agents/direct.ts`
- Test: `test/pack-runner.test.ts` (extend — resolver wiring is small; test the role→pack lookup path)

Reference: `src/agents/direct.ts` — `DirectChats.handle(role, channel, chatId, userText)` calls `resumableTurn({ ..., options: { ...roleQueryOptions(def, { cwd, model }), systemPrompt: roleSystemPrompt(def) + DIRECT_ADDENDUM } })`. `DirectChatsDeps { store, projectsRoot, model?, log? }`.

- [ ] **Step 1: Write the failing test** (append to `test/pack-runner.test.ts`)

```ts
import { DirectChats } from "../src/agents/direct.js";

describe("direct chat pack resolver", () => {
  it("DirectChats accepts an optional resolvePackFor dep without breaking construction", () => {
    const calls: string[] = [];
    const dc = new DirectChats({
      store: {} as never, projectsRoot: "/tmp",
      resolvePackFor: (role) => { calls.push(role); return undefined; },
    });
    expect(dc).toBeTruthy();
    // role->pack lookup is exercised on handle(); here we assert the dep is accepted + typed.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pack-runner.test.ts -t "direct chat pack"`
Expected: FAIL — `DirectChatsDeps` has no `resolvePackFor`.

- [ ] **Step 3: Modify `src/agents/direct.ts`**

Add to `DirectChatsDeps`:
```ts
  /** Resolve a pack for a direct-addressed role (undefined = role has no/ambiguous pack). */
  resolvePackFor?: (role: string, origin: { channel: string; chatId: string }) => import("../packs/resolve.js").ResolvedPack | undefined;
```
In `handle`, after `const def = roles[role]; if (!def) throw ...`, resolve a pack and apply it to the options. Import `packRunOptions`:
```ts
import { roleQueryOptions, roleSystemPrompt, packRunOptions } from "./runner.js";
```
Wait — `roleQueryOptions`/`roleSystemPrompt` already imported. Add `packRunOptions` to that import. Then build options:
```ts
      const pack = this.deps.resolvePackFor?.(role, { channel, chatId });
      const base = {
        ...roleQueryOptions(def, { cwd: this.deps.projectsRoot, model: this.deps.model }),
        systemPrompt: roleSystemPrompt(def) + DIRECT_ADDENDUM,
      };
      const options = pack ? packRunOptions(base, pack) : base;
      return await resumableTurn({
        store: this.deps.store,
        sessionKey: key,
        prompt: userText,
        log: this.deps.log,
        options,
      });
```
(Replace the existing `resumableTurn({...})` call's inline options with the `options` variable built above. Note `packRunOptions` appends the pack context AFTER the DIRECT_ADDENDUM systemPrompt — correct, both are kept.)

- [ ] **Step 4: Run test + build**

Run: `npx vitest run test/pack-runner.test.ts && npx tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/agents/direct.ts test/pack-runner.test.ts
git commit -m "feat(packs): @role direct chats inherit their pack"
```

---

## Task 10: Daemon wiring

**Files:**
- Modify: `src/index.ts`

Reference: READ `src/index.ts`. Find where `loadPlaybooks(config.playbooksDir)` is called and the `JobManager` + `DirectChats` are constructed, and where `store`, `vault`, `gate` are in scope.

- [ ] **Step 1: Swap playbook loading to `loadPacks`**

Add import:
```ts
import { loadPacks } from "./packs/loader.js";
import { resolvePack } from "./packs/resolve.js";
```
Find the line that builds the playbooks map (currently `const playbooks = loadPlaybooks(config.playbooksDir);` or similar) and replace with:
```ts
  const { playbooks, packs, pillarOf, roleOf } = loadPacks(config.playbooksDir, log);
  log(`packs: ${[...packs.keys()].join(", ") || "(none)"}`);
```

- [ ] **Step 2: Build the resolver closures (after `gate`, `store`, `vault`, `packs` exist)**

```ts
  // Resolve a pack for a playbook (used by the JobManager) or a role (direct @role chats).
  const resolvePackFor = (playbookOrRole: string, origin: { channel: string; chatId: string }, byRole = false) => {
    const pillar = byRole ? roleOf.get(playbookOrRole) : pillarOf.get(playbookOrRole);
    if (!pillar) return undefined;
    const pack = packs.get(pillar);
    return pack ? resolvePack(pack, { store, vault, gate, origin }) : undefined;
  };
```

- [ ] **Step 3: Pass the deps to JobManager + DirectChats**

In the `new JobManager({...})` construction add:
```ts
    pillarOf,
    resolvePackFor: (playbook, origin) => resolvePackFor(playbook, origin, false),
```
In the `new DirectChats({...})` construction add:
```ts
    resolvePackFor: (role, origin) => resolvePackFor(role, origin, true),
```
(If `reloadPlaybooks` is wired to a UI endpoint, also update it to call `loadPacks` and refresh `pillarOf`/`packs`/`roleOf`; if that's non-trivial, leave a `// TODO pack reload` and note it — the live reload of packs is not required for this framework to ship.)

- [ ] **Step 4: Build + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests pass. With zero pack directories under `playbooks/`, `packs` is empty and behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(packs): wire pack loader + resolver into the daemon"
```

---

## Task 11: E2E pack run (fake executor) + verification

**Files:**
- Test: `test/pack-e2e.test.ts`

- [ ] **Step 1: Write the E2E test**

```ts
// test/pack-e2e.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPacks } from "../src/packs/loader.js";
import { resolvePack } from "../src/packs/resolve.js";
import { PlaybookExecutor } from "../src/engine/executor.js";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { EventBus } from "../src/events.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { ActionGate } from "../src/kernel/gate.js";
import { vaultWriteExecutor } from "../src/kernel/executors.js";
import { promote, newRecord } from "../src/kernel/trust.js";

describe("pack e2e", () => {
  it("runs a pack playbook with pack context applied, no real side effects", async () => {
    // scaffold a pack dir
    const pbDir = mkdtempSync(join(tmpdir(), "pb-"));
    mkdirSync(join(pbDir, "money"));
    writeFileSync(join(pbDir, "money", "pack.yaml"),
      "pillar: money\npersona: Numerate money specialist.\nmemoDomain: money\ntools: [Read, recall]\nactions: [vault.write]\nroles: [finance]\nplaybooks: [audit]\n");
    writeFileSync(join(pbDir, "money", "audit.yaml"),
      "name: audit\ndescription: audit\nstages:\n  - { type: single, id: s1, role: finance }\n");
    const { playbooks, packs, pillarOf } = loadPacks(pbDir);
    expect(pillarOf.get("audit")).toBe("money");

    const vroot = mkdtempSync(join(tmpdir(), "vault-"));
    const store = new Store(":memory:");
    const vault = new VaultWriter(vroot, "AIOS");
    vault.init();
    vault.writeNote("memos/money.md", "# Money\nbe frugal");
    const bus = new EventBus(store);
    const registry = new ExecutorRegistry();
    registry.register(vaultWriteExecutor(vault));
    store.upsertTrust(promote(newRecord("vault.write", "2026-01-01T00:00:00.000Z"), "2026-01-01T00:00:00.000Z"));
    const gate = new ActionGate({ store, registry, policy: { graduationStreak: 99, graduationAgeDays: 0, alwaysSupervised: new Set() }, bus, expiryMs: 60000 });

    const pack = resolvePack(packs.get("money")!, { store, vault, gate, origin: { channel: "cli", chatId: "x" } });
    let capturedPrompt = "";
    const run = async (_role: string, brief: string, opts: Record<string, unknown>) => {
      capturedPrompt = String((opts.pack as { contextBlock: string }).contextBlock);
      return { text: "audit complete", costUsd: 0, numTurns: 1 };
    };
    const exec = new PlaybookExecutor({ run: run as never, store, vault, wallTimeMs: 60000, pack });
    store.insertJob({ id: "j", slug: "audit", title: "Audit", playbook: "audit", request: "audit my subs", project_dir: null, channel: "cli", chat_id: "x", status: "queued", error: null });
    await exec.execute(store.getJob("j")!, playbooks.get("audit")!, "2026-06-14-audit");

    expect(capturedPrompt).toContain("## Pillar: money");
    expect(capturedPrompt).toContain("be frugal"); // pillar memo reached the agent
    rmSync(pbDir, { recursive: true, force: true });
    rmSync(vroot, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the E2E test + full suite + build**

Run: `npx vitest run test/pack-e2e.test.ts && npx vitest run && npx tsc --noEmit && npm run build`
Expected: PASS; full suite green; build clean.

- [ ] **Step 3: Commit**

```bash
git add test/pack-e2e.test.ts
git commit -m "test(packs): e2e pack playbook run with pack context applied"
```

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch. The framework ships with zero packs — no behavior change — so it is safe to merge ahead of the per-pack plans.

---

## Self-Review notes (for the implementer)

- **Zero regression is the contract:** with no `playbooks/<pillar>/pack.yaml` present, `packs` is empty, `pillarOf`/`roleOf` are empty, `resolvePackFor` returns `undefined`, and every run is exactly today's behavior. The `pack-regression` test pins the packless path.
- **Security:** pack agents reach effects only through the gate; `withinCeiling` refuses any action type outside the manifest `actions` before the gate is even called; tool allowlist is replace (a pack agent can't acquire a tool not in `tools`). `recall` is read-only. No new executor, no apiKey, no new dependency.
- **Subscription auth:** unchanged — pack agents run through `runSpecialist`/`query()` which inherits `CLAUDE_CODE_OAUTH_TOKEN`.
- **One seam:** `packRunOptions` is the single merge point, shared by the pipeline runner and direct chats, so pack security settings cannot diverge between the two paths.
