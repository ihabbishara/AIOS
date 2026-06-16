# Permissions in Mission Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI-OS agent tool-permissions visible and deliberately controllable in Mission Control — a gated, audited per-role override layer on top of code-default allowlists, plus on-screen denial surfacing.

**Architecture:** Code roles stay the default allowlist. A `role_permissions` DB table holds per-(role,tool) overrides; `effectiveAllowedTools(roleName, base, store)` merges them fresh per run at every option-building seam (fail-closed → base on error). Grants/revokes are `permission.grant`/`permission.revoke` Action Gate types that are **always-supervised** — the UI/API only *proposes*; a human approval is the only thing that writes a row. A shared PreToolUse hook emits deduped `tool.denied` events that the Permissions view aggregates.

**Tech Stack:** TypeScript (NodeNext, `.js` import specifiers), Node 23 `node:sqlite` (`DatabaseSync` — NOT better-sqlite3, no FTS5), Claude Agent SDK, Zod, raw `node:http` web server, React 19 + Vite 6 + Tailwind v4 UI. Tests: vitest (`new Store(":memory:")` per test). Subscription auth only.

**Key files (created / modified):**
- Create: `src/agents/permissions.ts` — `effectiveAllowedTools`, `withEffectiveTools`, `withDenialObserver` (pure, testable).
- Create: `src/web/permissions-view.ts` — `buildPermissionsView` + `permissionRoleCatalog` (pure aggregation for the API).
- Create: `ui/src/views/Permissions.tsx`.
- Create tests: `test/role-permissions-store.test.ts`, `test/effective-allowed-tools.test.ts`, `test/executor-context.test.ts`, `test/permission-executors.test.ts`, `test/permission-gate.test.ts`, `test/denial-observer.test.ts`, `test/permissions-view.test.ts`, `test/permission-propose.test.ts`.
- Modify: `src/store/db.ts` (table + CRUD), `src/kernel/actions.ts` (`ExecutorContext`), `src/kernel/gate.ts` (`authoredPreview` + pass ctx), `src/kernel/executors.ts` (two executors), `src/kernel/trust.ts` (`DEFAULT_POLICY`), `src/config.ts` (`alwaysSupervised`), `src/events.ts` (two event variants), `src/index.ts` (register executors + factory wiring + bus into deps), `src/agents/runner.ts` (`makeRunSpecialist`), `src/agents/direct.ts` (merge + bus), `src/moderator/session.ts` (merge + export base + bus), `src/finance/agent.ts` (merge + export base + bus), `src/web/server.ts` (two routes), `scripts/smoke.ts` (factory), `ui/src/App.tsx`, `ui/src/api.ts`.

**Build/deploy after merge:** `npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios`

---

## Stage 1 — Secure backend core

Shippable headless. With zero override rows, every role's effective allowlist equals its code default → zero regression.

### Task 1: `role_permissions` table + Store CRUD

**Files:**
- Modify: `src/store/db.ts` (row interface near the other `*Row` interfaces ~`:33-50`; `CREATE TABLE` in the constructor next to `personal_transactions` ~`:222`; methods near `upsertTrust` ~`:393`)
- Test: `test/role-permissions-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/role-permissions-store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

describe("role_permissions store", () => {
  it("grants a tool (allow=1) and reads it back with granted_by", () => {
    const s = new Store(":memory:");
    s.setRolePermission("finance", "Bash", 1, "ihab");
    const rows = s.listRolePermissions("finance");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "finance", tool: "Bash", allow: 1, granted_by: "ihab" });
    expect(typeof rows[0].created_at).toBe("string");
  });

  it("upserts on (role, tool) — re-setting flips the allow flag, no duplicate row", () => {
    const s = new Store(":memory:");
    s.setRolePermission("finance", "Bash", 1, "ihab");
    s.setRolePermission("finance", "Bash", 0, "ops");
    const rows = s.listRolePermissions("finance");
    expect(rows).toHaveLength(1);
    expect(rows[0].allow).toBe(0);
    expect(rows[0].granted_by).toBe("ops");
  });

  it("listRolePermissions() with no arg returns every row; filtered returns one role's", () => {
    const s = new Store(":memory:");
    s.setRolePermission("finance", "Bash", 1, "ihab");
    s.setRolePermission("halalo", "Write", 0, "ihab");
    expect(s.listRolePermissions()).toHaveLength(2);
    expect(s.listRolePermissions("halalo")).toHaveLength(1);
    expect(s.listRolePermissions("halalo")[0].tool).toBe("Write");
  });

  it("same tool under different roles are distinct rows", () => {
    const s = new Store(":memory:");
    s.setRolePermission("finance", "Bash", 1, "ihab");
    s.setRolePermission("developer", "Bash", 1, "ihab");
    expect(s.listRolePermissions().length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/role-permissions-store.test.ts`
Expected: FAIL — `store.setRolePermission is not a function`.

- [ ] **Step 3: Add the row interface**

In `src/store/db.ts`, alongside the other `*Row` interfaces (e.g. just after `TriageRuleRow` ~`:50`), add:

```ts
export interface RolePermissionRow {
  id: number;
  role: string;
  tool: string;
  /** 1 = grant (add to allowlist), 0 = revoke (remove a code default). */
  allow: number;
  /** Gate verdict_by — the human who approved the grant/revoke. */
  granted_by: string;
  created_at: string;
}
```

- [ ] **Step 4: Add the CREATE TABLE**

In the `Store` constructor, next to the `personal_transactions` block (~`:222-239`), add:

```ts
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        tool TEXT NOT NULL,
        allow INTEGER NOT NULL,
        granted_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(role, tool)
      );
    `);
```

- [ ] **Step 5: Add the CRUD methods**

Near `upsertTrust` (~`:393-407`), add to the `Store` class:

```ts
  /** Upsert a per-role tool override. allow=1 grants, allow=0 revokes a default. Keyed on (role, tool). */
  setRolePermission(role: string, tool: string, allow: 0 | 1, grantedBy: string): void {
    this.db
      .prepare(
        `INSERT INTO role_permissions (role, tool, allow, granted_by, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(role, tool) DO UPDATE SET
           allow=excluded.allow, granted_by=excluded.granted_by, created_at=excluded.created_at`,
      )
      .run(role, tool, allow, grantedBy, new Date().toISOString());
  }

  /** All overrides, or just one role's. Ordered for stable output. */
  listRolePermissions(role?: string): RolePermissionRow[] {
    const rows = role
      ? this.db.prepare("SELECT * FROM role_permissions WHERE role = ? ORDER BY tool").all(role)
      : this.db.prepare("SELECT * FROM role_permissions ORDER BY role, tool").all();
    return rows as unknown as RolePermissionRow[];
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/role-permissions-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/store/db.ts test/role-permissions-store.test.ts
git commit -m "feat(permissions): role_permissions table + Store CRUD"
```

---

### Task 2: `effectiveAllowedTools` + `withEffectiveTools` (pure)

**Files:**
- Create: `src/agents/permissions.ts`
- Test: `test/effective-allowed-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/effective-allowed-tools.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { effectiveAllowedTools, withEffectiveTools } from "../src/agents/permissions.js";
import type { RolePermissionRow } from "../src/store/db.js";

function fakeStore(rows: RolePermissionRow[]) {
  return {
    listRolePermissions(role?: string): RolePermissionRow[] {
      return role ? rows.filter((r) => r.role === role) : rows;
    },
  };
}
function override(role: string, tool: string, allow: 0 | 1): RolePermissionRow {
  return { id: 1, role, tool, allow, granted_by: "ihab", created_at: "2026-06-16T00:00:00.000Z" };
}

describe("effectiveAllowedTools", () => {
  it("with zero overrides returns the base unchanged (zero regression)", () => {
    const base = ["Read", "Grep", "Glob"];
    expect(effectiveAllowedTools("researcher", base, fakeStore([]))).toEqual(base);
  });

  it("adds granted tools (allow=1) not already in base", () => {
    const out = effectiveAllowedTools("finance", ["Read"], fakeStore([override("finance", "Bash", 1)]));
    expect(out).toContain("Read");
    expect(out).toContain("Bash");
  });

  it("removes revoked tools (allow=0) that were defaults", () => {
    const out = effectiveAllowedTools("halalo", ["Read", "Write"], fakeStore([override("halalo", "Write", 0)]));
    expect(out).toContain("Read");
    expect(out).not.toContain("Write");
  });

  it("does not double-add a granted tool already in base (dedup)", () => {
    const out = effectiveAllowedTools("finance", ["Read", "Bash"], fakeStore([override("finance", "Bash", 1)]));
    expect(out.filter((t) => t === "Bash")).toHaveLength(1);
  });

  it("only applies the named role's overrides", () => {
    const rows = [override("developer", "Bash", 1)];
    expect(effectiveAllowedTools("finance", ["Read"], fakeStore(rows))).toEqual(["Read"]);
  });

  it("FAIL-CLOSED: a store read error returns the base, never wider", () => {
    const throwing = { listRolePermissions() { throw new Error("db down"); } };
    const base = ["Read", "Grep"];
    expect(effectiveAllowedTools("finance", base, throwing)).toEqual(base);
  });

  it("withEffectiveTools merges into an Options-shaped object's allowedTools", () => {
    const opts = { allowedTools: ["Read"], permissionMode: "dontAsk" as const };
    const out = withEffectiveTools(opts, "finance", fakeStore([override("finance", "Bash", 1)]));
    expect(out.allowedTools).toContain("Bash");
    expect(out.permissionMode).toBe("dontAsk");
    expect(opts.allowedTools).toEqual(["Read"]); // input not mutated
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/effective-allowed-tools.test.ts`
Expected: FAIL — cannot find module `../src/agents/permissions.js`.

- [ ] **Step 3: Write the implementation**

Create `src/agents/permissions.ts`:

```ts
import type { RolePermissionRow } from "../store/db.js";

/** Minimal store surface this module needs — keeps the helpers pure and easy to fake in tests. */
export interface PermissionStore {
  listRolePermissions(role?: string): RolePermissionRow[];
}

/**
 * Effective tool allowlist for a role = (base ∪ {allow=1}) \ {allow=0}, read fresh per run.
 * Fail-closed: any error reading overrides returns the code-default `base` — an error can
 * only narrow toward the default, never widen.
 */
export function effectiveAllowedTools(roleName: string, base: string[], store: PermissionStore): string[] {
  let rows: RolePermissionRow[];
  try {
    rows = store.listRolePermissions(roleName);
  } catch {
    return base;
  }
  const set = new Set(base);
  for (const r of rows) {
    if (r.allow === 1) set.add(r.tool);
    else set.delete(r.tool);
  }
  return [...set];
}

/** Returns a shallow copy of `options` with allowedTools replaced by the effective set. */
export function withEffectiveTools<T extends { allowedTools?: string[] }>(
  options: T,
  roleName: string,
  store: PermissionStore,
): T {
  return { ...options, allowedTools: effectiveAllowedTools(roleName, options.allowedTools ?? [], store) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/effective-allowed-tools.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agents/permissions.ts test/effective-allowed-tools.test.ts
git commit -m "feat(permissions): effectiveAllowedTools + withEffectiveTools (fail-closed)"
```

---

### Task 3: Widen `Executor.execute` with an approver context

The gate must hand the approver identity to the executor so `granted_by` can be recorded. Adding an optional second param is backward-compatible — existing executors declared `async execute(payload)` still satisfy the wider type.

**Files:**
- Modify: `src/kernel/actions.ts:35-41` (interface)
- Modify: `src/kernel/gate.ts:155-172` (`runExecutor` — pass ctx)
- Test: `test/executor-context.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/executor-context.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry, type Executor, type ExecutorContext } from "../src/kernel/actions.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";

describe("executor context", () => {
  it("passes the approver (verdict_by) to the executor as ctx.by on approval", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const registry = new ExecutorRegistry();
    let seen: ExecutorContext | undefined;
    const probe: Executor = {
      type: "test.ctxprobe",
      schema: z.object({ x: z.string() }),
      async execute(_payload, ctx) {
        seen = ctx;
        return "ok";
      },
    };
    registry.register(probe);
    const gate = new ActionGate({ store, registry, policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });

    const row = await gate.propose({ type: "test.ctxprobe", payload: { x: "hi" }, preview: "probe" }, { channel: "cli", chatId: "local" });
    await gate.resolve(row.id, "approve", { by: "ihab" });

    expect(seen).toEqual({ by: "ihab", auto: false });
  });
});
```

> Note: confirm the `ActionGate` constructor shape (`{ store, registry, policy, bus, expiryMs }`) against `src/kernel/gate.ts` and adjust the deps object if the real field names differ — the gate body references `this.deps.{store,registry,policy,bus,expiryMs}`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/executor-context.test.ts`
Expected: FAIL — `ExecutorContext` is not exported / `ctx` is `undefined`.

- [ ] **Step 3: Widen the interface**

In `src/kernel/actions.ts`, replace the `Executor` interface (`:35-41`) with:

```ts
/** Context handed to an executor at run time. `by` is the approver (verdict_by); null for autonomous runs. */
export interface ExecutorContext {
  by: string | null;
  auto: boolean;
}

export interface Executor {
  type: string;
  /** Validates the payload at propose() time — invalid payloads never enter the queue. */
  schema: z.ZodTypeAny;
  /** Performs the outward effect. Returns a short result summary for audit/chat. */
  execute(payload: unknown, ctx: ExecutorContext): Promise<string>;
}
```

- [ ] **Step 4: Pass the context from the gate**

In `src/kernel/gate.ts`, inside `runExecutor` (~`:161`), change:

```ts
      result = await executor.execute(JSON.parse(row.payload));
```

to:

```ts
      result = await executor.execute(JSON.parse(row.payload), { by: verdictBy, auto });
```

(`verdictBy` and `auto` are already the params of `runExecutor(row, auto, verdictBy)`.)

- [ ] **Step 5: Run test + full suite to verify backward-compat**

Run: `npx vitest run test/executor-context.test.ts`
Expected: PASS.
Run: `npx vitest run`
Expected: PASS — existing executors (`vault.write`, `test.echo`, `trust.promote`, `email.*`) still compile and pass (they ignore the new arg).

- [ ] **Step 6: Commit**

```bash
git add src/kernel/actions.ts src/kernel/gate.ts test/executor-context.test.ts
git commit -m "feat(kernel): hand approver context to executors (ExecutorContext)"
```

---

### Task 4: `permission.grant` / `permission.revoke` executors + events + registration

**Files:**
- Modify: `src/events.ts:4-22` (add event variant)
- Modify: `src/kernel/executors.ts` (add two factories after `trustPromoteExecutor` ~`:49`)
- Modify: `src/index.ts:20` (import) and `:78-81` (register)
- Test: `test/permission-executors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/permission-executors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { permissionGrantExecutor, permissionRevokeExecutor } from "../src/kernel/executors.js";

describe("permission executors", () => {
  it("grant writes an allow=1 row stamped with ctx.by and emits permission.changed", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const seen: unknown[] = [];
    bus.on((e) => seen.push(e.event));
    const ex = permissionGrantExecutor(store, bus);
    const result = await ex.execute({ role: "finance", tool: "Bash" }, { by: "ihab", auto: false });

    expect(result).toBe("Granted Bash to finance");
    const rows = store.listRolePermissions("finance");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "Bash", allow: 1, granted_by: "ihab" });
    expect(seen).toContainEqual({ type: "permission.changed", role: "finance", tool: "Bash", allow: true, by: "ihab" });
  });

  it("revoke writes an allow=0 row", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const ex = permissionRevokeExecutor(store, bus);
    await ex.execute({ role: "halalo", tool: "Write" }, { by: "ops", auto: false });
    expect(store.listRolePermissions("halalo")[0]).toMatchObject({ tool: "Write", allow: 0, granted_by: "ops" });
  });

  it("a null approver falls back to 'unknown'", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    await permissionGrantExecutor(store, bus).execute({ role: "finance", tool: "Bash" }, { by: null, auto: true });
    expect(store.listRolePermissions("finance")[0].granted_by).toBe("unknown");
  });
});
```

> Confirm the EventBus subscribe method name. The codebase emits via `bus.emit` and exposes listeners through `this.emitter.listeners("event")` (`src/events.ts:38-48`). If there is no public `on(...)`, subscribe with `bus["emitter"].on("event", (e) => seen.push(e.event))` or read `bus.history(0, 100)` after the call instead. Adjust the test's subscription line to whatever the public API is — assert the same payload either way.

- [ ] **Step 2: Add the event variant**

In `src/events.ts`, add to the `AiosEvent` union (`:4-22`):

```ts
  | { type: "permission.changed"; role: string; tool: string; allow: boolean; by: string }
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/permission-executors.test.ts`
Expected: FAIL — `permissionGrantExecutor` is not exported.

- [ ] **Step 4: Write the executors**

In `src/kernel/executors.ts`, after `trustPromoteExecutor` (~`:49`), add (mirrors `trustPromoteExecutor`'s `(store, bus)` injection):

```ts
/** Approving a permission.grant action is the ONLY thing that writes a grant — the gate never auto-applies. */
export function permissionGrantExecutor(store: Store, bus: EventBus): Executor {
  return {
    type: "permission.grant",
    schema: z.object({ role: z.string(), tool: z.string() }),
    async execute(payload, ctx) {
      const p = payload as { role: string; tool: string };
      const by = ctx.by ?? "unknown";
      store.setRolePermission(p.role, p.tool, 1, by);
      bus.emit({ type: "permission.changed", role: p.role, tool: p.tool, allow: true, by });
      return `Granted ${p.tool} to ${p.role}`;
    },
  };
}

export function permissionRevokeExecutor(store: Store, bus: EventBus): Executor {
  return {
    type: "permission.revoke",
    schema: z.object({ role: z.string(), tool: z.string() }),
    async execute(payload, ctx) {
      const p = payload as { role: string; tool: string };
      const by = ctx.by ?? "unknown";
      store.setRolePermission(p.role, p.tool, 0, by);
      bus.emit({ type: "permission.changed", role: p.role, tool: p.tool, allow: false, by });
      return `Revoked ${p.tool} from ${p.role}`;
    },
  };
}
```

- [ ] **Step 5: Register them**

In `src/index.ts`, extend the import (`:20`):

```ts
import {
  vaultWriteExecutor,
  echoExecutor,
  trustPromoteExecutor,
  permissionGrantExecutor,
  permissionRevokeExecutor,
} from "./kernel/executors.js";
```

and after `registry.register(trustPromoteExecutor(store, bus));` (~`:81`):

```ts
  registry.register(permissionGrantExecutor(store, bus));
  registry.register(permissionRevokeExecutor(store, bus));
```

- [ ] **Step 6: Run test + build**

Run: `npx vitest run test/permission-executors.test.ts`
Expected: PASS (3 tests).
Run: `npm run build`
Expected: clean tsc build.

- [ ] **Step 7: Commit**

```bash
git add src/events.ts src/kernel/executors.ts src/index.ts test/permission-executors.test.ts
git commit -m "feat(permissions): permission.grant/revoke executors + permission.changed event"
```

---

### Task 5: Gate-authored previews + always-supervised

Make the gate author the preview from the payload (caller text ignored, anti-forgery) and pin both types into the always-supervised ceiling so they can never graduate to autonomous.

**Files:**
- Modify: `src/kernel/gate.ts:84-103` (`authoredPreview`)
- Modify: `src/config.ts:154-164` (runtime `alwaysSupervised`)
- Modify: `src/kernel/trust.ts:26-30` (`DEFAULT_POLICY` — for the test/standalone path)
- Test: `test/permission-gate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/permission-gate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { permissionGrantExecutor, permissionRevokeExecutor } from "../src/kernel/executors.js";
import { DEFAULT_POLICY, newRecord, promote } from "../src/kernel/trust.js";

function wire() {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const registry = new ExecutorRegistry();
  registry.register(permissionGrantExecutor(store, bus));
  registry.register(permissionRevokeExecutor(store, bus));
  const gate = new ActionGate({ store, registry, policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
  return { store, bus, gate };
}

describe("permission gate", () => {
  it("gate authors the preview from the payload, ignoring caller text", async () => {
    const { gate } = wire();
    const row = await gate.propose(
      { type: "permission.grant", payload: { role: "finance", tool: "Bash" }, preview: "totally innocent" },
      { channel: "web", chatId: "mission-control" },
    );
    expect(row.preview).toBe("Grant Bash to finance");
    expect(row.status).toBe("proposed");
  });

  it("revoke authors its own preview", async () => {
    const { gate } = wire();
    const row = await gate.propose(
      { type: "permission.revoke", payload: { role: "halalo", tool: "Write" }, preview: "x" },
      { channel: "web", chatId: "mission-control" },
    );
    expect(row.preview).toBe("Revoke Write from halalo");
  });

  it("is always-supervised: never executes autonomously even if the trust record is seeded autonomous", async () => {
    const { store, gate } = wire();
    store.upsertTrust(promote(newRecord("permission.grant", "2026-06-16T00:00:00.000Z"), "2026-06-16T00:00:00.000Z"));
    const row = await gate.propose(
      { type: "permission.grant", payload: { role: "finance", tool: "Bash" }, preview: "x" },
      { channel: "web", chatId: "mission-control" },
    );
    expect(row.status).toBe("proposed"); // queued, NOT executed
    expect(store.listRolePermissions("finance")).toHaveLength(0); // nothing written pre-approval
  });

  it("approval applies the grant with granted_by = approver", async () => {
    const { store, gate } = wire();
    const row = await gate.propose(
      { type: "permission.grant", payload: { role: "finance", tool: "Bash" }, preview: "x" },
      { channel: "web", chatId: "mission-control" },
    );
    await gate.resolve(row.id, "approve", { by: "ihab" });
    expect(store.listRolePermissions("finance")[0]).toMatchObject({ tool: "Bash", allow: 1, granted_by: "ihab" });
  });
});
```

> The third test relies on `DEFAULT_POLICY.alwaysSupervised` containing `permission.grant` (Step 4). Confirm `promote`/`newRecord` are exported from `trust.ts` (the kernel report shows `newRecord` and `promote` exist); if `promote` requires a `graduating` state, seed via `newRecord` then `upsertTrust({ ...rec, state: "autonomous" })` instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/permission-gate.test.ts`
Expected: FAIL — preview is the caller text / action auto-executes.

- [ ] **Step 3: Add the authored-preview cases**

In `src/kernel/gate.ts`, inside the `authoredPreview` switch (~`:87-101`), before the closing `}` of the switch, add:

```ts
      case "permission.grant":
        return `Grant ${String(p.tool)} to ${String(p.role)}`;
      case "permission.revoke":
        return `Revoke ${String(p.tool)} from ${String(p.role)}`;
```

- [ ] **Step 4: Add both types to the always-supervised ceiling**

In `src/config.ts`, in the `alwaysSupervised` set (`:158-162`):

```ts
      alwaysSupervised: new Set([
        "trust.promote",
        "permission.grant",
        "permission.revoke",
        ...(process.env.AIOS_ALWAYS_SUPERVISED ?? "")
          .split(",").map((s) => s.trim()).filter(Boolean),
      ]),
```

And in `src/kernel/trust.ts`, `DEFAULT_POLICY` (`:29`):

```ts
  alwaysSupervised: new Set(["trust.promote", "permission.grant", "permission.revoke"]),
```

- [ ] **Step 5: Run test + build**

Run: `npx vitest run test/permission-gate.test.ts`
Expected: PASS (4 tests).
Run: `npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/kernel/gate.ts src/config.ts src/kernel/trust.ts test/permission-gate.test.ts
git commit -m "feat(permissions): gate-authored previews + always-supervised permission types"
```

---

### Task 6: Runtime merge at all four option seams

Apply `withEffectiveTools` fresh per run at: (a) the specialist factory (covers pipeline runs + packs), (b) DirectChats, (c) the moderator pseudo-role, (d) FinanceAgent. Export the moderator/finance base allowlists as single sources of truth (the API in Stage 3 reuses them).

**Files:**
- Modify: `src/agents/runner.ts:79-128` (replace `runSpecialist` const with `makeRunSpecialist` factory)
- Modify: `src/index.ts:8` (import), `:149`, `:165` (wiring)
- Modify: `scripts/smoke.ts:11`, `:30`, `:50`
- Modify: `src/agents/direct.ts:41-54` (merge using `this.deps.store`)
- Modify: `src/moderator/session.ts:13-31` (export base) and `:122` (merge)
- Modify: `src/finance/agent.ts:11-19` (export base) and `:266` (merge)
- Test: extends `test/effective-allowed-tools.test.ts` is enough for the pure merge; this task is verified by build + the zero-regression suite run (no SDK in unit tests).

- [ ] **Step 1: Convert `runSpecialist` to a store-aware factory**

In `src/agents/runner.ts`, add the import at the top:

```ts
import type { Store } from "../store/db.js";
import { withEffectiveTools } from "./permissions.js";
```

Replace the `export const runSpecialist: SpecialistRunFn = async (roleName, brief, opts) => {` declaration (`:85`) and keep the entire existing body, wrapping it in a factory and applying the merge after the pack step. Concretely, change the head to:

```ts
export function makeRunSpecialist(deps: { store: Store }): SpecialistRunFn {
  return async (roleName, brief, opts) => {
    const role = roles[roleName];
    if (!role) throw new Error(`Unknown role: ${roleName}`);

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const baseOptions = roleQueryOptions(role, { cwd: opts.cwd, model: opts.model });
      const withPack = opts.pack ? packRunOptions(baseOptions, opts.pack) : baseOptions;
      const merged = withEffectiveTools(withPack, roleName, deps.store);
      const q = query({
        prompt: brief,
        options: {
          ...merged,
          additionalDirectories: opts.additionalDirectories,
          persistSession: false,
          abortController: abort,
          ...(role.outputSchema
            ? { outputFormat: { type: "json_schema" as const, schema: role.outputSchema } }
            : {}),
        },
      });
      // ... KEEP the existing result-collection loop and return unchanged ...
```

Close the extra function scope: add one more `}` (closing the returned arrow function's `try/finally` is unchanged; the new outer `};` closes the arrow, and `}` closes `makeRunSpecialist`). Verify brace balance with `npm run build`.

> The only substantive change inside the body is the new `const merged = withEffectiveTools(...)` line and using `...merged` instead of `...withPack`. Everything else (the `query(...)` call, the streaming/result loop, the `finally { opts.signal?.removeEventListener("abort", onAbort); }`) is copied verbatim from the current `runSpecialist`.

- [ ] **Step 2: Rewire the two consumers in `src/index.ts`**

Change the import (`:8`):

```ts
import { makeRunSpecialist } from "./agents/runner.js";
```

Create one instance after `store` exists (e.g. just before the `JobManager` block ~`:145`):

```ts
  const runSpecialist = makeRunSpecialist({ store });
```

Leave `run: runSpecialist` at `:149` and `:165` unchanged (the local now holds the factory's product).

- [ ] **Step 3: Rewire `scripts/smoke.ts`**

Change `scripts/smoke.ts:11` import to `import { makeRunSpecialist } from "../src/agents/runner.js";`, and after its `store` is created (`smoke.ts:18`), add `const runSpecialist = makeRunSpecialist({ store });`. The `run: runSpecialist` usages at `:30`/`:50` then resolve to the local.

- [ ] **Step 4: Merge in DirectChats**

In `src/agents/direct.ts`, add the import:

```ts
import { withEffectiveTools } from "./permissions.js";
```

In `handle(...)` (~`:44-47`), change:

```ts
      const options = pack ? packRunOptions(base, pack) : base;
```

to:

```ts
      const withPack = pack ? packRunOptions(base, pack) : base;
      const options = withEffectiveTools(withPack, role, this.deps.store);
```

(`role` is the role-name param; `this.deps.store` is in scope.)

- [ ] **Step 5: Merge in the moderator + export its base allowlist**

In `src/moderator/session.ts`, export the base allowlist by changing the moderator option line (`:122`). First add at module scope, after the `MCP_TOOLS` array (~`:31`):

```ts
/** The moderator pseudo-role's code-default allowlist — single source of truth (also read by /api/permissions). */
export const MODERATOR_ALLOWED_TOOLS = [...MCP_TOOLS, "Read", "Grep", "Glob", "WebSearch", "WebFetch"];
```

Add the import:

```ts
import { effectiveAllowedTools } from "../agents/permissions.js";
```

Change `:122` from:

```ts
        allowedTools: [...MCP_TOOLS, "Read", "Grep", "Glob", "WebSearch", "WebFetch"],
```

to:

```ts
        allowedTools: effectiveAllowedTools("moderator", MODERATOR_ALLOWED_TOOLS, store),
```

(`store` is destructured at `:87`.)

- [ ] **Step 6: Merge in FinanceAgent + export its base allowlist**

In `src/finance/agent.ts`, export the constant (`:11`): change `const FINANCE_TOOLS = [` to `export const FINANCE_TOOLS = [`. Add the import:

```ts
import { effectiveAllowedTools } from "../agents/permissions.js";
```

Change `:266` from:

```ts
          allowedTools: FINANCE_TOOLS,
```

to:

```ts
          allowedTools: effectiveAllowedTools("finance", FINANCE_TOOLS, this.deps.store),
```

(`this.deps.store` is in scope — used elsewhere in the file.)

- [ ] **Step 7: Build + full zero-regression suite**

Run: `npm run build`
Expected: clean (brace balance + signatures OK).
Run: `npx vitest run`
Expected: PASS — every existing test (pack-runner, executor, pack-e2e, store-kernel, etc.) unchanged. With no `role_permissions` rows, `effectiveAllowedTools` returns the base verbatim, so the merge is a no-op.

- [ ] **Step 8: Commit**

```bash
git add src/agents/runner.ts src/index.ts scripts/smoke.ts src/agents/direct.ts src/moderator/session.ts src/finance/agent.ts
git commit -m "feat(permissions): apply effectiveAllowedTools at all four agent option seams"
```

---

## Stage 2 — Denial surfacing

A shared PreToolUse hook on every non-sandboxed run emits a deduped `tool.denied{role,tool}` event when the model reaches for a tool outside its effective allowlist. Best-effort observability — the Stage 3 static allowlist is the always-correct fallback. Hook failures are swallowed and never break a run.

### Task 7: `tool.denied` event + `withDenialObserver` (pure)

**Files:**
- Modify: `src/events.ts:4-22` (event variant)
- Modify: `src/agents/permissions.ts` (add `withDenialObserver`)
- Test: `test/denial-observer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/denial-observer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { withDenialObserver } from "../src/agents/permissions.js";

/** Invoke the (single) PreToolUse hook the observer attached, with a tool name. */
async function fire(options: any, toolName: string) {
  const hook = options.hooks.PreToolUse[0].hooks[0];
  return hook({ tool_name: toolName, tool_input: {} });
}

describe("withDenialObserver", () => {
  it("emits tool.denied for a tool outside the allowlist and returns a deny decision", async () => {
    const emitted: Array<{ role: string; tool: string }> = [];
    const opts = withDenialObserver(
      { allowedTools: ["Read"], permissionMode: "dontAsk" },
      "finance",
      (e) => emitted.push(e),
    );
    const res = await fire(opts, "Bash");
    expect(emitted).toEqual([{ role: "finance", tool: "Bash" }]);
    expect(res.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("does NOT emit for an allowed tool, and lets it continue", async () => {
    const emitted: unknown[] = [];
    const opts = withDenialObserver({ allowedTools: ["Read"], permissionMode: "dontAsk" }, "finance", (e) => emitted.push(e));
    const res = await fire(opts, "Read");
    expect(emitted).toEqual([]);
    expect(res).toEqual({ continue: true });
  });

  it("does NOT emit for mcp__ tools (governed by allowedTools, not denials)", async () => {
    const emitted: unknown[] = [];
    const opts = withDenialObserver({ allowedTools: [], permissionMode: "dontAsk" }, "finance", (e) => emitted.push(e));
    await fire(opts, "mcp__finance__add_expense");
    expect(emitted).toEqual([]);
  });

  it("dedupes within a run — the same (role,tool) fires the event only once", async () => {
    const emitted: unknown[] = [];
    const opts = withDenialObserver({ allowedTools: [], permissionMode: "dontAsk" }, "finance", (e) => emitted.push(e));
    await fire(opts, "Bash");
    await fire(opts, "Bash");
    expect(emitted).toHaveLength(1);
  });

  it("bypassPermissions roles get NO observer (nothing is denied in a sandbox) — options returned unchanged", () => {
    const input = { allowedTools: ["Read"], permissionMode: "bypassPermissions" as const };
    expect(withDenialObserver(input, "developer", () => {})).toBe(input);
  });

  it("an emit callback that throws never propagates out of the hook", async () => {
    const opts = withDenialObserver({ allowedTools: [], permissionMode: "dontAsk" }, "finance", () => {
      throw new Error("bus exploded");
    });
    await expect(fire(opts, "Bash")).resolves.toBeTruthy(); // does not reject
  });

  it("preserves an existing PreToolUse hook (appends, does not clobber)", async () => {
    let guardRan = false;
    const input = {
      allowedTools: ["Read"],
      permissionMode: "default" as const,
      hooks: { PreToolUse: [{ hooks: [async () => { guardRan = true; return { continue: true }; }] }] },
    };
    const opts = withDenialObserver(input, "halalo", () => {});
    expect(opts.hooks.PreToolUse).toHaveLength(2); // guard + observer
    await opts.hooks.PreToolUse[0].hooks[0]({ tool_name: "Read", tool_input: {} });
    expect(guardRan).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/denial-observer.test.ts`
Expected: FAIL — `withDenialObserver` is not exported.

- [ ] **Step 3: Add the event variant**

In `src/events.ts`, add to the `AiosEvent` union:

```ts
  | { type: "tool.denied"; role: string; tool: string }
```

- [ ] **Step 4: Write `withDenialObserver`**

Append to `src/agents/permissions.ts`:

```ts
/**
 * Appends a PreToolUse hook that records (and denies) any tool the model reaches for
 * outside `options.allowedTools`. Deduped per run (a looping agent can't flood the log).
 * - mcp__ tools are governed by allowedTools, not surfaced as denials.
 * - bypassPermissions roles are sandboxed write-roles with no concept of denial → no observer.
 * - The emit callback is wrapped in try/catch: a denial-hook failure can never break an agent run.
 * Append-merges so an existing guard PreToolUse hook (e.g. halalo's) is preserved.
 */
export function withDenialObserver<
  T extends { allowedTools?: string[]; permissionMode?: string; hooks?: { PreToolUse?: unknown[] } },
>(options: T, roleName: string, emit: (e: { role: string; tool: string }) => void): T {
  if (options.permissionMode === "bypassPermissions") return options;
  const allowed = new Set(options.allowedTools ?? []);
  const seen = new Set<string>();
  const observer = async (raw: unknown) => {
    const tool = (raw as { tool_name?: string }).tool_name ?? "";
    if (!tool || allowed.has(tool) || tool.startsWith("mcp__")) return { continue: true };
    if (!seen.has(tool)) {
      seen.add(tool);
      try {
        emit({ role: roleName, tool });
      } catch {
        /* a denial-observation failure must never break an agent run */
      }
    }
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: `${tool} is not in ${roleName}'s allowlist`,
      },
    };
  };
  const existing = options.hooks?.PreToolUse ?? [];
  return { ...options, hooks: { ...options.hooks, PreToolUse: [...existing, { hooks: [observer] }] } };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/denial-observer.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/events.ts src/agents/permissions.ts test/denial-observer.test.ts
git commit -m "feat(permissions): tool.denied event + withDenialObserver hook (deduped, fail-safe)"
```

---

### Task 8: Wire the observer into the four seams

Thread an `emit` for `tool.denied` through the same four seams. The factory closes over a `bus`; the three agent classes get a `bus` dep (each already constructed in `index.ts` where `bus` is in scope).

**Files:**
- Modify: `src/agents/runner.ts` (factory takes `bus`, wraps options)
- Modify: `src/index.ts` (`makeRunSpecialist({ store, bus })`; add `bus` to DirectChats/Moderator/Finance wiring)
- Modify: `src/agents/direct.ts` (`bus` dep + wrap)
- Modify: `src/moderator/session.ts` (`bus` dep + wrap)
- Modify: `src/finance/agent.ts` (`bus` dep + wrap)
- Modify: `scripts/smoke.ts` (`makeRunSpecialist({ store, bus })` — smoke already builds a `bus`)

- [ ] **Step 1: Factory wraps with the observer**

In `src/agents/runner.ts`, change the import to include the observer and `EventBus`:

```ts
import type { EventBus } from "../events.js";
import { withEffectiveTools, withDenialObserver } from "./permissions.js";
```

Widen the factory deps and wrap after the effective-tools merge:

```ts
export function makeRunSpecialist(deps: { store: Store; bus: EventBus }): SpecialistRunFn {
  return async (roleName, brief, opts) => {
    // ... unchanged up to:
      const merged = withEffectiveTools(withPack, roleName, deps.store);
      const observed = withDenialObserver(merged, roleName, (e) => deps.bus.emit({ type: "tool.denied", ...e }));
      const q = query({
        prompt: brief,
        options: {
          ...observed,
          additionalDirectories: opts.additionalDirectories,
          // ... rest unchanged (persistSession, abortController, outputFormat) ...
```

(Use `...observed` instead of `...merged` in the `query` options.)

- [ ] **Step 2: `src/index.ts` wiring**

Change `const runSpecialist = makeRunSpecialist({ store });` to:

```ts
  const runSpecialist = makeRunSpecialist({ store, bus });
```

Add `bus` to the `DirectChats`, `Moderator`, and `FinanceAgent` constructor calls (each is an object literal where `bus` is already a local). For example in the `Moderator` block (`:161-173`) add `bus,`; in the `FinanceAgent` block (`:183-193`) add `bus,`; and wherever `DirectChats` is constructed add `bus,`.

- [ ] **Step 3: DirectChats observer**

In `src/agents/direct.ts`, add `bus: EventBus;` to `DirectChatsDeps` (`:13-20`) and the import `import type { EventBus } from "../events.js";` plus `withDenialObserver` from `./permissions.js`. Change the merge line to wrap:

```ts
      const merged = withEffectiveTools(withPack, role, this.deps.store);
      const options = withDenialObserver(merged, role, (e) => this.deps.bus.emit({ type: "tool.denied", ...e }));
```

- [ ] **Step 4: Moderator observer**

In `src/moderator/session.ts`, add `bus: EventBus;` to `ModeratorDeps` (`:37` area) and import `EventBus` + `withDenialObserver`. The moderator builds its options object inline (`:114-131`); wrap the whole `options` value. Simplest: build the options object into a local first, then pass `withDenialObserver(opts, "moderator", (e) => this.deps.bus.emit({ type: "tool.denied", ...e }))` to `resumableTurn`. Keep `allowedTools: effectiveAllowedTools("moderator", MODERATOR_ALLOWED_TOOLS, store)` as set in Stage 1.

- [ ] **Step 5: FinanceAgent observer**

In `src/finance/agent.ts`, add `bus: EventBus;` to `FinanceAgentDeps` (`:75` area) and import `EventBus` + `withDenialObserver`. Wrap the inline options object (`:263-286`) the same way: build it into a local, then `withDenialObserver(opts, "finance", (e) => this.deps.bus.emit({ type: "tool.denied", ...e }))` into `resumableTurn`. Note finance's existing `guardOptions` Read-confinement hook is preserved by the append-merge.

- [ ] **Step 6: `scripts/smoke.ts`**

Change to `const runSpecialist = makeRunSpecialist({ store, bus });` (smoke already constructs a `bus`; confirm its variable name and pass it).

- [ ] **Step 7: Build + full suite**

Run: `npm run build`
Expected: clean.
Run: `npx vitest run`
Expected: PASS (no regression; observer is additive and no-op when every tool is allowed).

- [ ] **Step 8: Commit**

```bash
git add src/agents/runner.ts src/index.ts src/agents/direct.ts src/moderator/session.ts src/finance/agent.ts scripts/smoke.ts
git commit -m "feat(permissions): emit tool.denied from every agent seam"
```

---

## Stage 3 — UI

`GET /api/permissions`, `POST /api/permissions/propose`, a `Permissions.tsx` view, and a nav entry. The propose endpoint only *proposes* — the gate approval is the authority — so it is safe despite the unauth-localhost API.

### Task 9: Permissions view aggregation (pure) + role catalog

A pure `buildPermissionsView(store)` that the route calls — testable without HTTP.

**Files:**
- Create: `src/web/permissions-view.ts`
- Test: `test/permissions-view.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/permissions-view.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { buildPermissionsView } from "../src/web/permissions-view.js";

describe("buildPermissionsView", () => {
  it("includes every code role plus the moderator and finance pseudo-roles", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const view = buildPermissionsView(store, bus);
    const names = view.map((r) => r.role);
    expect(names).toContain("moderator");
    expect(names).toContain("finance");
    expect(names).toContain("researcher"); // a code role
  });

  it("tags base tools 'default', grants 'granted', and revoked defaults 'revoked'", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    store.setRolePermission("finance", "Bash", 1, "ihab"); // grant a non-default
    store.setRolePermission("finance", "Read", 0, "ihab"); // revoke a default
    const finance = buildPermissionsView(store, bus).find((r) => r.role === "finance")!;
    const byName = Object.fromEntries(finance.tools.map((t) => [t.name, t.source]));
    expect(byName["Bash"]).toBe("granted");
    expect(byName["Read"]).toBeUndefined(); // revoked → not in effective list
    expect(finance.revoked).toContainEqual({ name: "Read", source: "revoked" });
  });

  it("aggregates tool.denied events per role+tool with count and last ts", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    bus.emit({ type: "tool.denied", role: "finance", tool: "Bash" });
    bus.emit({ type: "tool.denied", role: "finance", tool: "Bash" });
    const finance = buildPermissionsView(store, bus).find((r) => r.role === "finance")!;
    const denial = finance.denials.find((d) => d.tool === "Bash")!;
    expect(denial.count).toBe(2);
    expect(typeof denial.lastTs).toBe("string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/permissions-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the aggregation**

Create `src/web/permissions-view.ts`:

```ts
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import { roles } from "../agents/roles/index.js";
import { effectiveAllowedTools } from "../agents/permissions.js";
import { MODERATOR_ALLOWED_TOOLS } from "../moderator/session.js";
import { FINANCE_TOOLS } from "../finance/agent.js";

export interface PermissionTool {
  name: string;
  source: "default" | "granted" | "revoked";
}
export interface PermissionDenial {
  tool: string;
  count: number;
  lastTs: string;
}
export interface PermissionRoleView {
  role: string;
  description: string;
  permissionMode: string;
  toolCheckFallback: string;
  skills: string[];
  /** Effective allowlist — each tool tagged default/granted. */
  tools: PermissionTool[];
  /** Defaults the human revoked (shown struck-through). */
  revoked: PermissionTool[];
  denials: PermissionDenial[];
}

interface CatalogEntry {
  role: string;
  description: string;
  permissionMode: string;
  toolCheckFallback: string;
  skills: string[];
  base: string[];
}

/** Every controllable role: the code registry + the two standalone pseudo-roles. */
export function permissionRoleCatalog(): CatalogEntry[] {
  const codeRoles = Object.values(roles).map((r) => ({
    role: r.name,
    description: r.description,
    permissionMode: r.permissionMode,
    toolCheckFallback: r.toolCheckFallback ?? "allow",
    skills: r.skills ?? [],
    base: r.allowedTools,
  }));
  return [
    ...codeRoles,
    {
      role: "moderator",
      description: "Top-level orchestrator — routes work and talks to you.",
      permissionMode: "dontAsk",
      toolCheckFallback: "allow",
      skills: [],
      base: MODERATOR_ALLOWED_TOOLS,
    },
    {
      role: "finance",
      description: "Standalone finance agent — expenses, settlements, receipts.",
      permissionMode: "dontAsk",
      toolCheckFallback: "allow",
      skills: [],
      base: FINANCE_TOOLS,
    },
  ];
}

export function buildPermissionsView(store: Store, bus: EventBus): PermissionRoleView[] {
  // Aggregate denials once.
  const denialMap = new Map<string, { count: number; lastTs: string }>();
  for (const e of bus.history(0, 5000)) {
    if (e.event.type !== "tool.denied") continue;
    const key = `${e.event.role} ${e.event.tool}`;
    const prev = denialMap.get(key);
    denialMap.set(key, { count: (prev?.count ?? 0) + 1, lastTs: e.ts });
  }

  return permissionRoleCatalog().map((entry) => {
    const overrides = store.listRolePermissions(entry.role);
    const granted = new Set(overrides.filter((o) => o.allow === 1).map((o) => o.tool));
    const revokedNames = new Set(overrides.filter((o) => o.allow === 0).map((o) => o.tool));
    const effective = effectiveAllowedTools(entry.role, entry.base, store);
    const baseSet = new Set(entry.base);

    const tools: PermissionTool[] = effective.map((name) => ({
      name,
      source: baseSet.has(name) ? "default" : granted.has(name) ? "granted" : "default",
    }));
    const revoked: PermissionTool[] = [...revokedNames]
      .filter((name) => baseSet.has(name))
      .map((name) => ({ name, source: "revoked" as const }));

    const denials: PermissionDenial[] = [];
    for (const [key, agg] of denialMap) {
      const [role, tool] = key.split(" ");
      if (role === entry.role) denials.push({ tool, count: agg.count, lastTs: agg.lastTs });
    }
    denials.sort((a, b) => b.lastTs.localeCompare(a.lastTs));

    return {
      role: entry.role,
      description: entry.description,
      permissionMode: entry.permissionMode,
      toolCheckFallback: entry.toolCheckFallback,
      skills: entry.skills,
      tools,
      revoked,
      denials,
    };
  });
}
```

> Confirm `bus.history(sinceId, limit)` exists (it does — `src/events.ts:55-61`) and that `roles` is exported from `src/agents/roles/index.ts` (`:59`). `MODERATOR_ALLOWED_TOOLS` and `FINANCE_TOOLS` exports come from Stage 1 Task 6.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/permissions-view.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/permissions-view.ts test/permissions-view.test.ts
git commit -m "feat(permissions): buildPermissionsView aggregation + role catalog"
```

---

### Task 10: `GET /api/permissions` + `POST /api/permissions/propose`

**Files:**
- Modify: `src/web/server.ts` (add two routes inside the `if (path.startsWith("/api/"))` block, before the 404 at `:314`; add the import)
- Test: `test/permission-propose.test.ts` (security property at the gate level — propose writes nothing)

- [ ] **Step 1: Write the failing test (security-critical: propose applies nothing)**

Create `test/permission-propose.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { permissionGrantExecutor, permissionRevokeExecutor } from "../src/kernel/executors.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";

describe("permission propose is proposal-only", () => {
  it("proposing a grant queues an action but writes NO role_permissions row pre-approval", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const registry = new ExecutorRegistry();
    registry.register(permissionGrantExecutor(store, bus));
    registry.register(permissionRevokeExecutor(store, bus));
    const gate = new ActionGate({ store, registry, policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });

    // This is exactly what POST /api/permissions/propose does.
    const row = await gate.propose(
      { type: "permission.grant", payload: { role: "finance", tool: "Bash" }, preview: "" },
      { channel: "web", chatId: "mission-control" },
    );

    expect(row.status).toBe("proposed");
    expect(store.listRolePermissions()).toHaveLength(0); // <-- the whole security model
    expect(store.listActions("proposed", 10).some((a) => a.id === row.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes already (gate behavior) — it should**

Run: `npx vitest run test/permission-propose.test.ts`
Expected: PASS (this asserts the gate behavior wired in Stage 1; it's the regression guard for the route).

- [ ] **Step 3: Add the routes**

In `src/web/server.ts`, add the import near the other imports:

```ts
import { buildPermissionsView } from "./permissions-view.js";
```

Inside the `if (path.startsWith("/api/"))` block (before the `return json(res, 404, ...)` at `:314`), add:

```ts
        if (path === "/api/permissions" && req.method === "GET") {
          return json(res, 200, buildPermissionsView(store, bus));
        }

        if (path === "/api/permissions/propose" && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { role?: string; tool?: string; action?: string };
          if (body.action !== "grant" && body.action !== "revoke") {
            return json(res, 400, { error: "action must be grant or revoke" });
          }
          if (!body.role || !body.tool) {
            return json(res, 400, { error: "role and tool are required" });
          }
          try {
            // Proposal-only: the gate authors the preview and (always-supervised) queues it.
            // Nothing is applied until a human approves — safe despite the unauth-localhost API.
            const row = await gate.propose(
              { type: `permission.${body.action}`, payload: { role: body.role, tool: body.tool }, preview: "" },
              { channel: "web", chatId: "mission-control" },
            );
            return json(res, 200, { id: row.id, status: row.status });
          } catch (err) {
            return json(res, 400, { error: (err as Error).message });
          }
        }
```

(`store`, `bus`, and `gate` are already destructured at `:100-101`.)

- [ ] **Step 4: Build + manual route smoke (optional but recommended)**

Run: `npm run build`
Expected: clean.
Optionally, with the daemon running: `curl -s localhost:<uiPort>/api/permissions | head` returns the role array; `curl -s -XPOST localhost:<uiPort>/api/permissions/propose -d '{"role":"finance","tool":"Bash","action":"grant"}'` returns `{"id":"…","status":"proposed"}` and the grant then appears in the Approvals view (not applied until approved).

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts test/permission-propose.test.ts
git commit -m "feat(permissions): GET /api/permissions + POST /api/permissions/propose"
```

---

### Task 11: API client + `PermissionInfo` type

**Files:**
- Modify: `ui/src/api.ts` (type near `TrustInfo` ~`:72`; methods near `trust`/`demoteTrust` ~`:123`)

- [ ] **Step 1: Add the type + methods**

In `ui/src/api.ts`, after `TrustInfo` (~`:81`), add:

```ts
export interface PermissionInfo {
  role: string;
  description: string;
  permissionMode: string;
  toolCheckFallback: string;
  skills: string[];
  tools: { name: string; source: "default" | "granted" | "revoked" }[];
  revoked: { name: string; source: "revoked" }[];
  denials: { tool: string; count: number; lastTs: string }[];
}
```

In the `api` object, after `demoteTrust` (~`:125`), add:

```ts
  permissions: () => request<PermissionInfo[]>("/api/permissions"),
  proposePermission: (role: string, tool: string, action: "grant" | "revoke") =>
    request<{ id: string; status: string }>("/api/permissions/propose", {
      method: "POST",
      body: JSON.stringify({ role, tool, action }),
    }),
```

- [ ] **Step 2: Type-check via the UI build**

Run: `cd ui && npm run build`
Expected: clean (will fail later only when `Permissions.tsx` references these — fine; this step just confirms the api.ts edit compiles).

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(ui): permissions API client + PermissionInfo type"
```

---

### Task 12: `Permissions.tsx` view

**Files:**
- Create: `ui/src/views/Permissions.tsx`

- [ ] **Step 1: Write the view (mirrors Trust.tsx / Approvals.tsx — confirm-before, alert-on-error, reload-after)**

Create `ui/src/views/Permissions.tsx`:

```tsx
import { useMemo } from "react";
import { api, type StoredEvent } from "../api.js";
import { usePoll } from "../hooks.js";

const MODE_HELP: Record<string, string> = {
  dontAsk: "denies anything not in the allowlist",
  bypassPermissions: "sandboxed write role — runs tools without prompting",
  default: "undecided tools route through the role's guard",
};

export function Permissions({ events }: { events: StoredEvent[] }) {
  const lastEvent = useMemo(
    () => events.filter((e) => e.event.type === "permission.changed" || e.event.type === "tool.denied").at(-1)?.id,
    [events],
  );
  const { data, reload } = usePoll(() => api.permissions(), [lastEvent]);
  if (!data) return <div className="text-dim">loading…</div>;

  const propose = async (role: string, tool: string, action: "grant" | "revoke") => {
    if (!tool.trim()) return;
    if (!confirm(`Propose ${action} of "${tool}" for ${role}? It queues in Approvals — you approve to apply.`)) return;
    try {
      await api.proposePermission(role, tool.trim(), action);
      alert("Queued in Approvals — approve there to apply.");
    } catch (e) {
      alert((e as Error).message);
    }
    reload();
  };

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div className="label">Permissions — what each agent may use. Grants go through Approvals.</div>
      {data.map((r) => (
        <div key={r.role} className="hud p-4 boot">
          <div className="flex items-baseline gap-2">
            <div className="text-fg font-display uppercase tracking-widest text-[12px]">{r.role}</div>
            <div className="text-[10px] text-dim" title={MODE_HELP[r.permissionMode] ?? ""}>
              {r.permissionMode}
            </div>
          </div>
          <div className="text-[11px] text-dim mb-2">{r.description}</div>

          <div className="flex flex-wrap gap-1.5 mb-2">
            {r.tools.map((t) => (
              <span
                key={t.name}
                className={`text-[10px] px-1.5 py-0.5 border ${
                  t.source === "granted" ? "border-cyan text-cyan" : "border-line text-dim"
                }`}
              >
                {t.name}
                {t.source === "granted" && " +"}
                <button onClick={() => propose(r.role, t.name, "revoke")} className="ml-1 text-alert hover:text-bright">
                  ×
                </button>
              </span>
            ))}
            {r.revoked.map((t) => (
              <span key={t.name} className="text-[10px] px-1.5 py-0.5 border border-line text-dim line-through">
                {t.name}
                <button onClick={() => propose(r.role, t.name, "grant")} className="ml-1 text-phosphor hover:text-bright no-underline">
                  +
                </button>
              </span>
            ))}
          </div>

          {r.denials.length > 0 && (
            <div className="text-[10px] text-amber mb-2">
              {r.denials.map((d) => (
                <span key={d.tool} className="mr-3">
                  {d.tool} denied {d.count}× (last {d.lastTs.slice(11, 16)}){" "}
                  <button onClick={() => propose(r.role, d.tool, "grant")} className="text-phosphor hover:text-bright">
                    grant
                  </button>
                </span>
              ))}
            </div>
          )}

          <form
            className="flex gap-1.5 items-center"
            onSubmit={(e) => {
              e.preventDefault();
              const input = e.currentTarget.elements.namedItem("tool") as HTMLInputElement;
              propose(r.role, input.value, "grant");
              input.value = "";
            }}
          >
            <input
              name="tool"
              placeholder="tool name (e.g. Bash)"
              className="bg-panel-2 border border-line text-fg text-[11px] px-2 py-1 flex-1"
            />
            <button
              type="submit"
              className="border border-phosphor text-phosphor px-3 py-1 text-[10px] uppercase tracking-widest hover:bg-phosphor hover:text-void transition-colors"
            >
              propose grant
            </button>
          </form>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Build to type-check (will still be unreferenced until Task 13 wires nav)**

Run: `cd ui && npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/views/Permissions.tsx
git commit -m "feat(ui): Permissions view"
```

---

### Task 13: Nav wiring + final build/deploy

**Files:**
- Modify: `ui/src/App.tsx:1-11` (import), `:13` (TABS), `:76-84` (mount)

- [ ] **Step 1: Register the view in three spots**

In `ui/src/App.tsx`:

Add the import alongside the other view imports (`:1-11`):

```ts
import { Permissions } from "./views/Permissions.js";
```

Add `"permissions"` to the `TABS` tuple (`:13`), after `"trust"`:

```ts
const TABS = ["board", "approvals", "trust", "permissions", "agents", "chat", "config", "costs"] as const;
```

Add the mount line in the `<main>` block (`:76-84`), after the `trust` line:

```tsx
          <div className={tab === "permissions" ? "" : "hidden"}><Permissions events={events} /></div>
```

- [ ] **Step 2: Build everything**

Run: `npm run build && (cd ui && npm run build)`
Expected: both clean.
Run: `npx vitest run`
Expected: full suite green.

- [ ] **Step 3: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(ui): add Permissions to Mission Control nav"
```

- [ ] **Step 4: Deploy + smoke-check live**

Run: `launchctl kickstart -k gui/$(id -u)/com.ihab.aios`
Then open Mission Control, click **Permissions**: every role + moderator + finance render with their effective allowlists; proposing a grant lands in **Approvals**; approving it makes the tool show as `granted` and (verified against the source role) reach the agent on its next run.

---

## Self-Review

**Spec coverage:**
- §1 Override model (code default + DB override, effective = base ∪ grants \ revokes, fresh per run, never mutate code, fail-closed) → Tasks 1, 2, 6. ✅
- §2 Gated `permission.grant`/`permission.revoke` (action types, always-supervised, gate-authored preview, executors upsert with granted_by, self-escalation closed) → Tasks 3, 4, 5; propose-only proven in Task 10. ✅
- §3 Denial surfacing (PreToolUse hook on every run, deduped `tool.denied`, aggregated, static-allowlist fallback, swallowed failure) → Tasks 7, 8, 9. ✅
- §4 Permissions view + API (`GET /api/permissions` per-role with tags + denials, `POST /api/permissions/propose` queues + applies nothing, `Permissions.tsx`, Approvals reused, nav entry) → Tasks 9–13. ✅
- §5 Runtime merge at all seams + fail-closed + zero-regression + always-supervised + swallowed denial-hook failure → Tasks 6, 8 (FinanceAgent added as the 4th seam beyond the three the spec named — it builds `FINANCE_TOOLS` independently and "finance" is the spec's marquee role). ✅
- Error handling table (read-fail → default; unknown role/tool inert; denial-hook error swallowed; grant for unregistered tool inert; gate/executor failure surfaced) → covered by `effectiveAllowedTools` fail-closed (T2), `withDenialObserver` try/catch (T7), upsert-of-any-string semantics (T1), gate's existing failure path. ✅
- Testing list (effectiveAllowedTools incl. fail-closed; zero-regression; gate authors preview + no-autonomous + granted_by; API shape + propose-applies-nothing; deduped denial + hook-failure-safe; security: read-fail never widens, propose never mutates, grant doesn't bypass the gate for outward effects) → Tasks 2, 4, 5, 6, 7, 9, 10. ✅

**Deliberate spec deltas (flagged):**
1. **Executor signature widened** (`ExecutorContext`) — the spec assumes the executor can read the approver for `granted_by`, but the codebase passed executors only the payload. Task 3 makes this a clean, backward-compatible extension (existing executors unaffected).
2. **Table has an `id` column** beyond the spec's DDL — matches the universal `id INTEGER PRIMARY KEY AUTOINCREMENT` convention in `db.ts`; `UNIQUE(role, tool)` still drives the upsert.
3. **Revoke = upsert allow=0**, not row-delete — yields the exact `base \ {allow=0}` formula and makes grant/revoke a single idempotent `setRolePermission`. No `delete` method needed (YAGNI).
4. **FinanceAgent is a 4th merge seam** — not in the spec's three-seam list, but "finance" is its headline role and the standalone agent owns its own allowlist.

**Placeholder scan:** No TBD/TODO/"add error handling"/"similar to Task N". Every code step carries real code; every run step carries an exact command + expected result. ✅

**Type consistency:** `setRolePermission(role, tool, allow, grantedBy)`, `listRolePermissions(role?)`, `RolePermissionRow`, `effectiveAllowedTools(roleName, base, store)`, `withEffectiveTools`, `withDenialObserver`, `ExecutorContext{by,auto}`, event `permission.changed{role,tool,allow,by}` and `tool.denied{role,tool}`, `buildPermissionsView(store,bus)`, `PermissionInfo`/`PermissionRoleView`, `api.permissions()`/`api.proposePermission(role,tool,action)` — names used identically across every task that references them. ✅
