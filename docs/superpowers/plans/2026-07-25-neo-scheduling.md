# Neo Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Neo can create, list, edit, and delete recurring routines from chat, and a fired reminder is routed through Neo (execute-or-relay) instead of being a dead text ping.

**Architecture:** Four routine CRUD tools are added to the moderator MCP server, reusing the Schedule UI's existing validators (`validateRoutineBody`/`parseRecurrence`) and store methods — one source of truth. Reminder firing switches from `notify()`'s `⏰ Reminder:` send to a new `makeReminderFire` that injects a framed prompt through `onMessage`, mirroring how `makeRoutineFire` already works; the `reminder.due` triage verdict becomes `ignore` so it can't double-notify.

**Tech Stack:** TypeScript, vitest, existing AIOS heartbeat/moderator/registry modules.

**Spec:** `docs/superpowers/specs/2026-07-25-neo-scheduling-design.md`

## Global Constraints

- No new npm dependencies.
- Trunk-based: commit on main, EXPLICIT file paths only in `git add` (a parallel session shares this checkout).
- **MARCO HAZARD (live, unresolved):** `agents/life/marco.yaml` is deleted in the working tree (retired via the daemon, UNCOMMITTED) but present at committed HEAD. `scripts/gen-org-golden.ts` reads the WORKING TREE. Before any golden regen: `git checkout HEAD -- agents/life/marco.yaml`; after verifying, `rm agents/life/marco.yaml` to restore the as-found tree before deploying. NEVER `git add agents/life/marco.yaml` or `agents/_retired/`.
- Recurrence kinds and their required fields: `daily`/`weekdays` → `hhmm`; `weekly` → `hhmm` + `dow` (0=Sun..6=Sat); `interval` → `every_minutes`. `hhmm` is `HH:MM` 24h local time.
- `store.addRoutine`/`updateRoutine` take `recurrence` as a **normalized JSON string** — always the `fields.recurrence` that `validateRoutineBody` produces, never a hand-built string.
- Read vitest's "Tests" summary line, not exit codes. `npx tsc --noEmit` must be clean in both roots.
- Deploy: `npm run build && launchctl kickstart -k gui/501/com.ihab.aios`, poll `/api/state`.

---

### Task 1: `makeReminderFire` + tests

**Files:**
- Modify: `src/heartbeat/routines.ts` (append after `makeRoutineFire`, ~:135)
- Test: `test/routines.test.ts` (append a new describe block)

**Interfaces:**
- Consumes: `RoutineFireDeps` shape already in the file (`onMessage`, `primaryChat?`, `log`) — reused as-is.
- Produces: `makeReminderFire(deps: RoutineFireDeps): (ev: { id: number; text: string; channel: string; chatId: string }) => void`. Task 2 wires it in `src/index.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `test/routines.test.ts`:

```ts
describe("makeReminderFire", () => {
  const ev = { id: 7, text: "pay the electricity bill", channel: "", chatId: "" };

  it("injects a framed prompt at the event origin", async () => {
    const onMessage = vi.fn(async () => {});
    makeReminderFire({ onMessage, log: () => {} })({ ...ev, channel: "telegram", chatId: "42" });
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    const msg = onMessage.mock.calls[0][0] as { channel: string; chatId: string; text: string };
    expect(msg.channel).toBe("telegram");
    expect(msg.chatId).toBe("42");
    expect(msg.text).toContain("pay the electricity bill");
    expect(msg.text).toContain("Scheduled reminder");   // the frame
    expect(msg.text).toContain("relay");                // the decide-instruction
  });

  it("falls back to primary chat when origin is empty", async () => {
    const onMessage = vi.fn(async () => {});
    makeReminderFire({ onMessage, primaryChat: { channel: "slack", chatId: "C1" }, log: () => {} })(ev);
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    const msg = onMessage.mock.calls[0][0] as { channel: string; chatId: string };
    expect(msg).toMatchObject({ channel: "slack", chatId: "C1" });
  });

  it("no origin and no primary chat → logged skip, no dispatch", () => {
    const onMessage = vi.fn(async () => {});
    const lines: string[] = [];
    makeReminderFire({ onMessage, log: (l) => lines.push(l) })(ev);
    expect(onMessage).not.toHaveBeenCalled();
    expect(lines[0]).toContain("reminder 7");
  });
});
```

Add `makeReminderFire` to the existing import on line 3 of that file:

```ts
import { parseRecurrence, routineDue, nextFire, makeRoutineFire, makeReminderFire, type RoutineLike } from "../src/heartbeat/routines.js";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routines.test.ts -t "makeReminderFire"`
Expected: FAIL — `makeReminderFire` is not exported / not a function.

- [ ] **Step 3: Implement**

Append to `src/heartbeat/routines.ts`:

```ts
/** The frame wrapped around a fired reminder's text. Neo decides per-reminder:
 *  a task gets carried out, a plain nudge gets relayed. */
export function reminderPrompt(text: string): string {
  return `[Scheduled reminder you set earlier] ${text}\n\n` +
    "If this is a task to carry out, do it now and report the result. " +
    "If it is just a nudge, relay it to me in one short line.";
}

/**
 * The reminder.due subscriber body (spec 2026-07-25). Mirrors makeRoutineFire:
 * a fired reminder is injected into the kernel as a synthetic inbound message
 * instead of being sent as a dead "⏰ Reminder:" ping, so the coordinator can
 * actually execute a task reminder. Origin falls back to the primary chat;
 * with neither, the fire is dropped with a log line.
 */
export function makeReminderFire(deps: RoutineFireDeps) {
  return (ev: { id: number; text: string; channel: string; chatId: string }): void => {
    const channel = ev.channel || deps.primaryChat?.channel || "";
    const chatId = ev.chatId || deps.primaryChat?.chatId || "";
    if (!channel || !chatId) {
      deps.log(`reminder ${ev.id} skipped: no origin chat and no primary chat`);
      return;
    }
    void deps.onMessage({ channel, chatId, text: reminderPrompt(ev.text) })
      .catch((err) => deps.log(`reminder ${ev.id} failed: ${(err as Error).message}`));
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/routines.test.ts && npx tsc --noEmit`
Expected: all green (existing routine tests + 3 new), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/routines.ts test/routines.test.ts
git commit -m "feat(heartbeat): makeReminderFire — fired reminders inject a framed prompt (execute-or-relay)"
```

---

### Task 2: Wire reminder firing through the kernel

**Files:**
- Modify: `src/heartbeat/triage.ts:25-26` (default verdict)
- Modify: `src/index.ts` (import ~:43, subscriber ~:449-453, remove notify branch ~:585-588)
- Test: `test/triage.test.ts:24-25` (verdict), `test/heartbeat-e2e.test.ts` (ping → injection)

**Interfaces:**
- Consumes: `makeReminderFire` from Task 1.
- Produces: no new exports — behaviour change only. `reminder.due` no longer reaches `notify()`.

- [ ] **Step 1: Update the two failing tests first (they pin the OLD contract)**

In `test/triage.test.ts`, replace the reminder case (~:24-25):

```ts
  it("reminder.due → ignore (the fire injects a kernel message directly)", () => {
    expect(defaultVerdict({ type: "reminder.due", id: 1, text: "x", channel: "cli", chatId: "l" })).toBe("ignore");
  });
```

In `test/heartbeat-e2e.test.ts`, the local notify stub (~:28) simulates index.ts. Replace that line:

```ts
      if (e.type === "reminder.due") return send(e.channel, e.chatId, `⏰ Reminder: ${e.text}`);
```

with a comment (reminders no longer notify — they inject):

```ts
      // reminder.due is verdict "ignore" now — it injects a kernel message instead of notifying
```

Then wire the injection into the harness. Add this import at the top of the file:

```ts
import { makeReminderFire } from "../src/heartbeat/routines.js";
```

Immediately after `triage.start();`, add:

```ts
    // index.ts-style reminder wiring: fires inject an inbound message (spec 2026-07-25)
    const injected: Array<{ channel: string; chatId: string; text: string }> = [];
    const reminderFire = makeReminderFire({
      onMessage: async (m) => { injected.push({ channel: m.channel, chatId: m.chatId, text: m.text }); },
      log: () => {},
    });
    bus.on((e) => { if (e.event.type === "reminder.due") reminderFire(e.event); });
```

Replace the ping assertion block (the `const pings = sent.filter((s) => s.text.startsWith("⏰"));` group) with:

```ts
    // reminder injected as a framed prompt at its ORIGIN chat (not a ping)
    expect(injected).toHaveLength(1);
    expect(injected[0]).toMatchObject({ channel: "telegram", chatId: "42" });
    expect(injected[0].text).toContain("stretch");
    expect(store.listReminders("fired")).toHaveLength(1);
```

- [ ] **Step 2: Run the two tests to verify they fail**

Run: `npx vitest run test/triage.test.ts test/heartbeat-e2e.test.ts`
Expected: FAIL — triage still returns `notify_now`; the e2e injection array is empty (nothing wired yet in the source).

- [ ] **Step 3: Change the triage default verdict**

In `src/heartbeat/triage.ts`, replace:

```ts
    case "reminder.due":
      return "notify_now";
```

with:

```ts
    case "reminder.due":
      return "ignore"; // fires inject a kernel message directly — a ping here would double-notify
```

- [ ] **Step 4: Wire the subscriber and drop the notify branch in index.ts**

In `src/index.ts`, extend the routines import (~:43):

```ts
import { makeRoutineFire, makeReminderFire } from "./heartbeat/routines.js";
```

After the existing routine subscriber block (~:449-453), add:

```ts
  // Reminders inject a framed prompt too — the coordinator executes a task reminder
  // or relays a plain nudge (spec 2026-07-25).
  const reminderFire = makeReminderFire({ onMessage, primaryChat: config.primaryChat, log });
  bus.on((e) => {
    if (e.event.type === "reminder.due") reminderFire(e.event);
  });
```

Remove the now-dead branch from `notify()` (~:585-588) — delete these four lines:

```ts
    if (e.type === "reminder.due") {
      await sendVia(e.channel, e.chatId, `⏰ Reminder: ${e.text}`);
      return;
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/triage.test.ts test/heartbeat-e2e.test.ts test/routines.test.ts && npx tsc --noEmit`
Expected: all green, tsc clean. (`test/store-heartbeat.test.ts` needs NO change — its `reminder.due` line stores an explicit triage RULE, which is unaffected by the default-verdict change.)

- [ ] **Step 6: Commit**

```bash
git add src/heartbeat/triage.ts src/index.ts test/triage.test.ts test/heartbeat-e2e.test.ts
git commit -m "feat(heartbeat): fired reminders route through the kernel; reminder.due verdict → ignore"
```

---

### Task 3: Routine CRUD tools on the moderator server

**Files:**
- Modify: `src/moderator/tools.ts` (imports ~:1-14, new tools before the `return`, tools array ~:454-460)
- Test: `test/moderator-routines.test.ts` (new)

**Interfaces:**
- Consumes: `validateRoutineBody` from `../web/schedule-view.js`; `nextFire`, `parseRecurrence` from `../heartbeat/routines.js`; `deps.store` (`addRoutine`/`listRoutines`/`updateRoutine`/`deleteRoutine`); `deps.origin`.
- Produces: tools `add_routine`, `list_routines`, `update_routine`, `delete_routine` → reachable as `mcp__aios__add_routine` etc. Task 4 lists them in the `coordination` capability.

- [ ] **Step 1: Write the failing tests**

Create `test/moderator-routines.test.ts`:

```ts
// test/moderator-routines.test.ts — routine CRUD tools (spec 2026-07-25).
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { buildModeratorServer, type ModeratorToolsDeps } from "../src/moderator/tools.js";
import type { VaultWriter } from "../src/vault/writer.js";
import type { ActionGate } from "../src/kernel/gate.js";
import type { GoogleAccounts } from "../src/senses/google/auth.js";
import type { GoalEngine } from "../src/engine/goals.js";

type ToolHandler = (a: unknown) => Promise<{ content: Array<{ text: string }> }>;
function handlers(server: unknown) {
  return (server as unknown as {
    instance: { _registeredTools: Record<string, { handler: ToolHandler }> };
  }).instance._registeredTools;
}
const callText = async (h: { handler: ToolHandler }, a: unknown) => (await h.handler(a)).content[0].text;

function build(store: Store) {
  const deps: ModeratorToolsDeps = {
    goals: null as unknown as GoalEngine,
    departments: [],
    store,
    vault: null as unknown as VaultWriter,
    projectsRoot: "/tmp",
    origin: { channel: "telegram", chatId: "42" },
    handOff: async () => ({ text: "" }),
    agentNames: ["maya"],
    gate: null as unknown as ActionGate,
    actionTypes: [],
    google: null as unknown as GoogleAccounts,
    memory: { halfLifeDays: 90, stalePenalty: 0.7 },
  };
  return handlers(buildModeratorServer(deps));
}

describe("routine tools", () => {
  it("add_routine stores a daily routine with the current chat as origin", async () => {
    const store = new Store(":memory:");
    const t = build(store);
    const out = await callText(t["add_routine"], {
      name: "morning news", prompt: "research and send the news", kind: "daily", hhmm: "07:00",
    });
    expect(out).toContain("07:00");
    const rows = store.listRoutines();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "morning news", prompt: "research and send the news",
      recurrence: JSON.stringify({ kind: "daily", hhmm: "07:00" }),
      origin_channel: "telegram", origin_chat_id: "42",
    });
  });

  it("add_routine refuses an invalid recurrence and writes nothing", async () => {
    const store = new Store(":memory:");
    const t = build(store);
    const out = await callText(t["add_routine"], { name: "x", prompt: "y", kind: "weekly", hhmm: "09:00" }); // dow missing
    expect(out).toContain("Refused");
    expect(store.listRoutines()).toHaveLength(0);
  });

  it("list_routines renders id, state and schedule", async () => {
    const store = new Store(":memory:");
    const t = build(store);
    await callText(t["add_routine"], { name: "standup", prompt: "post standup", kind: "weekdays", hhmm: "09:30" });
    const out = await callText(t["list_routines"], {});
    expect(out).toContain("#1");
    expect(out).toContain("standup");
    expect(out).toContain("09:30");
  });

  it("update_routine disables a routine", async () => {
    const store = new Store(":memory:");
    const t = build(store);
    await callText(t["add_routine"], { name: "n", prompt: "p", kind: "interval", every_minutes: 90 });
    const out = await callText(t["update_routine"], { id: 1, enabled: false });
    expect(out).toContain("#1");
    expect(store.listRoutines()[0].enabled).toBe(0);
  });

  it("delete_routine removes it; a missing id is reported", async () => {
    const store = new Store(":memory:");
    const t = build(store);
    await callText(t["add_routine"], { name: "n", prompt: "p", kind: "daily", hhmm: "08:00" });
    expect(await callText(t["delete_routine"], { id: 1 })).toContain("deleted");
    expect(store.listRoutines()).toHaveLength(0);
    expect(await callText(t["delete_routine"], { id: 99 })).toContain("No routine");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/moderator-routines.test.ts`
Expected: FAIL — `Cannot read properties of undefined (reading 'add_routine')` (tools not registered).

- [ ] **Step 3: Implement the tools**

In `src/moderator/tools.ts`, add these imports next to the existing ones (after the `forgetNow` import, ~:14):

```ts
import { validateRoutineBody } from "../web/schedule-view.js";
import { nextFire, parseRecurrence, type Recurrence } from "../heartbeat/routines.js";
```

Add this helper next to the other pure helpers (after `teachingDomain`, ~:51):

```ts
/** Assembles the flat tool params into a Recurrence-shaped object for validateRoutineBody.
 *  Undefined fields stay undefined so the validator reports what's missing. */
export function recurrenceFromArgs(a: {
  kind?: string; hhmm?: string; dow?: number; every_minutes?: number;
}): unknown {
  if (!a.kind) return undefined;
  return a.kind === "interval"
    ? { kind: a.kind, everyMinutes: a.every_minutes }
    : a.kind === "weekly"
      ? { kind: a.kind, dow: a.dow, hhmm: a.hhmm }
      : { kind: a.kind, hhmm: a.hhmm };
}

/** One-line human label for a stored routine row. */
export function routineLine(r: {
  id: number; name: string; prompt: string; enabled: number; recurrence: string;
}, next: string | null): string {
  const rec = parseRecurrence(r.recurrence) as Recurrence | null;
  const when = !rec ? "(unparseable)"
    : rec.kind === "interval" ? `every ${rec.everyMinutes}m`
    : rec.kind === "weekly" ? `weekly dow${rec.dow} ${rec.hhmm}`
    : `${rec.kind} ${rec.hhmm}`;
  return `#${r.id} [${r.enabled ? "on" : "off"}] ${when} — ${r.name}: ${r.prompt.slice(0, 60)}` +
    (next ? ` (next ${next})` : "");
}
```

Inside `buildModeratorServer`, add the four tools after `cancelReminder` (~:343):

```ts
  const recurrenceShape = {
    kind: z.enum(["daily", "weekdays", "weekly", "interval"]).describe("daily/weekdays need hhmm; weekly needs hhmm+dow; interval needs every_minutes"),
    hhmm: z.string().optional().describe('Local 24h time "HH:MM", e.g. "07:00"'),
    dow: z.number().int().min(0).max(6).optional().describe("Weekly only: 0=Sunday .. 6=Saturday"),
    every_minutes: z.number().int().positive().optional().describe("Interval only: minutes between runs"),
  };

  const addRoutine = tool(
    "add_routine",
    "Create a RECURRING routine: a prompt the org runs on a schedule on its own, delivered to this " +
      "chat, and visible in the Schedule view. Use this for anything repeating (\"every morning at 7…\"). " +
      "Use add_reminder only for a ONE-OFF nudge or task at a single time.",
    {
      name: z.string().describe("Short name, e.g. 'morning news'"),
      prompt: z.string().describe("What should run — written as if the user asked you directly"),
      ...recurrenceShape,
    },
    async (a) => {
      const v = validateRoutineBody({ name: a.name, prompt: a.prompt, recurrence: recurrenceFromArgs(a) }, false);
      if (!v.ok) return text(`Refused: ${v.error}`);
      const id = deps.store.addRoutine({
        name: v.fields.name!, prompt: v.fields.prompt!, recurrence: v.fields.recurrence!,
        originChannel: deps.origin.channel, originChatId: deps.origin.chatId,
      });
      const row = deps.store.getRoutine(id)!;
      return text(`Routine ${routineLine(row, nextFire(new Date(), row))} — tell the user the resolved schedule so a misparse surfaces.`);
    },
  );

  const listRoutines = tool(
    "list_routines",
    "List the recurring routines (what is scheduled to run on its own).",
    {},
    async () => {
      const rows = deps.store.listRoutines();
      if (!rows.length) return text("No routines.");
      const now = new Date();
      return text(rows.map((r) => routineLine(r, nextFire(now, r))).join("\n"));
    },
  );

  const updateRoutine = tool(
    "update_routine",
    "Edit a routine: rename, change its prompt, reschedule it, or pause/resume it with enabled.",
    {
      id: z.number(),
      name: z.string().optional(),
      prompt: z.string().optional(),
      enabled: z.boolean().optional().describe("false pauses the routine without deleting it"),
      kind: z.enum(["daily", "weekdays", "weekly", "interval"]).optional(),
      hhmm: z.string().optional(),
      dow: z.number().int().min(0).max(6).optional(),
      every_minutes: z.number().int().positive().optional(),
    },
    async (a) => {
      const body: Record<string, unknown> = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.prompt !== undefined) body.prompt = a.prompt;
      if (a.enabled !== undefined) body.enabled = a.enabled;
      if (a.kind !== undefined) body.recurrence = recurrenceFromArgs(a);
      const v = validateRoutineBody(body, true);
      if (!v.ok) return text(`Refused: ${v.error}`);
      if (!deps.store.updateRoutine(a.id, v.fields)) return text(`No routine #${a.id}.`);
      const row = deps.store.getRoutine(a.id)!;
      return text(`Updated ${routineLine(row, nextFire(new Date(), row))}`);
    },
  );

  const deleteRoutine = tool(
    "delete_routine",
    "Delete a routine permanently. To pause one instead, use update_routine with enabled false.",
    { id: z.number() },
    async (a) => text(deps.store.deleteRoutine(a.id) ? `Routine #${a.id} deleted.` : `No routine #${a.id}.`),
  );
```

Add them to the tools array (~:454-460), on the reminders line:

```ts
      addReminder, listReminders, cancelReminder, addTriageRule,
      addRoutine, listRoutines, updateRoutine, deleteRoutine,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/moderator-routines.test.ts && npx tsc --noEmit`
Expected: 5 passed, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/moderator/tools.ts test/moderator-routines.test.ts
git commit -m "feat(moderator): routine CRUD tools — add/list/update/delete via the Schedule validators"
```

---

### Task 4: Grant the capability + Neo prompt guidance

**Files:**
- Modify: `agents/_capabilities.yaml` (the `coordination` block at the end)
- Modify: `agents/operations/neo.yaml` (Rules bullet ~:62-63)
- Modify: `test/fixtures/org-golden.json` (regenerated, not hand-edited)

**Interfaces:**
- Consumes: the four tool names from Task 3, fully qualified as `mcp__aios__add_routine`, `mcp__aios__list_routines`, `mcp__aios__update_routine`, `mcp__aios__delete_routine`.
- Produces: neo's resolved tool list grows by exactly those four.

- [ ] **Step 1: Add the tools to the coordination capability**

In `agents/_capabilities.yaml`, the `coordination` block ends with:

```yaml
          mcp__aios__cancel_reminder, mcp__aios__add_triage_rule, mcp__aios__list_inbox,
          mcp__aios__read_email, mcp__aios__recall, mcp__aios__remember, mcp__aios__forget]
```

Replace those two lines with:

```yaml
          mcp__aios__cancel_reminder, mcp__aios__add_triage_rule, mcp__aios__list_inbox,
          mcp__aios__read_email, mcp__aios__recall, mcp__aios__remember, mcp__aios__forget,
          mcp__aios__add_routine, mcp__aios__list_routines, mcp__aios__update_routine,
          mcp__aios__delete_routine]
```

- [ ] **Step 2: Teach Neo reminder-vs-routine**

In `agents/operations/neo.yaml`, replace this Rules bullet (~:62-63):

```yaml
  - Handle conversational and factual asks, memory, reminders, and vault notes yourself. But NEVER
  build, code, edit files, or run things yourself — that is always a goal for the team, not inline work.
```

with:

```yaml
  - Handle conversational and factual asks, memory, reminders, routines, and vault notes yourself. But
  NEVER build, code, edit files, or run things yourself — that is always a goal for the team, not inline work.
  - Scheduling has two primitives, and picking the right one matters. A REMINDER (add_reminder) is
  ONE-OFF: it fires once at a time you set, and when it fires it comes back to you — carry it out if
  it is a task, relay it if it is just a nudge. A ROUTINE (add_routine / list_routines /
  update_routine / delete_routine) is RECURRING: it runs on its own schedule, delivers to this chat,
  and shows up in the Schedule view. Anything repeating ("every morning at 7…", "each Monday…") is a
  routine — never pack a "do this every day" instruction into a one-off reminder. When the user asks
  what is scheduled, call list_routines.
```

- [ ] **Step 3: Regenerate the golden fixture (MARCO HAZARD — read the Global Constraints)**

```bash
git checkout HEAD -- agents/life/marco.yaml   # golden must match COMMITTED agent files
npx tsx scripts/gen-org-golden.ts
git diff test/fixtures/org-golden.json
```

Expected: the ONLY change is the four `mcp__aios__*_routine(s)` entries added to **neo** (16 agents total, marco still present). Any other agent changing → STOP and investigate.

- [ ] **Step 4: Verify green**

Run: `npx vitest run test/org-golden.test.ts test/moderator-routines.test.ts && npx tsc --noEmit`
Expected: green, tsc clean.

- [ ] **Step 5: Commit (never add marco or _retired)**

```bash
git add agents/_capabilities.yaml agents/operations/neo.yaml test/fixtures/org-golden.json
git commit -m "feat(agents): grant neo routine tools; teach reminder-vs-routine in the prompt"
```

---

### Task 5: Full suite + deploy + live smoke + push

**Files:** none (verification and shipping only).

- [ ] **Step 1: Typecheck both roots + full suite**

Run: `npx tsc --noEmit && (cd ui2 && npx tsc --noEmit); npx vitest run 2>&1 | grep -E "Test Files|Tests "`
Expected: 189 files (188 + moderator-routines), ~1405 passed | 2 skipped. Unrelated failures → STOP and report.

- [ ] **Step 2: Restore the as-found tree, then deploy**

```bash
rm agents/life/marco.yaml            # marco stays retired in the RUNNING daemon
git status --short                    # expect: ` D agents/life/marco.yaml` + `?? agents/_retired/` only
npm run build && launchctl kickstart -k gui/501/com.ihab.aios
sleep 5
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 10 -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/state | head -c 80
```
Expected: JSON state (daemon healthy).

- [ ] **Step 3: Live smoke — Neo creates a routine from chat**

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 240 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/chat \
  -d '{"target":"","text":"Set up a recurring routine: every day at 07:00, research the last 24h of Middle East news and send me a short briefing. Then tell me what routines are scheduled."}' | head -c 800
```
Expected: Neo calls `add_routine` (not `add_reminder`), echoes the resolved 07:00 daily schedule, and `list_routines` reports it.

- [ ] **Step 4: Confirm it landed in the store and the Schedule view**

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 10 -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/schedule | head -c 600
```
Expected: a `routines` entry with the 07:00 daily recurrence, `enabled: true`, and a `nextFire` — i.e. it now appears in the Schedule view that was empty in the incident.

- [ ] **Step 5: Live smoke — reminder executes instead of pinging**

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 240 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/chat \
  -d '{"target":"","text":"Remind me in 2 minutes to tell me a one-line fun fact about bananas."}' | head -c 400
```
Then wait ~2.5 minutes and check delivery:
```bash
sleep 150
grep -iE "reminder|Scheduled reminder" data/aios.log | tail -5
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 10 -H "Authorization: Bearer $TOKEN" "http://localhost:4280/api/events?limit=10" | head -c 800
```
Expected: the reminder fires and Neo RESPONDS with the fun fact (an executed task), not a bare `⏰ Reminder:` echo. Confirm no `⏰ Reminder:` string appears for it.

- [ ] **Step 6: Clean up the smoke routine**

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 120 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/chat -d '{"target":"","text":"Delete the morning news routine you just created."}' | head -c 400
curl -s -m 10 -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/schedule | head -c 300
```
Expected: Neo calls `delete_routine`; the schedule no longer lists it. (This also live-proves the delete tool.)

- [ ] **Step 7: Push**

```bash
git push origin main
```
