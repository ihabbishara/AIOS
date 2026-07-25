# Neo scheduling — routine tools + actionable reminders

**Date:** 2026-07-25
**Status:** Approved (design brainstormed + verbally approved 2026-07-22; spec written 2026-07-25)
**Cycle:** ⑨

## Problem

A user asked Neo (via Telegram) for a daily 7:00am news briefing. Neo created a **reminder** whose text was an executable instruction ("pull the latest developments via web search, write the briefing, re-arm tomorrow"). At 7:00 the reminder fired — but a reminder is a passive ping: `reminder.due` does `sendVia(chat, "⏰ Reminder: <text>")` and nothing else. No search ran, no news arrived, nothing re-armed. The user then found the Schedule view empty (only *pending* reminders show; #1 had fired, #2 was cancelled, and there were zero routines).

Two root causes:

1. **Neo cannot create a routine.** AIOS's native recurring-execution primitive is the **routine** (`routines` table → heartbeat `Clock` → `routine.due` → `makeRoutineFire` injects the prompt as a synthetic inbound message, so it *executes and delivers*). But routine creation is exposed only through the Schedule UI. The moderator server (`buildModeratorServer`) gives Neo `add_reminder`/`list_reminders`/`cancel_reminder` and **no routine tool**. Lacking the right tool, Neo misused a reminder. (Note: Claude Code's `CronCreate`/`CronList` are harness tools in a different runtime; they are not AIOS and cannot be granted to Neo, whose grantable roles are `agents/_capabilities.yaml`.)

2. **A reminder only pings.** Even used correctly, a reminder can't *act*. The user chose to make reminders actionable: route a fired reminder through the kernel like a routine, so Neo can carry out a task reminder or relay a plain nudge.

## Design

### 1. Routine CRUD tools (the AIOS-native "cron grant")

Four tools added to `buildModeratorServer` (`src/moderator/tools.ts`) and listed in the `coordination` capability (`agents/_capabilities.yaml`). Each reuses the validators and store methods the Schedule UI's routes already use — one source of truth, no reimplementation.

- `add_routine(name, prompt, kind, hhmm?, dow?, every_minutes?)` — assembles a `Recurrence` object from the flat fields (`{ kind, hhmm, dow, everyMinutes: every_minutes }`), passes `{ name, prompt, recurrence }` through `validateRoutineBody(body, false)` (from `src/web/schedule-view.ts`, which calls `parseRecurrence`), then `store.addRoutine({ name, prompt, recurrence, originChannel: origin.channel, originChatId: origin.chatId })`. Origin is the current chat so the routine delivers back there. Returns the routine id + a human echo of the resolved schedule (so a misparse surfaces, same discipline as `add_reminder`). Invalid recurrence → the validator's error text, no write.
- `list_routines()` — `store.listRoutines()` formatted one per line: `#<id> [on|off] <recurrence label> — <name>: <prompt first ~60 chars>` plus next fire (`nextFire(now, r)`). Answers "what's scheduled?".
- `update_routine(id, name?, prompt?, kind?, hhmm?, dow?, every_minutes?, enabled?)` — assembles a partial body, `validateRoutineBody(body, true)`, `store.updateRoutine(id, fields)`. Covers rename, re-prompt, reschedule, and enable/disable (the `enabled` boolean is the pause toggle).
- `delete_routine(id)` — `store.deleteRoutine(id)`.

Recurrence is passed as flat tool params rather than a nested object because SDK tool schemas are flat `ZodRawShape`; the assembly + `parseRecurrence` validation keeps the union safe. `daily`/`weekdays` need `hhmm`; `weekly` needs `hhmm`+`dow` (0=Sun..6=Sat); `interval` needs `every_minutes`. Times are local (the `Clock`/`routineDue` interpret `hhmm` in local time).

### 2. Actionable reminders

A fired reminder stops being a static ping and instead injects a **framed prompt** through the same kernel entry point routines use, so Neo decides per-reminder whether to execute or relay.

- **`src/heartbeat/triage.ts`:** `defaultVerdict("reminder.due")` changes from `"notify_now"` to `"ignore"` — mirroring `routine.due`, because the fire now injects a kernel message directly and a triage ping would double-notify. (The comment moves too.)
- **`src/index.ts`:** remove the `reminder.due` branch from `notify()` (the `⏰ Reminder: ${e.text}` send). Add a bus subscriber next to `routineFire`:
  ```ts
  const reminderFire = makeReminderFire({ onMessage, primaryChat: config.primaryChat, log });
  bus.on((e) => { if (e.event.type === "reminder.due") reminderFire(e.event); });
  ```
- **`src/heartbeat/routines.ts`:** new `makeReminderFire(deps)` co-located with `makeRoutineFire` (same file — it is the "fire handlers" module and imports only pure types; `onMessage`/`primaryChat`/`log` arrive via deps). It injects `onMessage({ channel, chatId, text: FRAME })` where FRAME wraps the reminder text:
  > `[Scheduled reminder you set earlier] <text>` — newline — `If this is a task to carry out, do it now and report the result. If it is just a nudge, relay it to me in one short line.`

  Origin falls back to `primaryChat`; with neither, the fire is dropped with a log line (same posture as `makeRoutineFire`).

Neo's judgment picks the branch: a task reminder ("pay the electricity bill") runs and reports; a plain nudge ("stretch") is relayed in one line. Any outward action a reminder triggers still passes the trust gate — nothing auto-executes unsafely while the user is away.

### 3. Neo prompt guidance (`agents/operations/neo.yaml`)

Teach the reminder-vs-routine split so the misuse can't recur. In the "What you do" / "Rules" region:
- **reminder** = one-shot; fires once at a time, and when it fires you act on it or relay it.
- **routine** = recurring; you can create, list, edit, enable/disable, and delete them (`add_routine`/`list_routines`/`update_routine`/`delete_routine`), they run on their own and appear in the Schedule view.
- Rule: anything recurring → a routine; a one-shot nudge or task-at-a-time → a reminder. Never pack a "do this every day" instruction into a reminder.

## Data flow

**Routine creation:** user asks Neo "every morning at 7, research and send Middle East news" → `add_routine(name, prompt, kind:"daily", hhmm:"07:00")` → validate → `store.addRoutine(origin = this chat)` → visible in Schedule → each 07:00 the `Clock` fires `routine.due` → `makeRoutineFire` injects the prompt → Neo runs it and delivers to the chat.

**Reminder firing:** `Clock` claims a due reminder → `reminder.due` event → `reminderFire` injects `[Scheduled reminder…] <text> …` → Neo executes-or-relays → reply/attachments delivered through the normal path.

## Testing

- **New** `test/moderator-routines.test.ts`: `add_routine` assembles + validates + stores (real `Store` on a temp db, or the existing moderator-test harness); invalid recurrence (e.g. `weekly` without `dow`) is refused with no write; `list_routines` renders a created routine; `update_routine` toggles `enabled`; `delete_routine` removes it. Tool handlers via `(server).instance._registeredTools[name].handler`.
- **New** reminder-fire unit in `test/routines.test.ts` (or alongside): `makeReminderFire` frames the text, falls back to `primaryChat`, and skips (logs) when neither origin nor primary chat exists — mock `onMessage`, assert the injected `text` contains the reminder body and the decide-framing.
- **Updated** `test/triage.test.ts:24-25`: `reminder.due → ignore` (was `notify_now`).
- **Updated** `test/heartbeat-e2e.test.ts`: its local notify stub echoes `⏰ Reminder:`; rework the reminder path to assert the fire now injects an inbound message (or drop the ping assertion and add an injection assertion), matching the new contract.
- **Updated** `test/store-heartbeat.test.ts`: check the `reminder.due` triage-rule/delivery assertions still hold under the new default verdict; adjust if they assumed a ping.
- **Golden re-pin:** `coordination` grows by 4 tools → neo's pinned tool list changes. Regenerate `test/fixtures/org-golden.json` via `scripts/gen-org-golden.ts`; the only delta must be neo's `add_routine`/`list_routines`/`update_routine`/`delete_routine`. (Parallel-session note: marco is retired in the working tree but present at committed HEAD — regenerate against the committed state so the golden stays consistent with committed agent files, exactly as cycle ⑩ handled it.)

## Non-goals

- No change to the Schedule UI (it already creates/lists/edits/deletes routines and shows reminders).
- No recurring reminders — recurrence belongs to routines; a "recurring nudge" is a routine whose prompt is the nudge.
- No change to how routines fire (`makeRoutineFire` is untouched) or to the attachment/delivery path.

## Security / safety

- A fired reminder now costs an LLM turn and can trigger tool use, but every outward action still flows through the existing trust gate; autonomy limits are unchanged.
- Routines created by Neo carry the origin chat; with no origin they fall back to `primaryChat` (same as UI-created routines), never to a wrong chat.
- Routine prompts are user-authored (via Neo) and injected as inbound messages — the same trust posture as the user typing them.
