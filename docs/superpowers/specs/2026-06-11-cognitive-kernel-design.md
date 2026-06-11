# AI-OS Cognitive Kernel — Design

**Date:** 2026-06-11
**Status:** Approved (brainstorm complete, awaiting implementation plan for Phase 3)

## Summary

Evolve AI-OS from a chat-driven multi-agent tool into a proactive **chief of staff**: an
always-on cognitive kernel that watches the user's life (inbox, calendar, money, code,
research, life ops), works overnight, and comes to the user with briefings, finished
drafts, and decisions queued for one-tap sign-off. Autonomy is **earned**: every outward
action passes a single trust-gated chokepoint, and every approval or rejection trains a
per-action-type trust ledger.

## Requirements (from brainstorm)

| Dimension | Decision |
|---|---|
| Operating mode | Chief of staff — system drives, user approves/redirects |
| Scope | Full: inbox+calendar, money, projects+code, knowledge+research, life ops |
| Trust model | Earned autonomy — per-action-type trust scores; supervised → graduating → autonomous; instant demotion on rejection/undo |
| Surfaces | Web Mission Control = home base; Telegram (first) and iMessage (later) = remote for briefs, pings, approvals, task intake |
| Rhythm | Two anchors (07:30 morning brief, 21:00 evening close) + real-time pings |
| Success criteria | Time back, leverage (things ship that otherwise wouldn't), true second brain |

## Existing foundation (kept, not rebuilt)

- Always-on daemon (TypeScript, Claude Agent SDK 0.3.x, Node 23 `node:sqlite`)
- Moderator: persistent SDK session per chat; specialists: one-shot sessions
- Deterministic playbook engine (`single`/`loop`/`verify` stages, loop caps, retries)
- SQLite store (job queue, stage state, session ids), Obsidian vault artifact store
- Channels: CLI working; Telegram/Slack adapters written, untested (awaiting bot tokens)
- Web UI (Vite/React) scaffolded; finance ledger module exists
- Subscription auth only: `CLAUDE_CODE_OAUTH_TOKEN` via `claude setup-token` — never API keys
- Long work never runs inside SDK MCP tool handlers (60s stream-close limit); jobs are
  enqueued and the engine notifies the moderator on completion

## Architecture — five layers, one loop

```
watcher → event → triage → job → proposed actions → GATE → effect → memory → brief
```

### 1. Perception — watcher event bus

Watchers are small isolated modules that only **perceive** (read-only) and emit
`Event { source, type, payload, dedupe_key, occurred_at }` into a SQLite events table
(extends `src/events.ts`).

Launch set: `clock` (anchors, renewals, reminders), `mail` (Gmail API), `calendar`
(Google Calendar), `git` (repo state, CI via `gh`), `ledger` (existing finance module +
CSV bank import), `rss` (watched topics).

- Each watcher runs its own loop with try/catch + backoff restart; a crash never kills
  the daemon. Dedupe by `dedupe_key`; missed windows replay without double-processing.
- **Triage**: a cheap fast model (Haiku-class) classifies each event into
  `ignore | batch_to_anchor | spawn_playbook | notify_now`. User corrections persist as
  deterministic triage rules checked *before* the model call — rules beat model. This is
  the high-frequency path, so it must stay near-free.

### 2. Cognition — scheduler, pillar packs, dream cycle

- **Processes**: every job carries `{ priority, token_budget, deadline, pillar }`. The
  playbook engine gains a priority queue and per-job token budgets, plus a daily global
  budget — when exhausted, non-urgent work defers to tomorrow and the brief reports it.
  Anchor jobs preempt the queue.
- **Pillar packs**: `playbooks/{inbox,money,code,research,lifeops}/` — each pack is
  playbooks + role prompts + tool allowlists + a vault section. Instantiated per job
  (zero standing sessions/token burn). Domain expertise lives in pack prompts plus the
  pack's slice of memory.
- **Moderator** survives unchanged in role: conversational chief of staff for task
  intake, playbook firing, and memory-grounded Q&A.
- **Dream cycle** (02:00 nightly):
  1. *Consolidate* — day's events, decisions, completed work → daily note + memory index
     + distilled decision journal.
  2. *Propose* — scan observations for initiatives (unused subscriptions, red CI, price
     drops on researched items); rank; top 3 → morning brief.
  3. *Speculate* — run cheap pre-approved work overnight: research digests, drafted
     email replies, code spikes in isolated git worktrees. All outputs land as
     **proposals** (vault drafts + gate queue) — never direct effects.

### 3. Action Gate — the only door out (kernel heart)

Every outward effect (send, pay, commit, book, buy, …) passes one audited chokepoint.

- **Action schema**: `{ type, domain, payload, preview, risk_tier, reversible, expiresAt }`.
  Types namespaced: `email.send`, `email.archive`, `finance.pay_bill`, `purchase.buy`,
  `git.push`, `calendar.create`, `vault.write`, …
- **Trust ledger** (SQLite, per action-type): `{ score, state, approvals, rejections,
  last_rejection, graduated_at }`.
  - `supervised` — every instance requires a user tap.
  - `graduating` — threshold reached (default: 10 consecutive approvals AND 30 days of
    history for the type; both per-type configurable): the system proposes promotion in
    the evening close. **Promotion is itself an approval — the gate never auto-promotes.**
  - `autonomous` — executes immediately, logs, and appears in the daily brief digest.
- **Demotion**: any rejection or undo → instant drop to `supervised` with score penalty.
  The user can manually demote any category at any time.
- **Hard ceilings** (config, never learnable): `purchase.buy` above a configured ceiling
  (default €50) and irreversible high-value types are permanently supervised. Unknown action types are
  always supervised. Fail-safe by default; if the gate is down, nothing executes.
- **Approval UX**: chat ping with preview + `[✓ approve] [✗ reject] [✎ edit]`. Reject
  prompts an optional one-line reason → decision journal. Timeout → expires with no
  action and resurfaces at the next anchor.
- **Undo window**: reversible autonomous actions are listed in briefs with an undo
  button; undo is a strong demotion signal.
- **Audit log**: every effect recorded forever — payload, executor result, trust state
  at execution, undo info.

### 4. Memory — second brain

Three stores, one recall API:

1. **Vault** (exists) — artifacts: briefs archive, research, drafts, daily notes. Plain
   markdown; user-owned and Obsidian-browsable.
2. **Memory index** — SQLite FTS5 (built into `node:sqlite`, zero new dependencies) over
   vault + events + decisions. `recall(query, domain?)` tool exposed to every agent,
   returning top passages with provenance. Embeddings are a later optional upgrade.
3. **Decision journal** — every gate verdict with reasons, structured. The dream cycle
   distills it into per-pillar **preference memos** (e.g. `money.md`) that load into
   pillar prompts, so agents act on the user's patterns without re-asking.

**Profile memos**: stable facts (people, accounts, recurring patterns, tastes) curated
by the dream cycle, stored as plain markdown the user can edit or delete directly.
"Forget X" in chat also works. The dream cycle dedupes, expires stale facts, and flags
contradictions.

### 5. Surfaces

- **Mission Control** (extends existing `ui/`): status bar (daemon health, daily token
  budget gauge) + seven views — **Now** (live process table, today timeline),
  **Approvals** (queue with previews), **Trust** (full ledger, streaks, ceilings, manual
  demote), **Memory** (search + profile memo editing), **Briefs** (archive),
  **Pillars** (per-domain health), **Audit** (every effect, filterable).
- **Chat** (Telegram first — adapter exists; iMessage later): four message kinds —
  morning brief, live pings with inline approve/reject, evening close (digest +
  graduation proposals), free-form intake routed to the moderator.
- Both surfaces read the same approval queue; either works if the other is down.

## Error handling — fail closed, never silent

- Gate down or unknown action type → nothing executes.
- Watcher crash → isolated, backoff restart; replay via `dedupe_key`.
- Job failure → existing retry caps; terminal failures surface in the next brief.
- Token budget exhausted → defer non-urgent, report deferral.
- Approval expiry → no action; resurface at anchor.
- Daemon restart → jobs resume, approval queue persists (SQLite).
- Speculative overnight work → worktrees and drafts only; failure costs nothing.

## Testing

- **Gate (heaviest coverage, pure logic)**: streak → graduating, rejection → demotion,
  ceilings, unknown-type failsafe, expiry. Fast unit tests.
- **Watchers**: fixture event files; dedupe assertions.
- **Engine**: existing test patterns + priority/budget cases.
- **E2E**: fake-executor mode — full loop (event → triage → job → gate → approve →
  audit) with zero real side effects.
- **Every new executor ships dry-run first**; real API wired only after gate behavior
  is verified.

## Build phases

Phases 1–2 are complete (moderator chat, vault write, echo playbook end-to-end).

| Phase | Scope |
|---|---|
| **3 — Kernel core** | Action Gate + trust ledger + approval queue + audit log; approvals via Telegram inline buttons + minimal dashboard view (CLI fallback while bot token missing) |
| **4 — Heartbeat** | Event bus + clock watcher + triage + two anchors (morning brief, evening close) |
| **5 — First senses** | Mail + calendar watchers; inbox pillar pack (triage, drafts, meeting prep) |
| **6 — Second brain** | FTS recall index + decision journal + preference memos |
| **7 — Pillars wave 2** | Money (ledger exists), code, research, life ops packs |
| **8 — Dream cycle** | Nightly consolidate/propose/speculate + graduation UX + full Mission Control |
| **9 — iMessage** | iMessage channel adapter |

Each phase is independently shippable and gets its own spec → plan → implementation
cycle. Phase 3 is next.

## Out of scope (YAGNI)

- Embedding-based memory search (lexical FTS first).
- Voice surface.
- Multi-user support — single-user system by design.
- Public network exposure — outbound-only connections remain a hard rule.
- Auto-promotion of trust categories — promotion always requires explicit user approval.

## Known blockers

- Telegram bot token not yet provided (adapter written, untested).
- Gmail / Google Calendar API credentials will be needed for Phase 5.
