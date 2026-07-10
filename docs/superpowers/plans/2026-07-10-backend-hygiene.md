# Backend Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four audit findings from the 2026-07-10 capability review: group-ledger writes bypass the Action Gate; the `/reset` race can silently undo a session reset; ~270 lines of dead legacy role definitions shadow the YAML registry; the manifest `guards` field is inert and misleading.

**Architecture:** (1) A new `ledger.write` gated action type — seeded autonomous so behavior is unchanged, but every write lands in the audit trail and is demotable to supervised. (2) A reset-epoch counter in kv: `resumableTurn` only persists a session id if no reset happened mid-flight. (3) The legacy `roles` const dies; the 8 tests that used it as an oracle re-point at the compiled YAML registry. (4) `guards` leaves the manifest schema; two small dead-code spots go with it.

**Tech Stack:** TypeScript, better-sqlite3 store, zod, vitest. No new dependencies.

**Spec:** conversation analysis 2026-07-10 (backend capability inventory, findings 1–4). No separate spec doc.

## Global Constraints

- No new npm dependencies. `git diff origin/main -- package.json package-lock.json` stays empty.
- Suite baseline **934 pass + 1 skip** stays green; tasks may only add tests or replace assertions 1:1 as specified. Backend `npx tsc --noEmit` clean after every task.
- Behavior-preserving by default: `ledger.write` ships **seeded autonomous** (same UX as today — instant recording), demotable via the existing trust UI. Tool reply strings stay byte-identical on the autonomous path.
- Task order is fixed: Task 2 (reset epoch) must land before Task 4 (comment touch-ups reference the new `clearSession` role).
- Out of scope (explicitly): network-egress sandbox for the code pack (`src/code/exec.ts:46` TODO — needs its own design; naive deny breaks `npm install` builds), Slack approval buttons/voice parity, `needsWorkspace` parameter removal (documented as advisory in `src/engine/goals.ts:771` — carries intent, cheap to keep).
- Build cycle (session-locked): worktree off `origin/main`; per-task commits; whole-branch review before FF-merge; deploy `npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios`; READ-ONLY smoke.

---

### Task 1: Gate group-ledger writes (`ledger.write`, seeded autonomous)

**Files:**
- Modify: `src/kernel/executors.ts` (new executor)
- Modify: `src/finance/server.ts:39-77` (`add_expense`, `remove_expense` route through the gate)
- Modify: `src/config.ts:221` (default trust seed)
- Modify: `src/index.ts:141-145` (register executor)
- Test: `test/ledger-server.test.ts`

**Interfaces:**
- Consumes: `ActionGate.propose(input, origin): Promise<ActionRow>` (`src/kernel/gate.ts:34`), `Store.addExpense/deleteExpense`, `VaultWriter.appendDaily`.
- Produces: executor factory `ledgerWriteExecutor(store: Store, vault: VaultWriter, company: string): Executor` with action type `"ledger.write"` and payload `{ op: "add" | "remove", ledger: string, payer?, amount_cents?, currency?, description?, date?, receipt_path?, id? }`. The executor's return string is the tool's user-visible reply on the autonomous path.

- [ ] **Step 1: Write the failing tests**

In `test/ledger-server.test.ts`, extend the `handlers` helper to register the executor and (by default) seed `ledger.write` autonomous, so all existing tests keep their instant-recording behavior:

```ts
import { ledgerWriteExecutor } from "../src/kernel/executors.js";
import { newRecord } from "../src/kernel/trust.js";
```

Inside `handlers(...)` replace `registry: new ExecutorRegistry(),` with:

```ts
  const registry = new ExecutorRegistry();
  const gate = new ActionGate({ store, registry, policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
```

and after `vault.init();` add:

```ts
  registry.register(ledgerWriteExecutor(store, vault, "TestCo"));
  if (seedAutonomous) {
    const rec = newRecord("ledger.write", new Date().toISOString());
    store.upsertTrust({ ...rec, state: "autonomous", graduatedAt: rec.firstSeen });
  }
```

with the signature becoming `function handlers(store: Store, origin: {...}, seedAutonomous = true)`. Then add two tests at the end of the describe block:

```ts
  it("ledger writes flow through the gate: autonomous seed → executed + audited", async () => {
    const t = handlers(store, { channel: "telegram", chatId: "gated-A" });
    const reply = await callText(t.add_expense, {
      payer: "Ihab", amount: 12, currency: "EUR", description: "Cable", date: "2026-07-01",
    });
    expect(reply).toContain("Recorded #");
    const audited = store.listActions().filter((a) => a.type === "ledger.write");
    expect(audited).toHaveLength(1);
    expect(audited[0].status).toBe("executed");
  });

  it("ledger writes queue when ledger.write is supervised (no seed)", async () => {
    const t = handlers(store, { channel: "telegram", chatId: "gated-B" }, false);
    const reply = await callText(t.add_expense, {
      payer: "Ihab", amount: 12, currency: "EUR", description: "Cable", date: "2026-07-01",
    });
    expect(reply).toContain("Queued for approval");
    expect(await callText(t.list_expenses, {})).toContain("Ledger is empty");
    const queued = store.listActions().filter((a) => a.type === "ledger.write");
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe("proposed");
  });
```

(If `store.listActions()` has a different name, use the query the Approvals endpoint uses — `listActions(status?)` in `src/store/db.ts`; adjust the call, not the assertion.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/ledger-server.test.ts`
Expected: FAIL — `ledgerWriteExecutor` not exported.

- [ ] **Step 3: Add the executor to `src/kernel/executors.ts`**

Append (with `VaultWriter` already imported at the top of the file):

```ts
/** Group-ledger mutations flow through the gate for audit + demotability.
 *  Seeded autonomous by default (config.trustSeeds) — same UX, full audit trail. */
export function ledgerWriteExecutor(store: Store, vault: VaultWriter, company: string): Executor {
  return {
    type: "ledger.write",
    schema: z.object({
      op: z.enum(["add", "remove"]),
      ledger: z.string(),
      payer: z.string().optional(),
      amount_cents: z.number().int().positive().optional(),
      currency: z.string().optional(),
      description: z.string().optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      receipt_path: z.string().optional(),
      id: z.number().int().optional(),
    }).refine((p) => p.op === "remove" ? p.id != null
      : p.payer != null && p.amount_cents != null && p.currency != null && p.description != null && p.date != null,
      { message: "add needs payer/amount_cents/currency/description/date; remove needs id" }),
    async execute(payload) {
      const p = payload as {
        op: "add" | "remove"; ledger: string; payer?: string; amount_cents?: number;
        currency?: string; description?: string; date?: string; receipt_path?: string; id?: number;
      };
      if (p.op === "add") {
        const id = store.addExpense({
          ledger: p.ledger, payer: p.payer!, amountCents: p.amount_cents!,
          currency: p.currency!, description: p.description!, date: p.date!, receiptPath: p.receipt_path,
        });
        const pretty = `${(p.amount_cents! / 100).toFixed(2)} ${p.currency}`;
        vault.appendDaily(`${company} expense #${id}: ${p.payer} paid ${pretty} — ${p.description}`);
        return `Recorded #${id}: ${p.payer} paid ${pretty} for "${p.description}" on ${p.date}.`;
      }
      return store.deleteExpense(p.ledger, p.id!)
        ? `Removed expense #${p.id}.`
        : `No expense #${p.id} in this ledger.`;
    },
  };
}
```

Note: the executor formats the amount inline; `formatCents` lives in `src/finance/ledger.ts` and produces `"100.00 EUR"` — if the existing round-trip test's `expect(list).toContain("150.00 EUR")` fails on formatting, import and use `formatCents(p.amount_cents!, p.currency!)` from `../finance/ledger.js` instead (the list path is unchanged either way; only the vault line + reply use this string).

- [ ] **Step 4: Route the finance tools through the gate — `src/finance/server.ts`**

Change the destructure at line 33 to include the gate: `const { store, vault, gate, origin } = deps;` (`vault` may become unused — remove it from the destructure if so). Replace the `addExpense` handler body (lines 52-68) with:

```ts
    async (a) => {
      const date = a.date ?? new Date().toISOString().slice(0, 10);
      const cents = toCents(a.amount);
      const currency = a.currency.toUpperCase();
      const row = await gate.propose({
        type: "ledger.write",
        payload: {
          op: "add", ledger, payer: a.payer.trim(), amount_cents: cents,
          currency, description: a.description, date,
          ...(a.receipt_path ? { receipt_path: a.receipt_path } : {}),
        },
        preview: `Ledger add: ${a.payer.trim()} paid ${formatCents(cents, currency)} — ${a.description} (${ledger})`,
      }, origin);
      return text(row.status === "executed"
        ? row.result ?? "Recorded."
        : `Queued for approval (${row.id}) — approve to record.`);
    },
```

and the `removeExpense` handler body (line 75-76) with:

```ts
    async (a) => {
      const row = await gate.propose({
        type: "ledger.write",
        payload: { op: "remove", ledger, id: a.id },
        preview: `Ledger remove: expense #${a.id} (${ledger})`,
      }, origin);
      return text(row.status === "executed"
        ? row.result ?? `Removed expense #${a.id}.`
        : `Queued for approval (${row.id}) — approve to remove.`);
    },
```

(`ActionInput` requires a `preview` string — see `src/kernel/actions.ts`; check the exact field list there and match it.)

- [ ] **Step 5: Register + seed**

`src/index.ts` — after the existing executor registrations (`:141-145`), add:

```ts
  executors.register(ledgerWriteExecutor(store, vault, config.financeCompany));
```

(match the local variable names used by the neighboring `register` calls — the registry variable may be named differently; copy their receiver.) Import `ledgerWriteExecutor` alongside the other kernel executor imports.

`src/config.ts:221` — change the default seed string:

```ts
    trustSeeds: parseTrustSeeds(process.env.AIOS_TRUST_SEED ?? "vault.write=autonomous,ledger.write=autonomous"),
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/ledger-server.test.ts && npx tsc --noEmit`
Expected: ALL PASS (existing 5 + 2 new), tsc clean.

- [ ] **Step 7: Full suite + commit**

Run: `npx vitest run`
Expected: **≥ 936 pass + 1 skip**.

```bash
git add src/kernel/executors.ts src/finance/server.ts src/config.ts src/index.ts test/ledger-server.test.ts
git commit -m "feat(kernel): gate group-ledger writes as ledger.write — seeded autonomous, audited, demotable"
```

---

### Task 2: Fix the `/reset` race with a reset-epoch guard

**Files:**
- Modify: `src/agents/resumable.ts`
- Modify: `src/moderator/session.ts:94-101`, `src/agents/direct.ts:153-162`
- Test: `test/reset-race.test.ts` (new)

**Interfaces:**
- Consumes: `Store.kvGet/kvSet`.
- Produces: `clearSession(store, sessionKey)` now also bumps `reset-epoch:<sessionKey>`; `resumableTurn` refuses to persist a session id when the epoch moved mid-flight. Both `resetSession` methods delegate to `clearSession`. Signatures of `resumableTurn`/`resetSession` unchanged.

- [ ] **Step 1: Write the failing test — `test/reset-race.test.ts`**

```ts
// The /reset race: a turn in flight when resetSession runs must NOT write its old
// session id back after completing (previously required a second /reset).
import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { resumableTurn, clearSession } from "../src/agents/resumable.js";
import { Store } from "../src/store/db.js";

function deferredQuery(sessionId: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const iter = (async function* () {
    await gate;
    yield { type: "result", subtype: "success", session_id: sessionId, result: "ok" };
  })();
  return { iter, release };
}

describe("reset-epoch guard", () => {
  it("a reset during an in-flight turn wins — the old session id is not written back", async () => {
    const store = new Store(":memory:");
    const key = "moderator-session:telegram:1";
    store.kvSet(key, "old-session");
    const { iter, release } = deferredQuery("session-from-inflight-turn");
    vi.mocked(query).mockReturnValueOnce(iter as never);

    const turn = resumableTurn({ store, sessionKey: key, prompt: "hi", options: {} as never });
    clearSession(store, key); // user's /reset lands mid-flight
    release();
    await turn;

    expect(store.kvGet(key)).toBe(""); // reset survived — NOT "session-from-inflight-turn"
  });

  it("without a reset, a successful turn persists its session id as before", async () => {
    const store = new Store(":memory:");
    const key = "moderator-session:telegram:2";
    const { iter, release } = deferredQuery("fresh-session");
    vi.mocked(query).mockReturnValueOnce(iter as never);

    const turn = resumableTurn({ store, sessionKey: key, prompt: "hi", options: {} as never });
    release();
    await turn;

    expect(store.kvGet(key)).toBe("fresh-session");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/reset-race.test.ts`
Expected: first test FAILS (`kvGet` returns `"session-from-inflight-turn"`).

- [ ] **Step 3: Implement the epoch guard in `src/agents/resumable.ts`**

Replace `clearSession` (lines 37-43) and thread the epoch through `runOnce`:

```ts
const epochKey = (sessionKey: string) => `reset-epoch:${sessionKey}`;

/**
 * Clears a stored session id AND bumps the reset epoch, so a turn already in
 * flight cannot write its (now stale) session id back when it completes.
 */
export function clearSession(store: Store, sessionKey: string): void {
  store.kvSet(sessionKey, "");
  store.kvSet(epochKey(sessionKey), String(Number(store.kvGet(epochKey(sessionKey)) || 0) + 1));
}
```

In `runOnce`, capture the epoch before the query starts and guard the persist (replace lines 55-58):

```ts
async function runOnce(params: ResumableTurnParams, resume: string | undefined): Promise<string> {
  const epochAtStart = params.store.kvGet(epochKey(params.sessionKey));
  const q = query({
    prompt: params.prompt,
    options: { ...params.options, ...(resume ? { resume } : {}) },
  });

  let reply = "";
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype === "success") {
        // Only persist ids from successful turns — errored turns may never be
        // written to disk and would poison future resumes. And only when no
        // /reset landed mid-flight (reset-epoch unchanged) — otherwise the
        // completing turn would silently undo the reset.
        if (params.store.kvGet(epochKey(params.sessionKey)) === epochAtStart) {
          params.store.kvSet(params.sessionKey, msg.session_id);
        } else {
          params.log?.(`reset during in-flight turn for ${params.sessionKey} — session id not persisted`);
        }
        params.onSuccess?.(); // commit mail delivery at the same success gate
        reply = msg.result;
      } else {
        const detail = "errors" in msg ? msg.errors.join("; ") : "";
        params.log?.(`turn error (${params.sessionKey}): ${msg.subtype}${detail ? ` — ${detail}` : ""}`);
        reply = `Something went wrong handling that (${msg.subtype}${detail ? `: ${detail}` : ""}). Try again.`;
      }
    }
  }
  return reply || "(no reply)";
}
```

- [ ] **Step 4: Delegate both resetSession methods to clearSession**

`src/moderator/session.ts:94-101` becomes:

```ts
  resetSession(channel: string, chatId: string): void {
    // Bypasses the per-chat lock deliberately: clearSession is atomic kv writes,
    // and the reset-epoch bump makes it win against any in-flight turn.
    clearSession(this.deps.store, `moderator-session:${channel}:${chatId}`);
  }
```

`src/agents/direct.ts:153-162` becomes:

```ts
  resetSession(role: string, channel: string, chatId: string): void {
    // Canonicalize so the key matches the one used in handle().
    const canonical = this.deps.registry.agentOf.get(role) ?? role;
    // Bypasses the per-key lock deliberately: clearSession is atomic kv writes,
    // and the reset-epoch bump makes it win against any in-flight turn.
    clearSession(this.deps.store, `direct-session:${canonical}:${channel}:${chatId}`);
  }
```

Add `clearSession` to each file's import from `../agents/resumable.js` / `./resumable.js` respectively.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/reset-race.test.ts && npx vitest run && npx tsc --noEmit`
Expected: new tests PASS, full suite **≥ 938 pass + 1 skip**, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/agents/resumable.ts src/moderator/session.ts src/agents/direct.ts test/reset-race.test.ts
git commit -m "fix(agents): reset-epoch guard — /reset wins against in-flight turns, no second /reset needed"
```

---

### Task 3: Delete the dead legacy `roles` map; re-point tests at the YAML registry

**Files:**
- Modify: `src/agents/roles/index.ts` (delete the `roles` const, lines 71-343, plus now-unused private consts `READ_TOOLS`, `WEB_TOOLS`, `PACK_MEMO`, `CODE_SHELL`, `RESEARCH_MCP_TOOLS`, `HALALO_DIR` and the `halaloToolChecks`/`HALALO_EXPORTS_DIR` import if nothing else in the file uses them; **keep** `RoleDef`, `VERDICT_SCHEMA`, `TEST_REPORT_SCHEMA`, and the `ToolCheck` type import — `loader.ts` and `runner.ts` import those)
- Modify: `test/fixtures/registry.ts` (add `roleOf` helper)
- Modify: `test/cfo-role.test.ts`, `test/code-devops-role.test.ts`, `test/code-runner-clamp.test.ts`, `test/lifeops-privacy.test.ts`, `test/lifeops-role.test.ts`, `test/pack-runner.test.ts`, `test/research-analyst-role.test.ts`, `test/registry-live-tree.test.ts`

**Interfaces:**
- Consumes: `loadRegistry` via the existing `testRegistry()` fixture; `LoadedRegistry.agentOf: Map<alias, name>`, `.agents: Map<name, { role: RoleDef, ... }>`.
- Produces: `roleOf(nameOrAlias: string): RoleDef` in `test/fixtures/registry.ts` — the tests' role oracle from here on. `src/agents/roles/index.ts` shrinks to type + schema exports.

- [ ] **Step 1: Add the oracle helper to `test/fixtures/registry.ts`**

```ts
import type { RoleDef } from "../../src/agents/roles/index.js";

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

- [ ] **Step 2: Migrate the 8 test files** — mechanical, exact swaps:

Every file: replace `import { roles } from "../src/agents/roles/index.js";` with `import { roleOf } from "./fixtures/registry.js";`, then:

- `test/cfo-role.test.ts`: `roles.cfo` → `roleOf("cfo")` (both lines 12-13; bind `const cfo = roleOf("cfo")` if used more than twice).
- `test/code-devops-role.test.ts`: `roles.devops` → `roleOf("devops")` (lines 6, 13, 14).
- `test/code-runner-clamp.test.ts`: `roles.cfo.allowedTools` → `roleOf("cfo").allowedTools` (line 64).
- `test/lifeops-privacy.test.ts` + `test/lifeops-role.test.ts`: `roles.jasmine` → `roleOf("jasmine")`.
- `test/research-analyst-role.test.ts`: `roles.analyst` → `roleOf("analyst")`.
- `test/pack-runner.test.ts`: `roles.researcher` → `roleOf("researcher")` (lines 17, 20, 25 — bind `const researcher = roleOf("researcher")` at describe scope).
- `test/registry-live-tree.test.ts`: delete the `roles` import (line 7) and the entire `it("compiled roles preserve the legacy security surface", ...)` block (lines 54-71) — its purpose (YAML↔legacy drift) dies with the legacy map. Update the SECURITY comment above the "tool ownership pins" describe (line 91-93) to drop the sentence referencing the parity test. All other assertions in the file stay.

- [ ] **Step 3: Run the migrated tests BEFORE deleting the const** (proves oracle equivalence)

Run: `npx vitest run test/cfo-role.test.ts test/code-devops-role.test.ts test/code-runner-clamp.test.ts test/lifeops-privacy.test.ts test/lifeops-role.test.ts test/pack-runner.test.ts test/research-analyst-role.test.ts test/registry-live-tree.test.ts`
Expected: ALL PASS with the YAML oracle.

- [ ] **Step 4: Delete the legacy map from `src/agents/roles/index.ts`**

Remove `export const roles: Record<string, RoleDef> = { ... };` (lines 71-343) and every private const only it used (`READ_TOOLS`, `WEB_TOOLS`, `PACK_MEMO`, `CODE_SHELL`, `RESEARCH_MCP_TOOLS`, `HALALO_DIR`); remove the `halaloToolChecks`/`HALALO_EXPORTS_DIR` value import if now unused (keep `import type { ToolCheck }`). The file ends up: `RoleDef` interface + `VERDICT_SCHEMA` + `TEST_REPORT_SCHEMA`.

- [ ] **Step 5: Full suite + tsc**

Run: `npx vitest run && npx tsc --noEmit`
Expected: pass count = previous baseline **minus 1** (the deleted parity test) — with Tasks 1-2 landed that is **≥ 937 pass + 1 skip**. tsc clean. `grep -rn "roles\b" src/ --include="*.ts" | grep -v "RoleDef\|roles/index"` → no remaining value references.

- [ ] **Step 6: Commit**

```bash
git add src/agents/roles/index.ts test/
git commit -m "refactor(agents): delete dead legacy roles map — tests pin the compiled YAML registry instead"
```

---

### Task 4: Retire the inert `guards` manifest field + dead-code sweep

**Files:**
- Modify: `src/agents/registry/types.ts:13` (drop `guards` from the schema)
- Modify: `agents/clients/halalo.yaml:52` (drop `guards: []`)
- Modify: `src/engine/goals.ts:139-141` (delete `mkdirCwd`), `src/engine/goals.ts` stale "(Task 6)"/"(Task 7)" comments, `src/engine/plan.ts:313-315` (`void specs`)

**Interfaces:**
- Consumes / Produces: nothing new — deletions only. Real guards keep coming from `buildExtras().halalo.toolChecks` (`src/agents/registry/extras.ts`), which is untouched and pinned by `registry-live-tree.test.ts` ("halalo extras wire the deterministic guard").

- [ ] **Step 1: Drop the field**

`src/agents/registry/types.ts`: delete the line `guards: z.array(z.string()).default([]),`.
`agents/clients/halalo.yaml`: delete the line `guards: []`.
(zod objects are non-strict by default here — but the YAML line goes too so no manifest advertises a knob that does nothing. If any other manifest carries `guards`, delete those lines as well: `grep -rn "^guards:" agents/`.)

- [ ] **Step 2: Dead-code sweep**

`src/engine/goals.ts:139-141` — delete both lines:

```ts
  const mkdirCwd = () => goal.project_dir; // cwd creation handled by makeRunSpecialist path via runner cwd; project dirs are pre-created at goal start (Task 6)
  void mkdirCwd;
```

`src/engine/plan.ts:313-315` — change `const { v, specs } = validateOrExplain([...current.values()], goal.department, origin);` to `const { v } = validateOrExplain([...current.values()], goal.department, origin);` and delete the `void specs;` line.

`src/engine/goals.ts` — reword the two stale phase-name comments: `// src/engine/goals.ts — the unified GoalEngine: node runner (this half) + scheduler (Task 6).` → `// src/engine/goals.ts — the unified GoalEngine: node runner (this half) + scheduler.`, and `/** Used by the Planner (Task 7) to persist a validated plan and start it.` → `/** Used by the lead planner to persist a validated plan and start it.` (keep the rest of that doc comment).

- [ ] **Step 3: Verify**

Run: `npx vitest run && npx tsc --noEmit && grep -rn "guards" agents/ src/agents/registry/types.ts`
Expected: suite green at the Task-3 count, tsc clean, grep shows no manifest `guards` field (the `guards/` directory imports in loader/extras are expected and fine).

- [ ] **Step 4: Commit**

```bash
git add src/agents/registry/types.ts agents/ src/engine/goals.ts src/engine/plan.ts
git commit -m "chore: retire inert manifest guards field + dead-code sweep (mkdirCwd, void specs, stale phase comments)"
```

---

## Final integration checklist

- [ ] `npx vitest run && npx tsc --noEmit && npm run build && git diff origin/main -- package.json package-lock.json`
  Expected: **≥ 937 pass + 1 skip** (934 baseline + 2 ledger + 2 reset − 1 parity), tsc clean, build green, empty drift.
- [ ] Whole-branch review, FF-merge, deploy `npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios`.
- [ ] READ-ONLY smoke: `trust` view (or `/api/trust`) shows `ledger.write` autonomous; add a test expense in a scratch chat → recorded instantly AND visible under `/api/actions?status=executed`; `/reset` in an active chat behaves as before.
