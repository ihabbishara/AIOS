# Triage Inbox Gap-Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Failed goals reopen (with guidance) straight from the inbox, and a ⑯ policy-wall park folds its auto-proposed `permission.grant` into the review row with a one-click "Approve grant & Retry".

**Architecture:** All linking lives server-side in `buildAttentionView` — reviews are built first, each matched against non-expired proposed `permission.grant` actions by exact-substring against the denial line `workers.ts` formats; matched action ids are suppressed from the approvals loop (fold). The UI adds a `reopen` verb (row + canvas guidance) and a fusion button on the review canvas. Zero engine/journal changes.

**Tech Stack:** TypeScript, node:sqlite Store, vitest, React (ui2), no new dependencies.

## Global Constraints

- Trunk-based: commit to main with explicit file paths only (`git add <paths>` — parallel session shares the checkout; `agents/_retired/` stays untracked).
- No new npm dependencies.
- Suite baseline: 194 files / 1517 pass + 2 skip; both roots `npx tsc --noEmit` clean.
- Never edit existing test fixtures to make a test pass.
- New RED tests must assert a concrete property, not just equality with an imported const (vacuous-import trap).
- Deploy: `npm run build && launchctl kickstart -k gui/501/com.ihab.aios`; ui2 touched → `(cd ui2 && npm run build)` FIRST.

---

### Task 1: Failed goals offer `reopen` in the attention queue

**Files:**
- Modify: `src/web/attention-view.ts:71`
- Test: `test/attention-view.test.ts`

**Interfaces:**
- Produces: failed-goal `AttentionItem.actions === ["open", "reopen", "abandon"]` (Task 3's UI keys off the `reopen` verb).

- [ ] **Step 1: Write the failing test** — append inside `describe("buildAttentionView", ...)` in `test/attention-view.test.ts`:

```ts
  it("failed goals offer reopen (⑮ resurrection, surfaced in the inbox — cycle ⑱)", () => {
    const store = new Store(":memory:");
    store.insertGoal(goal("gr"));
    store.updateGoalStatus("gr", "failed", "boom");
    const items = buildAttentionView(store, undefined, NOW);
    const g = items.find((i) => i.kind === "goal")!;
    expect(g.actions).toEqual(["open", "reopen", "abandon"]);
    expect(g.ref.goalId).toBe("gr");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/attention-view.test.ts`
Expected: FAIL — `expected [ 'open', 'abandon' ] to deeply equal [ 'open', 'reopen', 'abandon' ]`

- [ ] **Step 3: Minimal implementation** — in `src/web/attention-view.ts` change line 71:

```ts
      actions: g.status === "failed" ? ["open", "reopen", "abandon"] : ["open", "resume", "abandon"],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/attention-view.test.ts`
Expected: PASS (all tests in file — the existing `toContain("abandon")` assertion stays green).

- [ ] **Step 5: Commit**

```bash
git add src/web/attention-view.ts test/attention-view.test.ts
git commit -m "feat(web): failed goals offer reopen in the attention queue"
```

---

### Task 2: Grant↔park linking + fold in `buildAttentionView`

**Files:**
- Modify: `src/web/dto.ts` (AttentionItem), `src/web/attention-view.ts`
- Create: `test/attention-grants.test.ts`

**Interfaces:**
- Consumes: `store.listActions("proposed", 200)` (`ActionRow` has `id, type, payload, expires_at`), `store.needsReviewNodes()` (`error` holds the joined park objections).
- Produces: `AttentionItem.grants?: Array<{ id: string; role: string; tool: string }>` on review items; matched grant ids no longer appear as standalone approval rows. Task 4's fusion button consumes `item.grants`.

- [ ] **Step 1: Extend the dto** — in `src/web/dto.ts`, inside `interface AttentionItem` after `ref`:

```ts
  /** Proposed permission.grant actions folded into this review row (policy-wall park —
   *  triage-inbox spec §A): one human decision, one row. */
  grants?: Array<{ id: string; role: string; tool: string }>;
```

- [ ] **Step 2: Write the failing tests** — create `test/attention-grants.test.ts`:

```ts
// test/attention-grants.test.ts — a ⑯ park folds its proposed grant into the review row
// (triage-inbox spec §A): linking, suppression, expiry, guard-layer, multi-wall.
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import type { ActionRow } from "../src/kernel/actions.js";
import { appendEvents } from "../src/engine/journal.js";
import { buildAttentionView } from "../src/web/attention-view.js";

const NOW = () => new Date("2026-07-13T10:00:00.000Z");

const ALLOWLIST_LINE = (role: string, tool: string) =>
  `${role} was denied: ${tool} (not in allowlist). A permission grant is queued in Actions — approve it (or reject), then Retry.`;
const GUARD_LINE =
  'clio was denied: Bash — "workspace required". This is engine policy, not a grantable permission; fix the cause (e.g. reopen with guidance, or give the goal a workspace) and Retry.';

function grantAction(id: string, role: string, tool: string, over: Partial<ActionRow> = {}): ActionRow {
  return {
    id, type: "permission.grant", payload: JSON.stringify({ role, tool }),
    preview: `grant ${role} ${tool}`, status: "proposed",
    origin_channel: "engine", origin_chat_id: "goals", trust_state: "supervised",
    verdict_by: null, reject_reason: null, result: null,
    created_at: "2026-07-13T09:00:00.000Z", resolved_at: null,
    expires_at: "2026-07-14T09:00:00.000Z", ...over,
  };
}

function parkedStore(objections: string[]) {
  const store = new Store(":memory:");
  appendEvents(store, "g1", [
    { type: "goal.created", payload: {
      slug: "build-x", title: "Build X", request: "r", department: "engineering", lead: "athena",
      origin: { channel: "t", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
      planSummary: "planned", goalDir: "d", projectDir: null } },
    { type: "plan.recorded", payload: { summary: "s", needsWorkspace: "none", nodes: [
      { key: "impl", kind: "run", agent: "clio", brief: "b", dependsOn: [] },
    ] } },
    { type: "workspace.prepared", payload: { taskDir: null, mode: null } },
    { type: "review.requested", payload: { node: "impl", lastArtifactRef: "impl-a1-denied.md", objections } },
  ]);
  return store;
}

describe("attention — grant↔park fold", () => {
  it("links the proposed grant onto the review item and suppresses the standalone row", () => {
    const store = parkedStore([ALLOWLIST_LINE("clio", "Bash")]);
    store.insertAction(grantAction("act-1", "clio", "Bash"));
    const items = buildAttentionView(store, undefined, NOW);
    const review = items.find((i) => i.kind === "review")!;
    expect(review.grants).toEqual([{ id: "act-1", role: "clio", tool: "Bash" }]);
    expect(items.filter((i) => i.kind === "approval")).toHaveLength(0);
  });

  it("an expired grant is neither linked nor listed", () => {
    const store = parkedStore([ALLOWLIST_LINE("clio", "Bash")]);
    store.insertAction(grantAction("act-2", "clio", "Bash", { expires_at: "2026-07-13T09:59:00.000Z" }));
    const items = buildAttentionView(store, undefined, NOW);
    expect(items.find((i) => i.kind === "review")!.grants).toBeUndefined();
    expect(items.filter((i) => i.kind === "approval")).toHaveLength(0);
  });

  it("a guard-layer park links nothing; an unmatched grant stays a standalone row", () => {
    const store = parkedStore([GUARD_LINE]);
    store.insertAction(grantAction("act-3", "hera", "WebSearch"));
    const items = buildAttentionView(store, undefined, NOW);
    expect(items.find((i) => i.kind === "review")!.grants).toBeUndefined();
    expect(items.filter((i) => i.kind === "approval").map((i) => i.id)).toEqual(["act-3"]);
  });

  it("a multi-wall park carries every matching grant on one row", () => {
    const store = parkedStore([ALLOWLIST_LINE("clio", "Bash"), ALLOWLIST_LINE("clio", "WebSearch")]);
    store.insertAction(grantAction("act-4", "clio", "Bash"));
    store.insertAction(grantAction("act-5", "clio", "WebSearch"));
    const items = buildAttentionView(store, undefined, NOW);
    const review = items.find((i) => i.kind === "review")!;
    expect(review.grants?.map((g) => g.id).sort()).toEqual(["act-4", "act-5"]);
    expect(items.filter((i) => i.kind === "approval")).toHaveLength(0);
  });

  it("a non-grant proposed action is never folded", () => {
    const store = parkedStore([ALLOWLIST_LINE("clio", "Bash")]);
    store.insertAction(grantAction("act-6", "clio", "Bash", { type: "test.echo", payload: "{}" }));
    const items = buildAttentionView(store, undefined, NOW);
    expect(items.find((i) => i.kind === "review")!.grants).toBeUndefined();
    expect(items.filter((i) => i.kind === "approval").map((i) => i.id)).toEqual(["act-6"]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/attention-grants.test.ts`
Expected: FAIL — `review.grants` is `undefined` in the link tests, and the standalone approval rows are present where the tests expect none.

- [ ] **Step 4: Implement linking + fold** — in `src/web/attention-view.ts`, replace the body of `buildAttentionView` from the `items`/`nowIso` declarations through the end of the approvals loop (current lines 23–50) with reviews-first + fold; the rest of the function is untouched:

```ts
  const items: AttentionItem[] = [];
  const nowIso = now().toISOString();

  // 2 — nodes parked at a quality cap awaiting a verdict (verification-hardening §4).
  // Built before approvals: a policy-wall park's auto-proposed permission.grant folds into
  // its review row (one human decision, one row — triage-inbox spec §A), matched by the
  // exact denial line workers.ts writes into the objections.
  const linkedGrantIds = new Set<string>();
  const proposedGrants = store.listActions("proposed", 200)
    .filter((a) => a.type === "permission.grant" && a.expires_at > nowIso)
    .map((a) => {
      const p = JSON.parse(a.payload) as { role?: string; tool?: string };
      return { id: a.id, role: p.role ?? "", tool: p.tool ?? "" };
    });
  for (const n of store.needsReviewNodes()) {
    const grants = proposedGrants.filter((g) =>
      (n.error ?? "").includes(`${g.role} was denied: ${g.tool} (not in allowlist)`));
    for (const g of grants) linkedGrantIds.add(g.id);
    items.push({
      kind: "review", id: `${n.goal_id}:${n.node_key}`,
      title: `${n.goal_title} · ${n.node_key} hit its quality cap`,
      meta: firstLine(n.error ?? "no objections recorded"),
      severity: 2, ts: n.finished_at ?? nowIso,
      actions: ["accept", "retry", "abandon", "open"],
      ref: {
        goalId: n.goal_id, node: n.node_key, slug: n.goal_slug,
        ...(n.artifact ? { artifact: n.artifact } : {}),
      },
      ...(grants.length ? { grants } : {}),
    });
  }

  // 1 — approvals (proposed, not yet expired; the sweep is lazy so filter here too).
  // Grants folded into a review row above are skipped — resolving them happens there.
  for (const a of store.listActions("proposed", 100)) {
    if (a.expires_at <= nowIso) continue;
    if (linkedGrantIds.has(a.id)) continue;
    items.push({
      kind: "approval", id: a.id, title: firstLine(a.preview),
      meta: `${a.type} · expires ${a.expires_at.slice(5, 16).replace("T", " ")}`,
      severity: 1, ts: a.created_at, actions: ["approve", "reject", "open"],
      ref: { actionId: a.id },
    });
  }
```

Delete the old standalone review loop (the former "2 — nodes parked" block) so reviews are not pushed twice. The final `items.sort(...)` keeps severity order regardless of push order. Note: a grant matching two parked nodes rides both rows; the second fusion's approve then errors ("already resolved") and the user falls back to plain Retry — accepted edge (spec §C).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/attention-grants.test.ts test/attention-view.test.ts test/attention-review.test.ts`
Expected: PASS — all three files (existing review/ordering tests unaffected).

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/web/dto.ts src/web/attention-view.ts test/attention-grants.test.ts
git commit -m "feat(web): fold a park's proposed grant into its review row"
```

---

### Task 3: UI — Reopen from the inbox (row verb + canvas guidance)

**Files:**
- Modify: `ui2/src/views/Home.tsx`, `ui2/src/views/Queue.tsx`, `ui2/src/views/canvas/Goal.tsx`, `ui2/src/views/canvas/index.tsx`

**Interfaces:**
- Consumes: Task 1's `reopen` verb on failed-goal items; existing `api.goalAction(id, "reopen", { guidance }?)`.
- Produces: nothing downstream — terminal UI.

- [ ] **Step 1: Row verb** — `ui2/src/views/Home.tsx`: in `act()`, add `"reopen"` to the optimistic array and a branch after the `resume` branch:

```ts
    const optimistic = ["approve", "reject", "read", "abandon", "resume", "accept", "retry", "reopen"].includes(verb);
```

```ts
      else if (verb === "resume") await api.goalAction(item.ref.goalId, "resume");
      else if (verb === "reopen") await api.goalAction(item.ref.goalId, "reopen");
```

- [ ] **Step 2: Row label** — `ui2/src/views/Queue.tsx`: add to `ACTION_LABEL`:

```ts
  accept: "Accept", retry: "Retry", reopen: "Reopen",
```

- [ ] **Step 3: Canvas guidance** — `ui2/src/views/canvas/index.tsx`: pass `onDone` to `GoalCanvas`:

```tsx
    case "goal": return <GoalCanvas item={item} events={events} onAct={onAct} onOpenChat={onOpenChat} onDone={onDone} />;
```

Then in `ui2/src/views/canvas/Goal.tsx`: add `useState` import, `onDone` prop, guidance state, and a Reopen block. Full changed regions:

```tsx
import { useState } from "react";
```

```tsx
export function GoalCanvas({ item, events, onAct, onOpenChat, onDone }: {
  item: AttentionItem; events: StoredEvent[];
  onAct: (i: AttentionItem, verb: string) => void;
  onOpenChat: (t: string, s?: string) => void;
  onDone: () => void;
}) {
  const { data: goal } = useLiveQuery(() => api.goal(item.ref.goalId), events, T.goals, [item.ref.goalId]);
  const [guidance, setGuidance] = useState("");
  const [error, setError] = useState("");
  if (!goal) return <Empty>Loading…</Empty>;
  const failedNode = goal.nodes.find((n) => n.status === "failed");
  const cost = goal.nodes.reduce((s, n) => s + n.costCents, 0);
  const canReopen = item.actions.includes("reopen");
  const reopen = async () => {
    setError("");
    try {
      await api.goalAction(item.ref.goalId, "reopen", guidance.trim() ? { guidance } : undefined);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
```

And in the JSX, between `<MiniDag …/>` and the button row:

```tsx
      {canReopen && (
        <textarea
          value={guidance} onChange={(e) => setGuidance(e.target.value)} rows={3}
          placeholder="Guidance for the reopen (optional — failed nodes restart fresh with this in their brief)"
          className="w-full bg-raised rounded p-2 text-[13px]"
        />
      )}
      <div className="flex gap-2 flex-wrap">
        <Button variant="primary" onClick={() => navigate(`goals/${goal.slug}`)}>Open in Goals</Button>
        {canReopen && <Button variant="primary" onClick={() => void reopen()}>Reopen</Button>}
        {item.actions.includes("resume") && <Button onClick={() => onAct(item, "resume")}>Resume</Button>}
        <TwoStepButton label="Abandon" onConfirm={() => onAct(item, "abandon")} />
        <Button onClick={() => onOpenChat(goal.lead, `About goal "${goal.title}" (${goal.status}): `)}>Discuss ⌘J</Button>
      </div>
      {error && <div className="text-[12px] text-err">{error}</div>}
```

- [ ] **Step 4: Build + typecheck**

Run: `(cd ui2 && npx tsc --noEmit && npm run build)`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add ui2/src/views/Home.tsx ui2/src/views/Queue.tsx ui2/src/views/canvas/Goal.tsx ui2/src/views/canvas/index.tsx
git commit -m "feat(ui2): reopen a failed goal from the inbox, guidance included"
```

---

### Task 4: UI — "Approve grant & Retry" fusion on the review canvas

**Files:**
- Modify: `ui2/src/views/canvas/Review.tsx`

**Interfaces:**
- Consumes: `item.grants` (Task 2), `api.resolveAction(id, "approve")`, `api.resolveReview(goalId, node, "retry", guidance?)`.

- [ ] **Step 1: Add fusion** — in `ui2/src/views/canvas/Review.tsx`, after the `resolve` function add:

```tsx
  const grants = item.grants ?? [];
  const approveAndRetry = async () => {
    setError("");
    try {
      for (const g of grants) await api.resolveAction(g.id, "approve");
      await api.resolveReview(item.ref.goalId, item.ref.node, "retry", guidance.trim() ? guidance : undefined);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
```

And in the JSX, replace the button row with:

```tsx
      {grants.length > 0 && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {grants.map((g) => (
            <span key={g.id} className="text-[11px] bg-raised rounded px-2 py-1">grant: {g.role} → {g.tool}</span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        {grants.length > 0 && (
          <Button variant="primary" onClick={() => void approveAndRetry()}>Approve grant & Retry</Button>
        )}
        <Button variant={grants.length ? "ghost" : "primary"} onClick={() => void resolve("accept")}>Accept with waiver</Button>
        <Button variant="ghost" onClick={() => void resolve("retry")}>Retry</Button>
        <TwoStepButton label="Abandon node" onConfirm={() => void resolve("abandon")} />
      </div>
```

(When grants exist the fusion is the primary action; Accept demotes to ghost. Partial failure — grants approved, retry throws — surfaces in the existing `error` line; plain Retry then recovers, per spec §C.)

- [ ] **Step 2: Build + typecheck**

Run: `(cd ui2 && npx tsc --noEmit && npm run build)`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui2/src/views/canvas/Review.tsx
git commit -m "feat(ui2): one-click approve-grant-and-retry on a parked review"
```

---

### Task 5: Full verification + deploy

**Files:** none new.

- [ ] **Step 1: Full suite + both typechecks**

Run: `npx vitest run` → Tests summary ≥ 1522 passed (+2 skipped), 195 files (baseline 194 + attention-grants).
Run: `npx tsc --noEmit` and `(cd ui2 && npx tsc --noEmit)` → both clean.

- [ ] **Step 2: Deploy**

```bash
(cd ui2 && npm run build)
npm run build && launchctl kickstart -k gui/501/com.ihab.aios
```

- [ ] **Step 3: Live sanity** — `TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)`; `curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4280/api/attention | head -c 2000` — expect valid JSON; any failed goal row carries `"reopen"` in `actions`.

- [ ] **Step 4: Push + hand to user** — `git push`, then ask the user to click **Reopen** on a failed goal in the browser once (retires ⑮'s never-clicked button); the next real park exercises fusion live.
