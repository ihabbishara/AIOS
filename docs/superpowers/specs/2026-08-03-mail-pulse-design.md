# Mail "Pulse" — Organism applied to the Mail section

**Date:** 2026-08-03
**Status:** approved (user selected premise "the org's pulse", scope "list + detail")
**Predecessor:** `2026-08-02-home-organism-design.md` (the language — §1 ground, §2 colour-is-a-clock, §5 motion inventory) and `2026-08-03-goals-memory-design.md` (the precedent — recency spine, theme-follows-toggle, design-for-what's-actually-there).

## Problem

The Goals spec nominated Mail next with two stated reasons: it is *"the other high-volume archive"*, and *"the recency-band and thread work here should transfer directly."*

Both are false. As with direction iii "day spine" last cycle, the nomination was made from reasoning about what Mail sounds like, not from the store.

| Measurement | Value | Consequence |
|---|---|---|
| Mail rows, all time | **72** | Against Goals' 57 — this is not a high-volume archive |
| `standup` share | **45 of 72 (62%)** | The majority is one repeating ritual, not correspondence |
| Threads with exactly 1 message | **48 of 56 (86%)** | There is no conversation to render; longest thread is 7 |
| Unread | **1 of 72** | Unread-badge-driven design chases a signal that does not vary |
| Messages the Mail view shows **today** | **8 of 72 (11%)** | It filters to threads touching `user`; newest is **18 days old** |
| Standups carrying a `goal_id` | **0 of 45** | The ritual is structurally disconnected from work |
| `request`/`report` carrying a `goal_id` | **26 of 26 (100%)** | The work traffic is fully goal-linked |
| Distinct goals touched by any mail | **11 of 57** | The work band is small and high-signal |
| Messages involving the human at all | **8 of 72** | The user is peripheral to their own "inbox" |

**The thread reader is rejected on evidence.** `Thread` was built for goal DAGs with real dependencies; a mail "thread" here is one message 86% of the time.

**The unread badge is rejected on evidence.** One unread row in the entire corpus.

The deeper failure is that the current view is not merely dated — it shows the wrong 11% of the table. The org writes mail every single morning, and Mail has displayed nothing new since 16 July.

### What is actually in there

Three populations wearing one table:

- **`standup` (45)** — all addressed to `neo`, from five agents (clio 21, athena 13, neo 9, jasmine 1, halalo 1). All `goal_id` NULL, all `read`, all sent between **04:00 and 05:00**. A cron-driven morning ritual.
- **`request` + `report` (26)** — 100% goal-linked. Every `goal_id` resolves to a **request → report round trip between exactly two agents**, sometimes with repeat reports. Eleven such exchanges.
- **`note` (1)** — a single 4,647-char outlier. Not designed for.

### The standup template is reliable; the first measurement of it was not

A strict newline-anchored match said 31 of 45 conformed and 14 "deviated". That matcher was wrong, not the data. Matching tolerantly — case-insensitive, allowing `**Done:**` markdown bold, accepting the single-line inline form, and tolerating narration before the first field:

| Standup shape | Count |
|---|---|
| Has all three of Done / Today / Blockers | **40 of 45** |
| Is `API Error: Unable to connect to API (…)` | **5 of 45** |
| Partial or freeform | **0** |

The 14 "deviants" were: 5 API failures, ~6 preamble leaks (`"Here is the standup:"`, `"Standup, 3 lines, plain text, ≤60 words. No tools needed."`), and ~3 that used the inline or bolded form. The template holds. **The parser must be tolerant, not strict.**

### Blockers are not the alarm — the missing standup is

The obvious move is a blocker alert lane. The data kills it — though not for the reason a first pass suggested.

Across the 40 parsed standups there are **31 distinct blocker texts**. Roughly **7 describe a real impediment**: a blocked WebFetch allowlist, a wall-time budget too tight for deck-scale goals, `Bash`/`Read` hard-disabled by the capability gate killing 3 tasks, `vault_write` silently returning stale output after its first call, a slide fix needing a human unblock, and a spend-or-descope decision. The rest are prose for "nothing".

What makes an alarm impossible is not scarcity, it is that **the wording does not track the meaning**:

- `None. Atlas still has Bash, Read, Glob and Agent disabled at the capability gate, so its filesystem work keeps routing to us.` — begins with the literal word **None**, and reports a real capability-gate problem.
- `None — inbox is clear, no queued requests pending, all systems idle and ready to dispatch.` — same opening token, means nothing is wrong.
- `none technical. Note: zero inbound work queued for this department, so capacity is unallocated — send work if you want it used.` — an organisational note, not an impediment.

A leading-token rule misses the first. A "longer than a bare negation" rule fires on the second — measured, it classified 27 of 40 as substantive, including five pure "None — inbox clear" variants. A naive `in ('none','none.')` test scored 35 of 45 as real and was wrong 33 times.

**Every classifier tried on this corpus was wrong in both directions.** Blockers renders as the third field, plainly, and nothing more — the reader classifies it, because no rule here can.

What *does* vary, and is currently invisible:

| Ritual state | Count | Detail |
|---|---|---|
| Checked in | **40 of 45** standups | |
| **Failed** | **5 of 45** standups | `API Error` on **3 mornings**: Jul 17 (athena + neo), Jul 28 (athena), Aug 1 (athena + clio) |
| **Silent** — no standup row at all | **5 of 31 days** | Jul 4, 15, 18, 21, 22 |

Two of the three failure mornings hit **multiple agents simultaneously**, which reads as infrastructure, not agent behaviour. **The org's morning ritual broke on 8 distinct days out of 31, and no surface in the product says so.** That is the signal this view exists to carry.

## Decision summary

- **Mail is the org's pulse** — the record of a daily ritual, in which a missed or failed check-in is unmissable *because* the rhythm around it is regular.
- **Organising spine: the day.** Not recency bands (Goals' answer) and not status. Standups arrive 1–3 per day, every day; the day is the unit the data is actually shaped in.
- **Three states per day: checked in / failed / silent.** All three are computed from rows, never asserted.
- **The standup body is parsed tolerantly into Done / Today / Blockers, with a raw-text fallback.** A body that does not parse renders verbatim as preformatted text rather than being dropped or coerced.
- **Blockers is a field, not an alarm** — not because real blockers are rare (~7 of 31 distinct texts are real) but because no rule classifies them: a genuine capability-gate blocker opens with the word "None". The alarm is a failed or silent morning, which is derived from row shape rather than from prose.
- **Work traffic is a second band**, whose unit is the **request → report exchange keyed by goal**, not the message and not the thread.
- **The human's correspondence survives as a third, deliberately minimal band**, preserving the route to `mail/:threadId`, the Compose button, and the answer-resumes-a-parked-goal path. Per the agreed scope these keep working but are not restyled.
- **Mail follows the light/dark toggle**, as Goals does. It does not inherit Home's pinned `.night`.
- **No motion.** Nothing in Mail is live — every row is a past event, 71 of 72 are read, and no standup is in flight at read time. Under "motion is real or it doesn't exist", Mail earns none. **No new `@keyframes`; no amendment to the doctrine allowlist.**
- **No new endpoints, no server change, no new dependencies.** `/api/mail` already serves the full unfiltered stream and `api.mail()` is already wired — the Mail view simply never calls it.

### Jobs this surface serves

1. **Did the org check in today?** — the question the current view cannot answer at all.
2. **When did the rhythm break, and was it one agent or all of them?** — failed and silent mornings, and whether they cluster.
3. **What did each agent say they did, are doing, and are blocked on?** — the three fields, read at a glance.
4. **Which goals involved one agent asking another?** — the 11 exchanges, each linking to its goal.
5. **Answer an agent that is waiting on me** — preserved, not restyled.

## Non-goals

- **A thread reader.** Rejected on 48-of-56 single-message threads.
- **An unread inbox.** Rejected on 1-of-72 unread.
- **A blocker alarm.** Rejected on ~2 real blockers in 45 and no reliable classifier.
- **Restyling Compose or the Reply/Answer controls.** Out of scope by the user's selection; they must keep working.
- **Server-side standup parsing.** The parse lives in the client so a template drift cannot corrupt stored rows.
- **Surfacing the single `note` row specially.** One row; it falls into the work band's raw fallback.

## 1. The pulse strip

A rolling **30-day** window, one column per day, oldest → newest, above the day list.

Each column carries one mark per agent that checked in that day, stacked. Counts run 1–3, so the column is read by its marks, not by a continuous height — a 3-level bar chart would be a chart in name only.

| Day state | Derivation | Render |
|---|---|---|
| Checked in | ≥1 standup row, none of them `API Error` | one mark per agent |
| Failed | ≥1 standup row whose body begins `API Error` | the failed agents' marks carry the `blocked` clock token |
| Silent | no standup row for that date | an empty cell, visibly a gap |

Colour follows the clock axis (Home spec §2, unchanged): today is *now*, earlier days recede through *past*. Failure takes the *blocked* token — the same token `statusClock` already assigns, reused rather than reinvented.

The strip is bound entirely to counted rows. It states nothing that is not derived.

**Header meta** reads `checked in N of M days`, both numbers computed.

## 2. The day list

Days descending, newest first. Each day is a group header (`TODAY`, `YESTERDAY`, then the date) with the count that checked in, followed by one row per agent.

A checked-in row shows the agent and the three parsed fields as labelled lanes:

```
clio     Done      no research items completed; one outbound mail sent
         Today     idle capacity — ready for export-project research
         Blockers  none
```

A failed row shows the agent and the failure, in the *blocked* token — not dressed up as a check-in:

```
athena   ✕ standup failed   Unable to connect to API (ConnectionRefused)
```

A silent day renders its header with no rows and an explicit line, so absence is stated rather than merely absent.

### Parsing is tolerant, and never destructive

`parseStandup(body)` must:

- match field labels **case-insensitively**;
- tolerate `**Done:**` markdown bold and strip the asterisks;
- accept both the newline-separated and the single-line inline forms;
- discard any narration before the first recognised field;
- detect `API Error` bodies and classify them as **failed**, not as a check-in with empty fields;
- **fall back to rendering the raw body as preformatted text** when no field is recognised.

The fallback is the same principle the Library already follows: **markdown renders as preformatted text — no markdown renderer, no `dangerouslySetInnerHTML`.** Mail bodies are agent-authored and must never be treated as trusted markup.

## 3. The work band

Below the days. The unit is the **exchange**, not the message: one entry per `goal_id`, containing its `request` and its `report`(s), ordered by the request's timestamp, newest first. Eleven entries today.

```
vulcan → atlas    request   DELIVERY HANDOFF — you are the only agent…
       ← atlas    report    Done: copied to vault                    goal ↗
```

Each exchange links to its goal via the existing `goals/:id` route. Bodies are truncated in the band and shown in full in detail (§4).

Kinds keep their meaning: a `request` with status `spawned` became a goal; a `report` carries `Done:` and `Artifacts:`.

## 4. Detail

Scope is list + detail. Two detail targets:

- **A day** — that day's check-ins in full, unabridged bodies, including any failure text.
- **An exchange** — the request and every report in full, with the goal link.

Both reuse the day/exchange components rather than introducing a third rendering of a mail body.

## 5. Yours — the preserved band

A third band, minimal by intent, carrying the existing user-thread list (`api.mailMine()`, 3 threads today) and the Compose button. Navigation to `mail/:threadId` and the answer path that resumes a parked goal are unchanged. This band is explicitly **not** restyled this cycle; it exists so the write path does not lose its entry point when the list stops being an inbox.

## 6. Ground and theme

Mail follows the light/dark toggle, exactly as Goals does — it does **not** pin `.night`. Clock tokens already differ per theme (`tokens.css`, light block). The contrast **ordering** pin in `design-doctrine.test.ts` (now > next > past > rest, in both theme blocks) governs the tokens this view reuses; Mail introduces no new tokens and must not weaken that ordering.

**No raw hex outside `tokens.css`** — §2 of the doctrine test enforces this.

## 7. Data flow

- `api.mail(undefined, undefined, since)` → `/api/mail?since=…` → `buildMailView` → `store.listMail(agent, limit, since)`.
- **The request is bounded by TIME, not by row count.** A row limit is taken over the whole corpus newest-first, so once the corpus outgrows the cap the *oldest* rows fall off — for a 30-day strip that means whole days vanish while the header still reports a count. `since` makes the range itself the bound, and no `LIMIT` is applied when it is present.
- **The fetch bound and the drawn bound come from one function.** `windowStartIso(now, days)` returns midnight UTC of the oldest cell `groupByDay` will render, and both the query and the strip use it, so they cannot drift apart.
- **`clampSince` (`src/web/server.ts`) floors the window at 366 days** so a caller cannot widen `since` into a full-table scan; unparseable input is ignored and falls back to the row limit.
- Consequence: **the work band is windowed too.** It shows exchanges inside the same 30 days rather than whatever happened to fit in a row cap — which is the more honest reading, since the header already frames the page as 30 days and Goals owns the full work archive.
- `api.mailMine()` → unchanged, feeds §5 only.
- Live updates continue through `useLiveQuery(..., T.agentMail)`, unchanged.

## 8. Error handling

- A mail payload missing expected fields must not throw. The `byAgent` guard landed on 2026-08-03 (`68ecc1d`) after both call sites crashed the whole app on `undefined[name]`; that class of bug is not to be reintroduced here.
- An unparseable standup body renders raw (§2), never blank.
- An empty corpus renders "No standups yet — agents check in each morning", not a bare empty strip.
- A day with rows but no recognisable agent name still renders the row.

## 9. Files

| File | Change |
|---|---|
| `ui2/src/lib/standup.ts` | **new** — `parseStandup`, `dayStateOf`, `groupByDay`, `exchangesOf`. Pure functions. |
| `ui2/src/views/Mail.tsx` | list rewritten to strip + days + work + yours; `Thread` and `Compose` kept as-is |
| `ui2/src/lib/goal-clock.ts` | reused unchanged (`CLOCK_TOKEN`, `CLOCK_TEXT`) |
| `ui2/src/api.ts` | raise the `mail()` limit for the window; no new endpoint |
| `ui2/src/tokens.css` | expected unchanged |
| `ui2/test/standup.test.ts` | **new** — parser, incl. every deviant form found in the store |
| `ui2/test/mail-pulse.test.tsx` | **new** — strip states, silent day, failed morning, empty corpus |

## 10. Testing

- **Parser unit tests must include the real deviant bodies**, not idealised ones: markdown-bolded, inline single-line, preamble-prefixed, and `API Error`.
- A silent day and a failed morning each need an explicit render test — they are the whole point of the view and both are absent from any current test.
- The empty-corpus state needs a test; the current view's empty state is the only state a fresh install ever sees.
- Both suites and both typechecks must be run — root `npx vitest run` does **not** include ui2's, and deleting or moving a `ui2/` file can orphan a root test.

### Verification before done

- Live browser walk against the real bundle with a stub API, covering: empty, a normal morning, a silent day, a multi-agent failure morning, and both themes.
- Confirm the strip's `N of M days` matches a direct SQL count.

## Open items

- **The `note` kind (1 row)** has no designed home; it falls into the work band's fallback. Revisit if notes become common.
- **The 30-day window is fixed.** At a year of data the strip needs a scale decision; not now.
- ~~**The 200-row ceiling in `clampLimit` will eventually break the strip.**~~ **Closed 2026-08-04.** `/api/mail` now takes a `since` window and drops the row limit when one is given, so the strip is bounded by the range it draws rather than by a corpus-wide row count. `/api/mail`'s default limit of 50 still applies to callers that pass no window.
- **Standup preamble leakage** (`"Here is the standup:"`, `"…no tools needed"`) is an *agent prompt* problem the client is compensating for. Worth fixing at the source; out of scope here.
- **Three failure mornings hit multiple agents at once**, which points at infrastructure rather than agents. Mail will now make this visible; diagnosing it is separate work.
