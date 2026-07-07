# Mail Recall-Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Index mail threads into the existing BM25 memory index so agents can recall past correspondence, with a privacy wall at index time.

**Architecture:** One recall doc per mail thread (`thread:<thread_id>`), built by a new `indexMailThread()` in the existing `src/memory/indexer.ts`. Live re-index rides the event bus (`mail.sent` / `mail.asked_user`); sweep-time refusals re-index directly from `GoalEngine`; boot `reconcile()` backfills and deletes newly-walled docs. Zero new query surface — the existing `recall` tool picks up source `"mail"` automatically.

**Tech Stack:** TypeScript, `node:sqlite` (NO FTS5 — the index is the hand-rolled inverted index + BM25-in-code in `src/memory/recall.ts`), vitest.

**Spec:** `docs/superpowers/specs/2026-07-07-mail-recall-indexing-design.md` — read it first.

## Global Constraints

- `node:sqlite` only — no FTS5, no better-sqlite3, **no new npm deps**.
- Privacy wall is at **index time**: a thread with ANY private-visibility participant is never indexed and a stale doc is deleted. This is load-bearing — finance mail must never be recallable by shared agents.
- Refused messages never appear in indexed bodies.
- Do not change mail statuses, sweep semantics, `read_at` semantics, or the depth cap.
- Do not touch `EVENT_INDEX_ALLOW` (inbound email stays excluded) or the existing `email.*` decision wall in `indexDecision`.
- Existing suite baseline: 887 pass + 1 skip. It must stay green.
- Test style: vitest, `new Store(":memory:")`, registry fixtures via `loadRegistry` over tmpdir YAML (copy the pattern from `test/mailbox.test.ts`).
- Commands from repo root: `npx vitest run <file>`, `npx tsc --noEmit`.

---

### Task 1: `indexMailThread` core — union, store query, wall, domain, doc build

**Files:**
- Modify: `src/memory/recall.ts:4` (MemorySource union)
- Modify: `src/store/db.ts` (add `listMailThreadIds` next to `mailThread`, ~line 745)
- Modify: `src/memory/indexer.ts` (new functions at end of file)
- Test: `test/mail-recall-indexing.test.ts` (create)

**Interfaces:**
- Consumes: `store.mailThread(threadId): MailRow[]` (exists, db.ts:742), `indexDoc` / `DOMAINS` / `Domain` from `src/memory/recall.ts`, `LoadedRegistry` from `src/agents/registry/loader.ts` (`agents: Map<string, AgentDef>` where `AgentDef = { manifest, role, department }`, `departments: Map<string, LoadedDepartment>` with `.memoDomain`, `agentOf: Map<string, string>` alias→canonical), `store.deleteMemoryDoc(source, ref)`, `store.memoryFingerprint(source, ref)`.
- Produces: `indexMailThread(store: Store, registry: LoadedRegistry, threadId: string): void` and `store.listMailThreadIds(): string[]` — Tasks 2 and 3 call both/former.

- [ ] **Step 1: Write the failing tests**

Create `test/mail-recall-indexing.test.ts`:

```ts
// test/mail-recall-indexing.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, type MailRow } from "../src/store/db.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { recall } from "../src/memory/recall.js";
import { indexMailThread } from "../src/memory/indexer.js";

/** engineering (code): athena, vulcan — shared. finance (money): midas private, ledger shared. */
function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "mri-"));
  const agentsDir = join(root, "agents");
  const eng = join(agentsDir, "engineering");
  const fin = join(agentsDir, "finance");
  mkdirSync(eng, { recursive: true });
  mkdirSync(fin, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  const agent = (name: string, dept: string, extra = "") =>
    `name: ${name}\ntitle: T\ndepartment: ${dept}\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n${extra}`;
  writeFileSync(join(eng, "athena.yaml"), agent("athena", "engineering"));
  writeFileSync(join(eng, "vulcan.yaml"), agent("vulcan", "engineering"));
  writeFileSync(join(fin, "department.yaml"),
    "department: finance\nmission: Money.\nlead: midas\nmemoDomain: money\nplaybooks: []\nprivateMemo: true\n");
  writeFileSync(join(fin, "midas.yaml"), agent("midas", "finance", "visibility: private\n"));
  writeFileSync(join(fin, "ledger.yaml"), agent("ledger", "finance"));
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

const registry = fixtureRegistry();

function mailRow(over: Partial<MailRow> = {}): Omit<MailRow, "created_at" | "read_at"> {
  return {
    id: over.id ?? "m1", from_agent: over.from_agent ?? "athena", to_agent: over.to_agent ?? "vulcan",
    kind: over.kind ?? "request", body: over.body ?? "body", goal_id: null,
    origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1,
    status: over.status ?? "queued", error: null,
    thread_id: over.thread_id, in_reply_to: over.in_reply_to ?? null,
  };
}

describe("listMailThreadIds", () => {
  it("returns distinct thread ids", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({ id: "a", thread_id: "t1" }));
    store.insertMail(mailRow({ id: "b", thread_id: "t1" }));
    store.insertMail(mailRow({ id: "c" })); // thread_id defaults to own id
    expect(store.listMailThreadIds().sort()).toEqual(["c", "t1"]);
  });
});

describe("indexMailThread", () => {
  it("indexes an agent↔agent thread under the root recipient's dept domain", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({ id: "q1", body: "please review the WAL checkpoint tuning", thread_id: "t1" }));
    store.insertMail(mailRow({
      id: "r1", from_agent: "vulcan", to_agent: "athena", kind: "report",
      body: "checkpoint interval doubled", thread_id: "t1", in_reply_to: "q1",
    }));
    indexMailThread(store, registry, "t1");
    const hits = recall(store, "checkpoint tuning", { domain: "code" });
    expect(hits.length).toBe(1);
    expect(hits[0].source).toBe("mail");
    expect(hits[0].ref).toBe("thread:t1");
    expect(hits[0].snippet).toContain("checkpoint");
    // both sides of the conversation are in the one doc
    expect(recall(store, "interval doubled", { domain: "code" })[0].ref).toBe("thread:t1");
  });

  it("never indexes a thread with a private participant", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({ id: "f1", to_agent: "midas", body: "our runway is eleven months", thread_id: "tf" }));
    indexMailThread(store, registry, "tf");
    expect(recall(store, "runway").length).toBe(0);
    expect(recall(store, "runway", { domain: "money" }).length).toBe(0);
    expect(store.memoryFingerprint("mail", "thread:tf")).toBeUndefined();
  });

  it("deletes a previously indexed thread when a participant turns private", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({ id: "q1", body: "rotate the api keys quarterly", thread_id: "t1" }));
    indexMailThread(store, registry, "t1");
    expect(recall(store, "rotate keys").length).toBe(1);
    const def = registry.agents.get("vulcan")!;
    def.manifest.visibility = "private";
    try {
      indexMailThread(store, registry, "t1");
      expect(recall(store, "rotate keys").length).toBe(0);
      expect(store.memoryFingerprint("mail", "thread:t1")).toBeUndefined();
    } finally {
      def.manifest.visibility = "shared";
    }
  });

  it("maps domains: shared finance recipient → money, user-ask → asker's dept, unknown → general", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({ id: "a", to_agent: "ledger", body: "quarterly invoice totals", thread_id: "ta" }));
    store.insertMail(mailRow({ id: "b", to_agent: "user", body: "should I archive the legacy repo", thread_id: "tb", status: "awaiting-human" }));
    store.insertMail(mailRow({ id: "c", to_agent: "ghost-agent", body: "orphaned correspondence", thread_id: "tc" }));
    indexMailThread(store, registry, "ta");
    indexMailThread(store, registry, "tb");
    indexMailThread(store, registry, "tc");
    expect(recall(store, "invoice totals", { domain: "money" })[0]?.ref).toBe("thread:ta");
    expect(recall(store, "archive legacy repo", { domain: "code" })[0]?.ref).toBe("thread:tb");
    expect(recall(store, "orphaned correspondence", { domain: "general" })[0]?.ref).toBe("thread:tc");
  });

  it("drops refused messages on rebuild (sweep refusal flips status after insert)", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({ id: "q1", body: "first question about caching", thread_id: "t1" }));
    store.insertMail(mailRow({
      id: "q2", from_agent: "vulcan", to_agent: "athena",
      body: "followup about eviction policy", thread_id: "t1",
    }));
    indexMailThread(store, registry, "t1");
    expect(recall(store, "eviction policy").length).toBe(1);
    store.refuseMail("q2", "chain too deep");
    indexMailThread(store, registry, "t1");
    expect(recall(store, "eviction policy").length).toBe(0);
    expect(recall(store, "caching").length).toBe(1); // non-refused survives
  });

  it("deletes the doc when every message in the thread is refused", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({ id: "q1", body: "misaddressed request", thread_id: "t1" }));
    indexMailThread(store, registry, "t1");
    expect(store.memoryFingerprint("mail", "thread:t1")).toBe("1:q1");
    store.refuseMail("q1", "unknown recipient");
    indexMailThread(store, registry, "t1");
    expect(store.memoryFingerprint("mail", "thread:t1")).toBeUndefined();
  });

  it("re-indexing an unchanged thread is a no-op (fingerprint short-circuit)", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({ id: "q1", body: "idempotence check", thread_id: "t1" }));
    indexMailThread(store, registry, "t1");
    const spy = vi.spyOn(store, "upsertMemoryDoc");
    indexMailThread(store, registry, "t1");
    expect(spy).not.toHaveBeenCalled();
  });

  it("user-ask thread: question and human answer both recallable", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({
      id: "ask1", to_agent: "user", body: "which cloud region should staging use",
      thread_id: "t1", status: "awaiting-human",
    }));
    store.insertMail(mailRow({
      id: "ans1", from_agent: "user", to_agent: "athena", kind: "report",
      body: "use the frankfurt region for staging", thread_id: "t1", in_reply_to: "ask1",
    }));
    indexMailThread(store, registry, "t1");
    expect(recall(store, "cloud region staging", { domain: "code" }).length).toBe(1);
    expect(recall(store, "frankfurt", { domain: "code" })[0].snippet).toContain("frankfurt");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mail-recall-indexing.test.ts`
Expected: FAIL — `indexMailThread` is not exported; `listMailThreadIds` is not a function.

- [ ] **Step 3: Implement**

3a. `src/memory/recall.ts:4` — extend the union:

```ts
export type MemorySource = "vault" | "event" | "decision" | "memo" | "mail";
```

3b. `src/store/db.ts` — add directly below the existing `mailThread` method (~line 745):

```ts
  listMailThreadIds(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT thread_id FROM mail").all() as unknown as Array<{ thread_id: string }>;
    return rows.map((r) => r.thread_id);
  }
```

3c. `src/memory/indexer.ts` — extend imports and append the two functions.

Change the recall import (line 6) and add two type imports:

```ts
import { indexDoc, DOMAINS, type Domain, type MemorySource } from "./recall.js";
import type { MailRow } from "../store/db.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
```

(Note: `Store` is already imported as a type from `../store/db.js` — merge the `MailRow` import into that line.)

Append at end of file:

```ts
/** Recall domain for a mail thread: the root recipient's dept memoDomain; asks to the
 *  owner fall back to the asking agent's dept; unresolvable agents → general. */
function mailThreadDomain(registry: LoadedRegistry, root: MailRow): Domain {
  const target = root.to_agent === "user" ? root.from_agent : root.to_agent;
  const canonical = registry.agentOf.get(target);
  const def = canonical ? registry.agents.get(canonical) : undefined;
  const memoDomain = def ? registry.departments.get(def.department)?.memoDomain : undefined;
  return DOMAINS.includes(memoDomain as Domain) ? (memoDomain as Domain) : "general";
}

/** Index one mail thread as a single recall doc — or delete it. Privacy wall at index
 *  time: a thread with ANY private-visibility participant is never indexed, and a stale
 *  doc is deleted (self-healing on visibility flips). Refused messages are excluded from
 *  the body; the count in the fingerprint forces a rebuild when a sweep refusal flips a
 *  message after insert. Bodies may embed external data — indexed as retrieval context
 *  only; the Action Gate still protects all effects (same posture as indexEvent). */
export function indexMailThread(store: Store, registry: LoadedRegistry, threadId: string): void {
  const rows = store.mailThread(threadId);
  if (!rows.length) return;
  const ref = `thread:${threadId}`;
  const participants = new Set<string>();
  for (const m of rows) { participants.add(m.from_agent); participants.add(m.to_agent); }
  participants.delete("user");
  for (const p of participants) {
    const canonical = registry.agentOf.get(p);
    const def = canonical ? registry.agents.get(canonical) : undefined;
    if (def?.manifest.visibility === "private") { store.deleteMemoryDoc("mail", ref); return; }
  }
  const included = rows.filter((m) => m.status !== "refused");
  if (!included.length) { store.deleteMemoryDoc("mail", ref); return; }
  const root = rows[0];
  indexDoc(store, {
    source: "mail", ref, domain: mailThreadDomain(registry, root),
    title: `mail ${root.from_agent} ↔ ${root.to_agent} (${root.kind})`,
    body: included.map((m) => `${m.from_agent} → ${m.to_agent}: ${m.body}`).join("\n"),
    ts: included[included.length - 1].created_at,
    fingerprint: `${included.length}:${rows[rows.length - 1].id}`,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/mail-recall-indexing.test.ts`
Expected: PASS (9 tests).

Then run the neighbors that touch the same files:
`npx vitest run test/memory-indexer.test.ts test/recall.test.ts test/mail-store.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` — expected clean.

```bash
git add src/memory/recall.ts src/memory/indexer.ts src/store/db.ts test/mail-recall-indexing.test.ts
git commit -m "feat(memory): index mail threads for recall — wall at index time"
```

---

### Task 2: Boot reconcile mail pass

**Files:**
- Modify: `src/memory/indexer.ts:89-102` (`reconcile`)
- Modify: `src/index.ts:414` (pass registry)
- Test: `test/mail-recall-indexing.test.ts` (append describe block)

**Interfaces:**
- Consumes: `indexMailThread(store, registry, threadId)` and `store.listMailThreadIds()` from Task 1.
- Produces: `reconcile(store: Store, vault: VaultWriter, registry?: LoadedRegistry): void` — registry optional; when absent the mail pass is skipped (keeps the 3 existing test call sites `reconcile(store, vault)` compiling and focused).

- [ ] **Step 1: Write the failing tests**

Append to `test/mail-recall-indexing.test.ts` (add `VaultWriter` + `reconcile` imports at top):

```ts
import { VaultWriter } from "../src/vault/writer.js";
import { reconcile } from "../src/memory/indexer.js"; // merge into the existing indexer import
```

```ts
describe("reconcile mail pass", () => {
  it("backfills existing threads and deletes newly-walled docs", () => {
    const root = mkdtempSync(join(tmpdir(), "mri-vault-"));
    const store = new Store(":memory:");
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    store.insertMail(mailRow({ id: "q1", body: "backfilled correspondence", thread_id: "t1" }));
    reconcile(store, vault, registry);
    expect(recall(store, "backfilled correspondence")[0].ref).toBe("thread:t1");
    const def = registry.agents.get("vulcan")!;
    def.manifest.visibility = "private";
    try {
      reconcile(store, vault, registry);
      expect(recall(store, "backfilled correspondence").length).toBe(0);
    } finally {
      def.manifest.visibility = "shared";
    }
  });

  it("skips the mail pass when no registry is given (legacy signature)", () => {
    const root = mkdtempSync(join(tmpdir(), "mri-vault-"));
    const store = new Store(":memory:");
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    store.insertMail(mailRow({ id: "q1", body: "invisible without registry", thread_id: "t1" }));
    reconcile(store, vault);
    expect(recall(store, "invisible without registry").length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mail-recall-indexing.test.ts`
Expected: first new test FAILS (no mail hit after reconcile); second passes trivially — that's fine, it pins the optional-param behavior.

- [ ] **Step 3: Implement**

`src/memory/indexer.ts` — change the `reconcile` signature and append the mail pass at the end of the function body:

```ts
/** Boot backfill: vault + all resolved decisions + allowlisted historical events + mail
 *  threads (when a registry is provided). Idempotent; also deletes newly-walled mail docs. */
export function reconcile(store: Store, vault: VaultWriter, registry?: LoadedRegistry): void {
  reindexVault(store, vault);
  // 5000 caps are a deliberate boot-backfill bound (steady state is covered by live indexing +
  // reindexVault), not a paginated full scan.
  for (const a of store.listActions(undefined, 5000)) {
    if (RESOLVED_STATUSES.includes(a.status)) indexDecision(store, a.id);
  }
  for (const row of store.listEvents(0, 5000)) {
    try {
      const event = JSON.parse(row.payload);
      indexEvent(store, { id: row.id, ts: row.ts, event });
    } catch { /* skip malformed */ }
  }
  if (registry) {
    for (const tid of store.listMailThreadIds()) indexMailThread(store, registry, tid);
  }
}
```

`src/index.ts:414` — pass the registry:

```ts
    reconcile(store, vault, registry);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/mail-recall-indexing.test.ts test/memory-indexer.test.ts test/money-privacy.test.ts test/bunq-recall-exclusion.test.ts`
Expected: PASS — the three existing `reconcile(store, vault)` call sites compile and behave unchanged.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` — expected clean.

```bash
git add src/memory/indexer.ts src/index.ts test/mail-recall-indexing.test.ts
git commit -m "feat(memory): reconcile backfills mail threads, deletes newly-walled docs"
```

---

### Task 3: Live wiring — event listener, sweep-refusal re-index, tool description

**Files:**
- Modify: `src/index.ts:99-108` (bus listener), `src/index.ts:43` (import)
- Modify: `src/engine/goals.ts` (helper + 3 refusal sites: ~435 unknown recipient, ~443 private wall, ~471 planner failure)
- Modify: `src/packs/server.ts:53` (tool description)
- Test: `test/mail-sweep.test.ts` (append one test)

**Interfaces:**
- Consumes: `indexMailThread(store, registry, threadId)` from Task 1. Event shapes from `src/events.ts`: `{ type: "mail.sent"; id; from; to; kind }`, `{ type: "mail.asked_user"; id; from; question; goalId }`.
- Produces: nothing new — wiring only.

- [ ] **Step 1: Write the failing test**

Append to `test/mail-sweep.test.ts` (add to the existing imports: `import { indexMailThread } from "../src/memory/indexer.js";`):

```ts
  it("sweep refusal re-indexes the thread (refused body drops out of recall)", async () => {
    const { store, engine } = harness(okRun);
    store.insertMail(reqMail({ id: "m1", to_agent: "nobody", body: "find the perf regression" }));
    indexMailThread(store, registry, "m1"); // stands in for the live mail.sent listener
    expect(store.memoryFingerprint("mail", "thread:m1")).toBe("1:m1");
    engine.pump();
    await flush();
    expect(store.getMail("m1")!.status).toBe("refused");
    // single-message thread, now all-refused → doc deleted by the refusal-site re-index
    expect(store.memoryFingerprint("mail", "thread:m1")).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mail-sweep.test.ts`
Expected: the new test FAILS on the last assertion (fingerprint still `"1:m1"` — nothing re-indexed after refusal). All pre-existing tests PASS.

- [ ] **Step 3: Implement**

3a. `src/engine/goals.ts` — add the import (top of file, alongside the other `../` imports):

```ts
import { indexMailThread } from "../memory/indexer.js";
```

Add a private helper on `GoalEngine` (near `mailReport`):

```ts
  /** Re-index a mail thread after a sweep-time refusal flips a message's status.
   *  Recall indexing is best-effort — it must never break the sweep. */
  private reindexMailThread(m: MailRow): void {
    try { indexMailThread(this.deps.store, this.deps.registry, m.thread_id ?? m.id); }
    catch { /* best-effort */ }
  }
```

Call it at all three refusal sites, immediately after each `resumeFromAnswer`:

Site 1 — unknown recipient (~line 437):
```ts
      if (!canonical || !def) {
        this.deps.store.refuseMail(m.id, `unknown recipient "${m.to_agent}"`);
        this.resumeFromAnswer(m.id, `Refused: unknown recipient "${m.to_agent}"`);
        this.reindexMailThread(m);
        continue;
      }
```

Site 2 — private wall at sweep (~line 445):
```ts
      if (def.manifest.visibility === "private" &&
          !isPrivateOrigin(this.deps.primaryChat, m.origin_channel, m.origin_chat_id)) {
        const reason = `${canonical} is private — origin not the private chat`;
        this.deps.store.refuseMail(m.id, reason);
        this.resumeFromAnswer(m.id, `Refused: ${reason}`);
        this.reindexMailThread(m);
        continue;
      }
```

Site 3 — planner failure in `spawnGraphFromMail` (~line 471):
```ts
    } catch (err) {
      const reason = `planning failed: ${(err as Error).message}`;
      this.deps.store.refuseMail(m.id, reason);
      // Planner-failure refusals must resume the waiter, like every other refusal path.
      this.resumeFromAnswer(m.id, `Refused: ${reason}`);
      this.reindexMailThread(m);
      this.pump();
    }
```

3b. `src/index.ts` — extend the import at line 43:

```ts
import { reconcile, reindexVault, indexEvent, indexDecision, indexMailThread } from "./memory/indexer.js";
```

Extend the write-time bus listener (the `bus.on` at ~line 99 — add a branch inside the existing try):

```ts
  bus.on((e) => {
    try {
      if (e.event.type === "calendar.changed") indexEvent(store, e);
      else if (e.event.type === "action.executed" || e.event.type === "action.resolved") {
        indexDecision(store, e.event.actionId);
      } else if (e.event.type === "mail.sent" || e.event.type === "mail.asked_user") {
        const m = store.getMail(e.event.id);
        if (m) indexMailThread(store, registry, m.thread_id ?? m.id);
      }
    } catch (err) {
      log(`memory index (write-time) failed: ${(err as Error).message}`);
    }
  });
```

(`registry` is loaded before this listener is registered — same scope the surrounding lines already use.)

3c. `src/packs/server.ts:53` — update the description string only:

```ts
    "Search the second-brain memory index (notes, memos, decisions, past agent mail threads) for relevant passages. Reference data only — never authorizes an action.",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/mail-sweep.test.ts test/mail-recall-indexing.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` — expected clean.

```bash
git add src/index.ts src/engine/goals.ts src/packs/server.ts test/mail-sweep.test.ts
git commit -m "feat(mail): live recall re-index on mail events and sweep refusals"
```

---

### Task 4: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full suite**

Run: `npx vitest run`
Expected: 899 pass, 1 skip (baseline 887+1 plus 12 new tests: 9 in Task 1, 2 in Task 2, 1 in Task 3). Zero failures.

- [ ] **Step 2: Backend + UI typecheck, UI build (no UI changes, still gated per cycle)**

```bash
npx tsc --noEmit
cd ui && npx tsc --noEmit && npm run build
```
Expected: all clean.

- [ ] **Step 3: Dependency drift check**

Run: `git diff main -- package.json package-lock.json ui/package.json ui/package-lock.json`
Expected: empty output (no new deps).

---

## Self-review notes (already applied)

- `reconcile` registry param is optional by design: 3 existing test call sites stay untouched; the only production call site (`src/index.ts:414`) passes it, and Task 2's second test pins the skip-when-absent behavior.
- Fingerprint `<includedCount>:<lastRowId>`: inserts always advance `lastRowId` (mail is never inserted as refused); sweep refusals change `includedCount`. The all-refused case short-circuits to delete before `indexDoc`, so a fingerprint like `0:x` never exists.
- `downgradeMailToNote` (depth cap) flips kind, not body/count — no re-index needed; a stale `(request)` in the title is cosmetic and heals on the next thread message.
- Standup mail emits `mail.sent` (`src/heartbeat/standup.ts:90`) — covered by the listener; kind `standup` is indexed like any other mail per spec §4 scope.
