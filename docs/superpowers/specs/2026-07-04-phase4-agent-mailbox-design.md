# Phase 4 — Agent Mailbox: async delegation, reports, standups

**Date:** 2026-07-04
**Status:** Approved design, pending implementation plans (4a backend, 4b UI)
**Scope:** Phase 4 of the org redesign (spec lineage: `2026-07-02-agent-registry-legibility-design.md` §Vision)

## Problem

Phase 3 gave AIOS goals, task DAGs, and department leads that plan. But all agent-to-agent
interaction is still synchronous and ephemeral:

1. **Everything blocks.** `hand_off` waits for the specialist to finish; a node run ends and its
   agent evaporates. Odin cannot finish research at 3am and leave "implement this" for vulcan.
2. **No agent-to-agent record.** Handoffs live only in `route.decision` events and artifact files;
   there is no readable "what did athena ask vulcan, and what came back."
3. **Leads report nothing.** Departments do work overnight (goals, dream, speculate) but nobody
   summarizes it; the morning brief covers reminders/calendar/dream — not the org's own output.

## Decisions locked (user-approved in brainstorm, 2026-07-04)

1. **Full trio in one phase:** mailbox (async delegation) + standups + inbox UI. Split like
   Phase 3: 4a = backend, 4b = Mission Control UI.
2. **Work mail spawns a goal.** A `request` mail compiles to a normal single-node goal executed by
   the recipient. Mailbox = thin queue in front of GoalEngine. No second execution path.
3. **Any agent may send work mail.** Not just leads, not just hermes.
4. **Runaway bound = chain depth cap ONLY** (default 2). No daily quota, no forced budget cap.
   *User explicitly accepted the fan-out risk:* with `AIOS_DAILY_BUDGET_USD` unset, SpendGuard is
   a no-op and a confused agent can fan out wide within one day; depth cap bounds chains, not width.
5. **Direct single-node spawn.** Mail body → 1 `run` node by the recipient. No lead planning run
   per mail. Loop/verify unavailable for mail-goals in v1.
6. **Leads narrate standups.** One-shot lead run per ACTIVE department pre-brief; idle depts skip;
   quiet days cost zero runs.
7. **Machinery lives in GoalEngine** (mail sweep on the existing pump). No separate MailEngine, no
   heartbeat-owned goal creation.

**Untouchable moat (unchanged):** action gate + trust ledger, privacy walls (recall exclusions,
private visibility, privateMemo), 5-layer code sandbox, senses, voice, integer-cents money math,
playbooks-as-SOPs, subscription auth, node:sqlite, no new npm deps.

## Design

### 1. Data model

New `mail` table in `src/store/db.ts` (ISO strings for time, mirroring existing conventions):

**`mail`**: `id` (uuid), `from_agent`, `to_agent` (canonical names), `kind`
(`request | note | report | standup`), `body`, `goal_id` (nullable — the SPAWNED goal for
requests; the SOURCE goal for reports), `origin_channel`, `origin_chat_id` (privacy provenance,
threaded from the sender's run), `chain_depth` (int), `status`, `error` (nullable), `created_at`,
`read_at` (nullable).

Status lifecycle is partitioned by kind:
- `request`: `queued → spawned | refused`. Two refusal flavors, different visibility:
  **depth-downgrade** rewrites the row to `kind='note', status='unread'`, `error` = "downgraded:
  chain too deep" — the RECIPIENT still sees the content, nothing runs. **Validation refusal**
  (privacy wall, recipient gone) sets `status='refused'` — visible to the SENDER only (a
  private-walled recipient must never receive the delivery).
- `note | report | standup`: `unread → read`.

Migration: `CREATE TABLE IF NOT EXISTS mail` + `ALTER TABLE goals ADD COLUMN chain_depth INTEGER
NOT NULL DEFAULT 0` (try/catch idempotent, same pattern as `job_dir`/`receipt_path`). Existing and
user/hermes-created goals are chain roots: `chain_depth = 0`.

### 2. Chain depth semantics

- `goals.chain_depth`: 0 for user/hermes/facade-created goals; a mail-spawned goal inherits its
  spawning mail's `chain_depth`.
- A mail sent from a run belonging to goal G carries `chain_depth = G.chain_depth + 1`. A mail
  sent from a non-goal run (direct chat, hand_off, standup run) carries `chain_depth = 1`.
- Spawn rule: `chain_depth > AIOS_MAIL_MAX_DEPTH` (default 2) → the request is **downgraded to a
  note** (row rewritten `kind='note', status='unread'`, error records the downgrade; recipient
  sees the content as ordinary mail) — fail-soft, no lost information, nothing runs.

So: user goal (0) → node mails → spawned goal (1) → its node mails → spawned goal (2) → its node
mails → depth 3 > 2 → note only. Chains terminate; width is unbounded (accepted risk, §Decisions 4).

### 3. Tool surface

New in-process SDK MCP server **`aios-mail`** (`src/mail/server.ts`, mirrors money/research/lifeops
servers) with ONE tool:

- **`send_mail(to, kind: "request" | "note", body)`** — `report` and `standup` are
  system-generated kinds; agents cannot forge them.

Sender identity, origin provenance, and the sender's goal `chain_depth` are **baked at build time**
per run (like aios-pack's origin baking — non-spoofable; the model never supplies `from`).

Tool-side validation (fail-closed, error string returned to sender on failure):
- recipient resolves via `registry.agentOf` (aliases canonicalize), recipient ≠ sender;
- recipient with `visibility: private` (midas) requires `isPrivateOrigin(primaryChat,
  origin_channel, origin_chat_id)` — fail-closed when primaryChat unset;
- `AIOS_MAIL_DISABLED=1` → refuse with "mailbox disabled".

Attachment seam: the server is added for **every agent** at the single `specialistOptions`
option-assembly path — capability parity by construction (node run ≡ hand_off ≡ @mention).
Hermes gets `send_mail` as a moderator tool wrapper (same validation path).

**Allowlist plumbing (StructuredOutput lesson, [[sdk-permission-semantics]] #6):**
`mcp__aios-mail__send_mail` must be (a) present in `allowedTools` BEFORE `withDenialObserver`
wraps, (b) allowed by the fallback-deny confinement guards (`guardOptions`), and (c) treated as
universally owned by `clampTools` (ownership clamp must not strip it for sandboxed/confined
agents). All three pinned by tests.

### 4. Mail → goal spawn (GoalEngine pump extension)

Each pump pass sweeps `kind='request' AND status='queued'` (FIFO):

1. **Depth check** (§2) — exceeded → downgrade to note.
2. **SpendGuard.allow()** — false → mail stays `queued`; the after-midnight budget-resume tick
   pumps again and the queue drains (same semantics as `paused-budget` goals).
3. **Re-validation (defense in depth, mirrors validateGraph's re-check):** recipient still resolves,
   private-recipient origin wall re-checked against the mail's stored provenance. Failure → mail
   `refused` + error.
4. **Spawn** — in ONE transaction (node:sqlite is synchronous): insert goal + node, flip mail to
   `spawned` + set `goal_id`. Crash anywhere before commit → mail still `queued`, re-swept
   idempotently on restart.

Spawned goal shape:
- `title` = first 80 chars of body; `slug` = slugify(title); `department` = recipient's dept;
  `lead` = that dept's manifest lead; `origin_channel/origin_chat_id` = mail provenance;
  `chain_depth` = mail's; `status` = `running`; `plan_summary` = "Requested by <from> via mail."
- ONE `run` node: `agent` = recipient, `brief` = mail body verbatim + a fixed preamble
  ("Requested by <from_agent> via mail <id>. Your result is automatically reported back."),
  `max_rounds` = 1, `depends_on` = [].
- **No workspace**: `project_dir` stays null (`needsWorkspace` none). Mail-goals are
  analyze/write-up tasks; code work still enters ONLY via `code_task`.

Scheduling, wall-time, pause/resume/abandon, restart recovery, vault artifacts
(`goals/<date>-<slug>/`), and the DAG UI are all inherited — a mail-goal is just a goal.

### 5. Reports and the read path

- **Completion:** when a mail-spawned goal reaches `done` or `failed`, the engine auto-inserts a
  `report` mail recipient→sender (body = outcome summary + artifact refs + error on failure,
  `goal_id` = the completed goal).
- **No chat ping for mail-spawned goals:** the report REPLACES the origin-chat completion message
  (otherwise every sub-goal spams the user). Chain-root goals (depth 0) keep today's notification
  behavior unchanged.
- **Context injection:** at `specialistOptions` build, a `# Mail` block is rendered into the
  agent's system prompt containing (a) unread mail addressed TO the agent (`note/report/standup`,
  status `unread`) and (b) the agent's OWN refused requests not yet acknowledged ("your request to
  X was refused: <error>"). Cap 5 total, each body truncated at 500 chars, oldest first; `read_at`
  is stamped when the CONSUMING run succeeds (`peekInbound` peeks without marking; `markDelivered`
  commits) — durable delivery: a run that crashes after injection never commits, so the mail
  re-surfaces. Refusal acknowledgment clears on the sender's next successful run. (Ratified
  2026-07-06 — deliberate improvement over the original at-injection wording.) `request` rows never inject —
  their delivery IS the spawned goal's brief. No polling tool in v1.
- **Hermes's inbox:** the morning brief (not the session) is hermes's read path — see §6.

### 6. Standups

- **New heartbeat anchor `standup`** (default 07:15, `AIOS_ANCHOR_STANDUP`), before the 07:30
  morning brief. Same fire-once kv stamp-before-run + same-day catch-up as dream/speculate;
  fire-and-forget with `.catch` so it can never break reminders. Startup-only recovery rules apply.
- **Active-dept detection (deterministic, code only):** a department is active if the last-24h
  window (local dates via `localParts`) contains any `goals` row with `updated_at` in window and
  `department = D`, OR any mail with a D member as `from_agent`. Idle dept → no run. Quiet day →
  zero runs.
- **Digest (pure code, per active dept):** yesterday's goals (title, status, summed node costs
  from `task_nodes`), failures with 200-char error tails, mail sent/received counts by dept
  members, today's running/paused goals + queued requests addressed to dept members. Sources:
  `goals`, `task_nodes`, `mail` tables ONLY — never `personal_*`, never email content (pinned).
- **Lead run:** the dept lead runs one-shot through normal dept resolution with the digest and a
  prompt: "write your standup — 3 lines: done / today / blockers, ≤60 words." Free text (no
  schema). Result inserted as `standup` mail lead→hermes.
- **Brief integration** (`briefs.ts`): `assembleBrief` (morning only) reads today's standup mail →
  `BriefData.standups: [{department, lead, text}]` → `renderBriefNote` renders a "Standups"
  section → narrated to primary chat as usual. `isEmptyBrief` counts standups (standup-only
  morning still narrates). Additionally the brief lists hermes's other unread mail (reports/notes)
  as one line each (from, kind, first line), marking them read once briefed.
- **Privacy carve-out:** departments with `privateMemo: true` (finance) **skip standups
  entirely** — brief notes are vaulted and indexed into recall; midas standup content in the vault
  would breach the money wall (same class as the speculate-email Vector B fix). Money signals
  already cover finance privately via the transport-only watcher. Midas/juno never run standups.
- **Budget:** standup runs are background — gated by `SpendGuard.allow()` like dream/speculate.
  At cap → skipped that day (no queue), brief simply has no Standups section.
- Cost ceiling: ≤4 lead runs/day (eng, research, life, clients), typically 1–2.

### 7. Events, triage

`AiosEvent` union additions:

- `mail.sent {id, from, to, kind}`
- `mail.spawned {mailId, goalId}`

Both carry an explicit triage default of **`ignore`** (the triage-storm lesson: internal machinery
events must never become user pings, even via user triage rules — pinned by test alongside the
existing `triage.decision`/`brief.sent` hard guard).

### 8. Privacy

- Private-recipient wall enforced twice: at `send_mail` (tool) and at spawn (sweep re-validation),
  both via the shared `isPrivateOrigin`, fail-closed when primaryChat unset.
- Mail bodies are agent-authored task text; no new path carries `personal_*`, bank, or inbound
  email content into mail, briefs, or vault (standup digest reads goals/task_nodes/mail only).
- Mail-spawned goals inherit the mail's origin provenance, so the existing goal-side privacy
  rules (validateGraph re-checks on replan, vault rules) apply unchanged.
- Recall exclusions untouched; the mail table is NOT indexed into recall in v1.

### 9. Mission Control (plan 4b)

**API (token gate):** `GET /api/mail?agent=<name-or-alias>&limit=` (list, canonicalized filter);
`mail.*` events on the existing SSE stream; `buildGoalDetail` gains
`spawnedBy: {mailId, from} | null`.

**UI (lean):**
- Agent profile gains a Mail section (sent/received, kind-tagged, unread badge).
- Goal detail header shows "← spawned by mail from <agent>" (provenance link).
- Standups surface via the existing brief; no separate inbox tab in v1 — the profile is the inbox.

### 10. Error handling

- Unknown recipient / self-send / disabled → tool returns error string to sender (no crash).
- Depth exceeded → downgrade to note (`refused` + reason, recipient still sees content).
- SpendGuard block → request stays `queued`, drains after midnight resume.
- Spawn-time validation failure → mail `refused` + error; the sender's next context injection
  renders it as "your request to X was refused: <error>" (§5). The recipient never sees it.
- Daemon restart mid-sweep → transaction guarantees `queued` mail is re-swept idempotently.
- Standup lead-run failure → that dept's standup absent, brief renders without it (fail-silent,
  logged).

### 11. Config

- `AIOS_MAIL_MAX_DEPTH` (default 2)
- `AIOS_ANCHOR_STANDUP` (default 07:15)
- `AIOS_MAIL_DISABLED` (=1: send_mail refuses, sweep idles, injection skipped — standups die too,
  mail is their substrate)
- `AIOS_STANDUP_DISABLED` (=1: standups only)

### 12. Testing

- **Store:** mail CRUD, status lifecycles per kind, goals.chain_depth migration idempotency.
- **Tool:** recipient canonicalization, self-send refusal, private-wall (midas from shared origin
  refused; fail-closed primaryChat unset), disabled kill-switch, baked sender/depth non-spoofable.
- **Sweep:** queued→spawned single-transaction, FIFO, depth downgrade, SpendGuard leaves queued +
  drains after resume, re-validation refusal, restart idempotency, spawned goal shape (dept, lead,
  origin, chain_depth, single run node, no workspace).
- **Reports:** auto-mail on done AND failed; mail-spawned goals do NOT ping origin chat;
  chain-root goals still do.
- **Injection:** cap 5, 500-char truncation, mark-read at injection, refused-mail feedback to
  sender.
- **Standups:** active-dept detection windows, digest content (and personal_*/email exclusion pin),
  standup mail insertion, brief section render, standup-only brief narrates, finance skipped,
  SpendGuard skip.
- **Events/triage:** mail.* triage-ignore pins.
- **Capability parity:** send_mail present and identical across node run / hand_off / @mention;
  allowlist-before-wrap + guardOptions + clampTools pins (all three seams).
- Suite baseline 778 + 1 skip; tsc/build/ui clean at every merge.

### 13. Explicitly out of scope (later phases)

Multi-turn agent conversations (threads/replies), mail-spawned multi-node graphs, daily quotas or
forced budget caps (user-accepted risk), user-addressable mail (chat exists), standup
replies/comments, cross-department goal graphs, mail recall-indexing, workspace-carrying
mail-goals, Phase 5 (dream/speculate through leads + eval loop).
