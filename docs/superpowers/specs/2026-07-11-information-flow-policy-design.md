# Information-Flow Policy Engine — Design

**Date:** 2026-07-11
**Status:** Approved (brainstorm with user)
**Scope:** Central label-based information-flow checkpoint replacing scattered privacy walls. Rollout: audit mode → enforce. Depends on: Agent×Capability org model (capability `labels` field).

## 1. Problem

Privacy is enforced today at N independent call sites: indexer exclusions (`EVENT_INDEX_ALLOW`, `email.` prefix skip, private-participant mail wall), brief carve-outs (privateAgents filter, Vector B/C email handling), `privateOnly` checks at three routing points, standup finance exclusion, mail sweep private re-check, recall domain conventions.

Every new feature must remember every wall. Project history shows the cost — three real leaks caught only by adversarial review: hand_off bypassing the private wall, the brief Mailroom leaking private-dept mail, engineering mail-goals acquiring a code sandbox. One known hole remains open by explicit accepted-risk: any pack agent can pass `domain:"money"` to the pack `recall` tool.

Additionally, the `inbox.md` injection vector is acknowledged in code comments: attacker-influenceable calendar invite text can reach the moderator's always-loaded system prompt with only a curator instruction in between.

## 2. Decisions (locked with user)

| Decision | Choice |
|---|---|
| Rollout posture | **Audit → enforce**: ship checking + logging everything, block nothing; flip to fail-closed enforce after a clean week |
| Model | Two orthogonal axes: confidentiality **label** + integrity **origin** |
| Mechanism | One pure checkpoint function over a declarative table; call sites swap bespoke walls for it |

## 3. The model

**Confidentiality labels:** `personal.finance` · `personal.email` · `personal.tasks` · `personal.calendar` · `client.halalo` · `org.internal` (agent mail, goals, standups) · `shared` (default).

**Integrity origin:** `trusted` (user, agents, system) | `untrusted` (inbound email bodies, calendar invite text, fetched web content).

**Sinks:** `recall-index` · `vault` · `brief` (vaulted + indexed) · `standup` · `chat:<origin>` · `mail:<recipient>` · `prompt.system:<agent>` · `prompt.context:<agent>` · `file-export`.

## 4. The checkpoint

`src/kernel/policy.ts`:

```ts
policy.check({ labels, origin, sink, agent? }) → "allow" | "deny" | { declassify: RuleId }
```

Pure function over a declarative table. Modes via `AIOS_POLICY_MODE`:
- `audit` (initial): every check runs; violations emit `policy.violation` events (label, sink, call site, snippet hash — never the content itself); nothing blocked.
- `enforce`: fail-closed — denied flows blocked; **unlabeled data at a sensitive sink is denied** (missing label ≠ shared for sinks stricter than chat).

## 5. Initial policy table

| Label | Allowed sinks |
|---|---|
| `personal.finance` | `chat:primary`, `chat:web-ui`, `prompt.*` of private-visibility agents. Nothing else — no recall-index, no vault, no brief detail |
| `personal.email` | `prompt.context:speculate-email` only. Declassify rule D1: count-only summaries ("N reply drafts await approval") → `brief` |
| `personal.tasks` | `chat:primary`, `brief` (task titles allowed — existing deliberate relaxation preserved) |
| `personal.calendar` | brief, recall-index (summary/organizer/start fields only — current indexer behavior), private + coordinator prompts |
| `client.halalo` | halalo agent prompts, vault export dirs |
| `org.internal` | all sinks except `file-export` and non-primary chats |
| `shared` | everywhere |
| origin=`untrusted` (any label) | **never `prompt.system:*`**; `prompt.context:*` only inside fenced data blocks; never vault-as-prose via distiller |

Declassification formalizes patterns invented ad hoc today: Vector B count-only brief lines, standup digests reading only goal/mail metadata. Declassify rules are enumerated in the table with ids — no inline judgment calls.

## 6. Label propagation

- `memory_doc` gains a `labels` column (JSON array); tokenizer/scoring untouched.
- Mail threads derive labels from participant visibility (private participant → the dept's label).
- Events carry source labels (senses stamp them at emit: gmail → `personal.email`+untrusted, bunq sync → `personal.finance`, lifeops → `personal.tasks`).
- **Derived artifacts inherit the union of input labels** — no silent laundering. Only table declassify rules lower a label.
- Distiller becomes label-aware: memo content destined for `prompt.system` may only be derived from trusted-origin docs. **This closes the inbox.md vector structurally** — untrusted calendar text can no longer become system-prompt prose; it reaches models only as fenced `prompt.context` data.

## 7. Call sites swapped

Each replaces its bespoke wall with `policy.check` (pinned tests stay as regressions):

1. Memory indexer (all source exclusions).
2. Distiller + memo prompt injection.
3. Briefs assembler (private-agent carve-outs, email vectors).
4. Standup digest (privateMemo dept exclusion).
5. Mail sweep + mail injection (private wall re-checks).
6. `resolveAgent` prompt assembly (memo/context blocks).
7. Vault writer (label-bearing notes).
8. Pack/capability `recall` tool `domain` parameter — **fixes the open `domain:"money"` broadening hole**: recall results are filtered by the calling agent's label clearance, not by the requested domain string.

## 8. Rollout

1. Land engine + labels + call-site swaps in `audit` mode.
2. Mission Control surfaces `policy.violation`: EventLog preset + Health count badge.
3. One clean week (no unexpected violations) → flip `AIOS_POLICY_MODE=enforce`.
4. Keep audit logging in enforce mode (denials are audited too).

## 9. Testing

- Table golden tests: every label × sink combination.
- Propagation property test: derived labels ⊇ union of inputs; declassification only via enumerated rules.
- Per-sink integration: recall never returns `personal.finance` docs to a shared agent even with `domain:"money"`; brief notes contain no `personal.email` strings; distiller system-prompt output contains no untrusted-origin content.
- **Red-team regression suite**: the three historical leaks (hand_off private bypass, brief Mailroom leak, mail-goal sandbox acquisition) encoded as permanent policy tests.

## 10. Out of scope

- Gate/trust semantics (actions remain the effect door; policy governs information flow, not effects).
- Egress/network policy for the code sandbox (Ops-floor spec).
- Label UI management (labels are code/config-defined, not user-editable at runtime).

## 11. Open questions

None — resolved in brainstorm (§2).
