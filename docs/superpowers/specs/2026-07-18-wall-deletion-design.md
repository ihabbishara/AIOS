# Wall deletion — design spec

Date: 2026-07-18
Status: approved (enforce flipped earlier today; this is the planned follow-up cycle from the
information-flow-policy spec §7/§8)
Executor: CLAIMED — in progress in worktree `.worktrees/wall-deletion` (session 01D7LFQo,
2026-07-18 evening). Parallel session: do NOT execute this spec; pick up ⑤d media generation.

## Problem

Policy runs in enforce, but the bespoke privacy walls still do the real blocking at most sites —
`policy.check` observes beside them. Two consequences: every new feature must still remember every
wall, and `check()` returns "allow" in audit mode, so a wall swapped naively onto `check()` would
fail-open if the mode ever returns to audit. Additionally, the pre-swap review found two label
derivation gaps and one table gap where the policy verdict does NOT yet match the wall it must
replace.

## Decision

Make the policy table the single authority at the swapped sites via a new mode-independent
`Policy.wall()`, fix the three gaps first, then delete the bespoke walls. Pinned red-team/leak
tests stay green throughout — they assert behavior, not mechanism.

## Components

### 1. `Policy.wall(input, site, contentForHash)` (src/kernel/policy.ts)

Table verdict authoritative in BOTH modes. These flows were blocked before the policy engine
existed, so honoring the table in audit is parity, not a new block. Denials are reported as
violations exactly like `check()` (walls-working observability). No unlabeled-sensitive preview:
wall sites always pass labels. Declassify → allow.

### 2. Table fix: personal.tasks prompt clearance (gap found in pre-swap review)

`personal.tasks` rule lacks the prompt-agent clearance clause the other personal labels have —
under enforce, jasmine's own lifeops memo would be denied at `resolve:memo` on her next resolve.
Add `(!!promptAgent(sink) && agentCleared("personal.tasks", agent))` (lifeops capability already
declares the label).

### 3. Label derivation fixes (src/kernel/labels.ts, src/memory/indexer.ts)

- **Mail**: labels become the UNION of the thread dept's label and every participant's dept label
  (`docLabels` gains `participantDepts`). Today a midas→athena thread labels `org.internal`
  (root-recipient dept only) and would sail past the deleted participant wall.
- **Email decisions**: `email.*` action types label `personal.email` (today: domain "inbox" →
  `personal.calendar`, which recall-index ALLOWS — the deleted email-prefix wall would have no
  policy equivalent). `docLabels` decision path gains the action-type namespace.

### 4. Wall deletions (each site: `policy.wall()` becomes authoritative; policy param REQUIRED —
optional policy at a wall site is fail-open)

| Site | Bespoke wall deleted | Policy equivalence |
|---|---|---|
| indexer indexMailThread | private-participant loop + deleteMemoryDoc | participant-union labels → personal.finance / personal.tasks / client.halalo deny recall-index; deny → deleteMemoryDoc (reconcile purge preserved) |
| indexer indexDecision | `a.type.startsWith("email.")` skip | personal.email denies recall-index |
| indexer indexEvent | (none deleted — allowlist is curation, stays) | verdict honored before indexDoc as defense |
| standup activeDepartments | `if (def.privateMemo) continue` | personal.finance denies standup sink |
| briefs runBrief/assembleBrief | `privateAgents` exclusion + unread hold | per-mail wall(): deny → exclude AND leave unread; personal.finance→brief denies (privateAgents today = finance only — exact) |
| resolve dept memo | `includeMemo = !(dept.privateMemo && visibility !== private)` gate | label vs agent clearance: juno uncleared → deny; midas cleared → allow; org.internal allows |

`index.ts` stops computing `privateAgents` (briefs was its only consumer). `privateMemo` manifest
flag STAYS (it still drives standup's dept label meaning nothing else — actually it becomes
documentation-only after this cycle; note in types.ts, do not delete the field: manifests carry it
and deleting a schema field is not this cycle's risk).

### 5. Explicitly NOT deleted

- `EVENT_INDEX_ALLOW` allowlist (curation, not privacy).
- hand_off / mailbox `privateOnly` origin refusals (visibility walls — chat-origin axis, not
  label axis; red-team pinned; separate cycle if ever).
- Distiller untrusted-origin exclusion from ALWAYS_LOADED memos (structural closure of the
  inbox.md vector — stricter than the table on purpose).
- Recall clearance filter (already always-on and authoritative).

## Behavior changes (intended)

- Halalo mail threads leave the recall index (16 docs purge at first reconcile) — client mail is
  file-export/halalo-prompt only per table.
- Life-dept (jasmine) mail threads leave the recall index (participant-union labels them
  personal.tasks, which denies recall-index; the old wall already blocked these — no change — but
  cross-dept threads WITH jasmine/midas as mere participants now also excluded — that is the leak
  fix, not a regression).
- Everything else is behavior-preserving by construction (table ≡ wall at every other site).

## Error handling

`wall()` throws never; sites treat "deny" as the wall did (skip/delete/blank). Policy required at
swapped sites — a missing policy is a compile error, not a silent fail-open.

## Testing

- policy unit: wall() denies in audit AND enforce; reports violations; declassify allows.
- personal.tasks table: jasmine-cleared prompt sink allows; uncleared agent denied.
- labels: mail participant-union (midas participant in eng thread → personal.finance present);
  email decision → personal.email.
- indexer: private-participant thread deleted via policy path (no participant loop in code);
  email decision skipped; org-internal thread indexed.
- standup/briefs/resolve: finance excluded exactly as before (existing tests keep passing —
  fixtures gain a Policy instance where the site's param went required).
- Red-team suite untouched and green.

## Live smoke

Boot → reconcile purges halalo/life mail docs (memory_doc count drops); /api/health violations
climb by the purged-thread denials; jasmine resolve carries her memo (table fix); standup skips
finance; morning brief next run excludes midas/juno mail unread-held.
