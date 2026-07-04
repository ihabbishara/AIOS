# Phase 4b — Agent Mailbox UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the agent mailbox in Mission Control — a Mail section on each agent profile and a "spawned by mail" provenance link on goal detail — consuming the already-shipped 4a backend, with zero server changes.

**Architecture:** Pure React client work in `ui/src/`. The §9 backend is already live: `GET /api/mail?agent=&limit=` (`buildMailView`, alias-canonicalized), `buildGoalDetail.spawnedBy: {mailId, from} | null`, and `mail.*` events on the unfiltered `/api/stream` SSE. 4b adds the fetch surface to `api.ts`, a Mail section to `Org.tsx`'s `AgentProfile`, a provenance line to `Goals.tsx`'s `GoalDetailView`, and one deep-link (`agentTarget`) in `App.tsx` mirroring the existing `goalTarget` idiom.

**Tech Stack:** React 19, TypeScript 5.8, Tailwind v4 (existing HUD utility classes: `hud`, `label`, `text-dim`, `text-phosphor`, `text-amber`, `text-cyan`, `text-violet`, `text-alert`, `border-line`). Vite build. No test runner in `ui/` and none is being added.

## Global Constraints

- **No new npm deps.** `ui/` deps are `react` + `react-dom` only; keep it that way.
- **No server changes.** All of §9's backend already exists and is deployed. If a task appears to need a backend edit, stop — it means the client is wrong.
- **`ui/` has no test runner.** Verification for every task = `cd ui && npx tsc --noEmit` (clean) + `npm run build` (succeeds), plus a live-smoke against the running daemon for tasks with runtime behavior. Do **not** add vitest/jest to `ui/`.
- **Follow existing idioms verbatim:** the `usePoll(fn, [deps])` + `lastEvt` live-refresh pattern; the `target`/`onConsume*` deep-link pattern; existing HUD tailwind classes. No new abstractions.
- **Canonical names:** `from`/`to` in `MailView` are canonical agent names (server stores them canonical); `AgentProfileInfo.name` is canonical. Compare directly against `p.name` — do not re-canonicalize client-side.
- **Unread = `readAt === null` on received mail** (`to === p.name`). Covers both `queued` requests and `unread` notes; `read_at` is stamped at delivery/injection.
- Daemon: launchd `com.ihab.aios`, Mission Control `http://localhost:4280` (token: `grep AIOS_UI_TOKEN .env`).

---

### Task 1: API client surface — `MailView`, `api.mail()`, `spawnedBy` on `GoalDetail`

**Files:**
- Modify: `ui/src/api.ts` (add interface near the other view interfaces ~line 118; extend `GoalDetail` ~line 134; add method to `api` object ~line 167)

**Interfaces:**
- Consumes: nothing (leaf).
- Produces:
  - `interface MailView { id: string; from: string; to: string; kind: string; status: string; body: string; goalId: string | null; chainDepth: number; createdAt: string; readAt: string | null; error: string | null }`
  - `GoalDetail` gains `spawnedBy: { mailId: string; from: string } | null`
  - `api.mail(agent?: string, limit?: number): Promise<MailView[]>`

- [ ] **Step 1: Add the `MailView` interface**

Insert after the `GoalDetail`/`BudgetInfo` block (after line 138 `export interface BudgetInfo ...`), mirroring the backend `MailView` in `src/web/goals-view.ts:60-63`:

```ts
export interface MailView {
  id: string; from: string; to: string; kind: string; status: string; body: string;
  goalId: string | null; chainDepth: number; createdAt: string; readAt: string | null; error: string | null;
}
```

- [ ] **Step 2: Add `spawnedBy` to `GoalDetail`**

Change the `GoalDetail` interface (currently line 134-136):

```ts
export interface GoalDetail extends GoalView {
  artifacts: Array<{ file: string; content: string }>;
  spawnedBy: { mailId: string; from: string } | null;
}
```

- [ ] **Step 3: Add the `api.mail` method**

Inside the `api` object, right after the `goal` / `goalAction` entries (after line 169), add:

```ts
  mail: (agent?: string, limit = 50) =>
    request<MailView[]>(`/api/mail?${agent ? `agent=${encodeURIComponent(agent)}&` : ""}limit=${limit}`),
```

- [ ] **Step 4: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: clean (no output, exit 0).

- [ ] **Step 5: Build**

Run: `cd ui && npm run build`
Expected: `vite build` succeeds, `✓ built in …`.

- [ ] **Step 6: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(ui): mail API client surface — MailView, api.mail(), GoalDetail.spawnedBy"
```

---

### Task 2: Mail section on the agent profile

**Files:**
- Modify: `ui/src/views/Org.tsx` (thread `events` into `AgentProfile`; add a `MailSection` component; render it inside `AgentProfile`)

**Interfaces:**
- Consumes: `api.mail(name)` and `MailView` from Task 1; `StoredEvent` (already imported); `usePoll` (already imported).
- Produces: `AgentProfile` now accepts `events: StoredEvent[]` and `onOpenGoal: (slug: string, nodeKey: string | null) => void`.

- [ ] **Step 1: Pass `events` + `onOpenGoal` into `AgentProfile` from the `Org` list view**

In `Org`, the drill-in render is currently (line 25):

```tsx
  if (selected) return <AgentProfile name={selected} onBack={() => setSelected(null)} onOpenChat={onOpenChat} />;
```

Change to:

```tsx
  if (selected) return <AgentProfile name={selected} events={events} onBack={() => setSelected(null)} onOpenChat={onOpenChat} onOpenGoal={onOpenGoal} />;
```

- [ ] **Step 2: Widen the `AgentProfile` signature**

Change the `AgentProfile` function signature (line 82-84) to accept the two new props:

```tsx
function AgentProfile({ name, events, onBack, onOpenChat, onOpenGoal }: {
  name: string; events: StoredEvent[]; onBack: () => void;
  onOpenChat: (name: string) => void; onOpenGoal: (slug: string, nodeKey: string | null) => void;
}) {
```

- [ ] **Step 3: Add the `MailSection` component**

Add at the end of `Org.tsx` (after the `AgentProfile` function). Kind→color map, sent/received split on canonical `name`, unread badge, live-refresh on `mail.*` events, click a goal-spawning mail to open its goal:

```tsx
const MAIL_KIND: Record<string, string> = {
  request: "text-amber", note: "text-dim", report: "text-cyan", standup: "text-violet", refused: "text-alert",
};

function MailSection({ name, events, onOpenGoal }: {
  name: string; events: StoredEvent[]; onOpenGoal: (slug: string, nodeKey: string | null) => void;
}) {
  const lastMailEvt = useMemo(
    () => events.filter((e) => e.event.type.startsWith("mail.")).at(-1)?.id,
    [events],
  );
  const { data: mail } = usePoll(() => api.mail(name), [name, lastMailEvt]);
  if (!mail) return null;

  const received = mail.filter((m) => m.to === name);
  const unread = received.filter((m) => m.readAt === null).length;

  return (
    <div className="hud p-4">
      <div className="label mb-2 flex items-center gap-2">
        Mail
        {unread > 0 && <span className="text-[9px] text-void bg-amber px-1.5 rounded-full">{unread}</span>}
      </div>
      {mail.length === 0 && <div className="text-[11px] text-dim">no mail</div>}
      {mail.map((m) => {
        const sent = m.from === name;
        const isUnread = !sent && m.readAt === null;
        return (
          <div key={m.id} className="text-[11px] flex gap-2 items-baseline py-0.5">
            <span className="text-dim w-24 shrink-0">{m.createdAt.slice(5, 16).replace("T", " ")}</span>
            <span className="text-dim w-4 shrink-0">{sent ? "→" : "←"}</span>
            <span className="text-fg w-16 shrink-0 truncate">{sent ? m.to : m.from}</span>
            <span className={`w-14 shrink-0 ${MAIL_KIND[m.kind] ?? "text-dim"}`}>{m.kind}</span>
            <span className={`truncate ${isUnread ? "text-bright" : "text-dim"}`}>{m.body}</span>
            {m.goalId && (
              <span
                onClick={() => onOpenGoal(m.goalId!, null)}
                className="ml-auto shrink-0 text-amber underline decoration-dotted cursor-pointer hover:text-bright"
              >▸ goal</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Render `MailSection` inside `AgentProfile`**

Insert the Mail section into the `AgentProfile` return, right after the "Effective tools" `hud` block (after line 129 `</div>` that closes the tools block, before the `p.trust.length > 0` block):

```tsx
      <MailSection name={p.name} events={events} onOpenGoal={onOpenGoal} />
```

- [ ] **Step 5: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Build**

Run: `cd ui && npm run build`
Expected: succeeds.

- [ ] **Step 7: Live smoke**

Deploy the built UI and exercise it against the running daemon:

```bash
cd /Users/ihabbishara/projects/AIOS && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios
TOKEN=$(grep '^AIOS_UI_TOKEN=' .env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:4280/api/mail?agent=hermes" | head -c 400
```

Expected: JSON array of `MailView` objects for hermes (the live-smoked mail loop left hermes with at least one report). Then open `http://localhost:4280`, org tab → click **hermes** → confirm the **Mail** section renders the report row (kind-tagged, `←` from vulcan or similar), and the unread badge count matches rows with no `read_at`.

- [ ] **Step 8: Commit**

```bash
git add ui/src/views/Org.tsx
git commit -m "feat(ui): Mail section on agent profile — sent/received, kind tags, unread badge, goal link"
```

---

### Task 3: Goal-detail provenance link + cross-view agent nav

**Files:**
- Modify: `ui/src/App.tsx` (add `agentTarget` state + `openAgent`; wire into `Org` and `Goals`)
- Modify: `ui/src/views/Org.tsx` (accept + consume `agentTarget` to auto-open a profile)
- Modify: `ui/src/views/Goals.tsx` (thread `onOpenAgent`; render provenance line in `GoalDetailView`)

**Interfaces:**
- Consumes: `GoalDetail.spawnedBy` from Task 1; the existing `target`/`onConsumeTarget` idiom.
- Produces:
  - `App` exposes `openAgent(name: string)` → switches to org tab + sets `agentTarget`.
  - `Org` accepts `agentTarget: string | null` and `onConsumeAgentTarget: () => void`.
  - `Goals` accepts `onOpenAgent: (name: string) => void`, threaded to `GoalDetailView`.

- [ ] **Step 1: Add `agentTarget` state + `openAgent` in `App`**

After the `goalTarget` lines (line 25-27), add the mirror:

```tsx
  const [agentTarget, setAgentTarget] = useState<string | null>(null);
  const openAgent = (name: string) => { setAgentTarget(name); setTab("org"); };
  const consumeAgentTarget = useCallback(() => setAgentTarget(null), []);
```

- [ ] **Step 2: Wire the new props into `Org` and `Goals` in `App`**

Change the Org mount (line 92):

```tsx
          <div className={tab === "org" ? "h-full" : "hidden"}><Org events={events} onOpenChat={openChat} onOpenGoal={openGoal} agentTarget={agentTarget} onConsumeAgentTarget={consumeAgentTarget} /></div>
```

Change the Goals mount (line 95):

```tsx
            <Goals events={events} target={goalTarget} onConsumeTarget={consumeGoalTarget} onOpenAgent={openAgent} />
```

- [ ] **Step 3: `Org` accepts + consumes `agentTarget`**

Change the `Org` signature (line 14-16) and add a consume effect. New signature:

```tsx
export function Org({ events, onOpenChat, onOpenGoal, agentTarget, onConsumeAgentTarget }: {
  events: StoredEvent[]; onOpenChat: (name: string) => void; onOpenGoal: (slug: string, nodeKey: string | null) => void;
  agentTarget: string | null; onConsumeAgentTarget: () => void;
}) {
```

Add `useEffect` to the imports (line 2 currently `import { useMemo, useState } from "react";`):

```tsx
import { useEffect, useMemo, useState } from "react";
```

Add the consume effect immediately after the `const [selected, setSelected] = useState<string | null>(null);` line (line 23):

```tsx
  useEffect(() => {
    if (!agentTarget) return;
    setSelected(agentTarget);
    onConsumeAgentTarget();
  }, [agentTarget, onConsumeAgentTarget]);
```

- [ ] **Step 4: `Goals` threads `onOpenAgent` to `GoalDetailView`**

Change the `Goals` signature (line 39-41):

```tsx
export function Goals({ events, target, onConsumeTarget, onOpenAgent }: {
  events: StoredEvent[]; target: GoalTarget | null; onConsumeTarget: () => void; onOpenAgent: (name: string) => void;
}) {
```

Change the `GoalDetailView` render (line 59-60) to pass it through:

```tsx
      <GoalDetailView idOrSlug={selected} events={events} initialNode={initialNode} onOpenAgent={onOpenAgent}
        onBack={() => { setSelected(null); setInitialNode(null); }} />
```

- [ ] **Step 5: `GoalDetailView` accepts `onOpenAgent` and renders the provenance line**

Change the `GoalDetailView` signature (line 114-116):

```tsx
function GoalDetailView({ idOrSlug, events, initialNode, onOpenAgent, onBack }: {
  idOrSlug: string; events: StoredEvent[]; initialNode: string | null;
  onOpenAgent: (name: string) => void; onBack: () => void;
}) {
```

Add the provenance line right after the plan-summary line (line 169 `<div className="text-[11px] text-dim">{goal.planSummary}</div>`):

```tsx
      {goal.spawnedBy && (
        <div
          onClick={() => onOpenAgent(goal.spawnedBy!.from)}
          className="text-[11px] text-cyan underline decoration-dotted cursor-pointer hover:text-bright w-fit"
        >
          ← spawned by mail from {goal.spawnedBy.from}
        </div>
      )}
```

- [ ] **Step 6: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Build**

Run: `cd ui && npm run build`
Expected: succeeds.

- [ ] **Step 8: Live smoke**

```bash
cd /Users/ihabbishara/projects/AIOS && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios
TOKEN=$(grep '^AIOS_UI_TOKEN=' .env | cut -d= -f2)
# find a mail-spawned goal: its planSummary starts with the MAIL_PREFIX and spawnedBy is non-null
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:4280/api/goals" | grep -o '"slug":"[^"]*"' | head
```

Expected: open `http://localhost:4280` → goals tab → open the goal that was spawned from hermes→vulcan mail → confirm the **"← spawned by mail from vulcan"** line renders under the header, and clicking it lands on vulcan's profile with the Mail section showing that mail. (If no mail-spawned goal exists live, send one via the `aios-mail` MCP `send_mail` from hermes, wait for the pump, then re-check.)

- [ ] **Step 9: Commit**

```bash
git add ui/src/App.tsx ui/src/views/Org.tsx ui/src/views/Goals.tsx
git commit -m "feat(ui): goal-detail 'spawned by mail from X' provenance link → agent profile"
```

---

## Self-Review

**Spec §9 coverage:**
- "Agent profile gains a Mail section (sent/received, kind-tagged, unread badge)" → Task 2 (`MailSection`: `sent`/`received` split, `MAIL_KIND` tags, unread badge). ✓
- "Goal detail header shows '← spawned by mail from <agent>' (provenance link)" → Task 3 (clickable line → `onOpenAgent`). ✓
- "Standups surface via the existing brief; no separate inbox tab in v1" → nothing to build; deliberately no new tab. ✓
- API (`/api/mail?agent=&limit=`, `mail.*` SSE, `buildGoalDetail.spawnedBy`) → already shipped in 4a; Task 1 only adds the client binding. ✓

**Placeholder scan:** none — every code step is concrete.

**Type consistency:** `MailView` (Task 1) matches `src/web/goals-view.ts:60-63`. `spawnedBy: { mailId, from }` shape matches `goals-view.ts:54`. `onOpenAgent: (name: string) => void` and `onOpenGoal: (slug, nodeKey) => void` used consistently across App/Org/Goals. `usePoll` deps `[name, lastMailEvt]` matches the established `lastEvt` idiom.

**Deliberate skips (ponytail):**
- No live goal→mail linking beyond `goalId` button and provenance line — no full inbox tab (spec says none in v1).
- No client re-canonicalization of aliases — server already canonicalizes; comparing against `p.name` is correct.
- Provenance is a real navigating link (not dead text) because the `target`/`onConsume` idiom already exists; if nav proves fiddly in execution, it can degrade to a `text-cyan` label with no `onClick`.
