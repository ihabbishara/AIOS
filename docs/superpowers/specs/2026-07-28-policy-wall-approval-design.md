# The policy-wall approval loop — a denied tool parks the node for a human instead of burning attempts

## Problem

Goal `f83d56cf` ("deliver deck.html to the vault") is the live exhibit, from today. Its node ran
`atlas` in a session whose code pack resolved without a workspace, so `advisoryGuard()`
(`src/code/guard.ts:36`) denied every filesystem tool. The agent burned **4 attempts across 3
reopens (~83¢)** methodically probing walls it could never pass:

- `Bash`, `Read`, `Glob` → `advisory context: filesystem/exec disabled — use recall/vault_read`
  (guard layer)
- `Agent` → `Agent is not in atlas's allowlist` (allowlist layer)
- `propose_action` → `This pack may only propose: [vault.write]` (pack logic)
- `vault_read` of the target → `Not found` — the vault reader is markdown-only by construction
  (`writer.ts:112` appends `.md` to any non-md path), so the brief's verification route never
  could work.

The ⑭ gate did its job — every attempt failed honestly with articulate blockers, nothing false
completed. The ⑮ reopen did its job — the human retried with guidance three times. What is
missing is the middle of the loop: **the engine knows exactly which tool was denied at the moment
of denial, and it tells no one and offers nothing.** The human's only lever was reading blocker
prose and guessing; the agent's only option was re-probing the same walls. The earlier
secret-denylist workspace failure (one of the 7 all-time goal failures) is the same class.

The infrastructure for the fix already exists end to end:

- `withDenialObserver` (`permissions.ts`) already intercepts and records allowlist denials — it
  just emits fire-and-forget bus events with no goal/node context.
- The always-supervised action gate already has `permission.grant` proposals, a human approval
  queue, and an executor that writes `setRolePermission` (`kernel/executors.ts:51` — approving is
  the ONLY thing that writes a grant).
- `effectiveAllowedTools` reads overrides **fresh per run** — a granted tool is live on the very
  next attempt, no restart.
- The `needs-review` park + Retry (cap-bypassing, guidance-capable) is the intervention surface
  ⑮ just proved.

Three denial layers exist, and the distinction is load-bearing:

| Layer | Example message | Reaches the bus today | Fixable by permission.grant |
| --- | --- | --- | --- |
| Allowlist (`withDenialObserver`) | `Agent is not in atlas's allowlist` | yes | **yes** |
| Guards (`guardOptions`) | `advisory context: filesystem/exec disabled` | **no** | **no** — code-level policy |
| Pack logic (inside tool handlers) | `may only propose: [vault.write]` | no | no |

A first design collected only allowlist denials; today's incident showed that would have proposed
`permission.grant atlas/Agent` — a grant that fixes nothing, while the real wall (the guard)
stayed invisible. The amended design parks on **both observable layers** and auto-proposes
**only** for the layer a grant can actually fix. Pack-logic denials stay out of scope: they
surface only as tool *results*, indistinguishable from ordinary output without per-pack parsing.

## Design

### 1. Denial collection (src/agents/runner.ts, src/agents/guards/index.ts, src/agents/resolve.ts)

One per-run collector, fed by both layers, correlated exactly — no bus time-window heuristics:

```ts
export interface DeniedTool { tool: string; reason: string; layer: "allowlist" | "guard" }
```

- `SpecialistResult` gains `denials?: DeniedTool[]`.
- **Allowlist layer:** `makeRunSpecialist` already creates the observer callback per run
  (`runner.ts:146`); it additionally pushes `{tool, reason: "not in allowlist", layer:
  "allowlist"}` into a local array. Bus emission unchanged.
- **Guard layer:** `guardOptions(checks, fallback)` gains an optional third parameter
  `onDeny?: (tool: string, reason: string) => void`, called on every deny verdict (both the
  per-tool check and the fallback-deny path). `resolveAgent` — already invoked once per run
  inside `makeRunSpecialist` — threads a callback from a new field on its opts bag down to every
  `guardOptions` call it makes (`resolve.ts:253`). Deduped per tool per run, mirroring the
  observer's `seen` set.
- **The thrown path:** a specialist failure throws (`Specialist X failed: error_max_turns`) and
  the result object never returns — exactly the burn-turns-against-the-wall case. A
  `SpecialistError extends Error { denials: DeniedTool[] }` replaces the plain `throw new
  Error(...)` at `runner.ts:171-176`, carrying the same array.

### 2. The park (src/engine/workers.ts)

`runAttempt` keeps a per-attempt `denied: Map<string, DeniedTool>` merged from every `runAgent`
result and from caught `SpecialistError`s (a loop/verify attempt makes several agent calls — all
feed the same map).

When an attempt finishes `outcome: "error"` **and** the map is non-empty, the node parks instead
of joining the retry treadmill:

- Save `${spec.key}-a${attempt}-denied.md` — the attempt error plus the denial table — because
  `review.requested` requires a `lastArtifactRef` and the UI should show what happened.
- Atomic append: `attempt.finished{outcome:"error"}` + `review.requested{objections}` — one
  objection per denied tool:
  - allowlist layer: `` `atlas was denied: Agent (not in allowlist). A permission grant is queued
    in Actions — approve it (or reject), then Retry.` ``
  - guard layer: `` `atlas was denied: Bash — "advisory context: filesystem/exec disabled — use
    recall/vault_read". This is engine policy, not a grantable permission; fix the cause (e.g.
    reopen with guidance, or give the goal a workspace) and Retry.` `` — the guard's reason
    verbatim, because it names the actual wall.
- The attempt still counts (chosen: park fires on the FIRST errored attempt with denials — no
  second attempt burns against a deterministic wall; an incidental-denial false positive costs
  one Retry click, since Retry bypasses the cap).

**Not** parked: `outcome` timeout / aborted / session-limit / api-unreachable — infra failures
keep their existing semantics even if a denial occurred earlier in the attempt. And an attempt
that succeeds with denials recorded parks nothing — the agent worked around the wall.

The park reuses `needs-review` wholesale: wall-time exemption, `FailNode` sweep skip, the
deadlock guard's `anyNeedsReview` check, Retry-with-guidance, accept-with-waiver, abandon — all
existing and already pinned by tests.

### 3. Auto-propose (src/engine/engine.ts, src/engine/workers.ts, src/index.ts)

`WorkerDeps` and `GoalEngineDeps` gain optional
`proposeGrant?: (role: string, tool: string) => Promise<void>`; the engine threads it through.
At park time the worker calls it once per **allowlist-layer** denial only. Guard-layer denials
never propose — no grant fixes them, and a queued no-op grant is worse than nothing (it teaches
the human that approving does nothing).

`src/index.ts` wires the dep to the gate:

```ts
proposeGrant: async (role, tool) => {
  const queued = store.listActions("proposed", 200).some((a) =>
    a.type === "permission.grant" &&
    (JSON.parse(a.payload) as { role?: string; tool?: string }).role === role &&
    (JSON.parse(a.payload) as { role?: string; tool?: string }).tool === tool);
  if (queued) return; // never double-propose
  await gate.propose(
    { type: "permission.grant", payload: { role, tool }, preview: "" },
    { channel: "engine", chatId: "goals" },
  );
},
```

Always-supervised (`trust.ts:35`) — nothing applies without a human verdict. Engine-origin
proposals do not ping chat channels (existing behaviour); the review park is the notification.
A `proposeGrant` failure is caught and logged, never fails the park — the objections still name
the tool, so the human can grant manually.

### 4. The loop closes with zero new surfaces

Human flow, entirely on existing buttons: Actions queue → **Approve** (executor writes the
grant) → node **Retry**. The retry resolves `effectiveAllowedTools` fresh, so the tool is live.
Deny flow: **Reject** the proposal, then Retry (the agent tries without) or Abandon the node.
Guard-layer flow: read the verbatim reason, fix the cause (guidance via ⑮ reopen/Retry, or by
hand as the human did today), Retry.

No new node status, no new journal event, no new API, no new UI. The whole cycle is: a collector,
a park condition, and one wiring closure.

## Security posture

Strictly narrowing-safe. No permission is ever granted by this cycle's code — the auto-propose
path can only *queue* an always-supervised `permission.grant`, and the executor behind human
approval is unchanged. The collector observes denials; it cannot influence a permission decision.
Guard denials are reported, never bypassed — `advisoryGuard`, workspace write-fencing, and
`denyExec` keep exactly their current force. The one new information flow (denial reasons into
review objections) exposes strings the agent already saw in its own transcript.

## Testing

TDD, root `test/`:

1. **Runner** (`test/` beside existing runner coverage): a run whose observer denies a tool
   returns `denials` on the result with `layer: "allowlist"`; a guard deny reaches the collector
   with `layer: "guard"` and the guard's reason; the thrown path carries `denials` on
   `SpecialistError`; deduped per tool per run.
2. **Workers**: attempt errors + allowlist denial → `attempt.finished{error}` +
   `review.requested` whose objection names the tool and the Actions queue; `proposeGrant`
   called exactly once for that tool.
3. **Workers**: guard-layer denial → parks with the verbatim guard reason in the objection;
   `proposeGrant` NOT called.
4. **Workers**: mixed layers in one attempt → both objections, `proposeGrant` only for the
   allowlist one.
5. **Workers**: attempt succeeds despite denials → no park, no proposal, node completes.
6. **Workers**: timeout / session-limit / api-unreachable with denials recorded → existing
   semantics exactly (no park, no proposal); pinned per path.
7. **Workers**: a thrown `SpecialistError` with denials parks; a plain thrown error without
   denials keeps today's plain-error path.
8. **Wiring**: the index.ts closure dedupes against an already-queued identical proposal
   (tested at the closure level with a fake store/gate).
9. Existing suites green untouched — especially `review.resolved{retry}` and the ⑭/⑮ blocks.

Live verification: a goal briefed to need a tool outside its agent's allowlist (e.g. clio +
`Bash`) → node parks `needs-review` naming the tool, `permission.grant` sits in the Actions
queue → approve via API → Retry → node completes using the tool. Then the guard variant: a
no-workspace code-pack goal touching the filesystem → parks with the advisory reason, **no**
proposal queued. Revoke any live-test grant afterwards (`permission.revoke` through the same
gate) — test grants must not outlive the test.

## Non-goals

- **Pack-logic denials** (`may only propose: [vault.write]`) — only visible as tool results;
  parsing per-pack output is not worth the surface. The ⑭ blockers already carry them to the
  human in prose.
- **Per-goal or time-boxed grants** — grants are role-global and permanent, guarded by the
  always-supervised gate. Scoped grants are a future cycle if the audit trail ever shows
  regret-grants.
- **Auto-granting anything**, under any trust level. `permission.grant` stays always-supervised.
- **The planner picking workspace-less agents for filesystem work** (today's root cause) — a
  planning-quality issue, not an approval-loop issue. The park now makes it visible and cheap to
  recover; fixing plan-time detection is its own cycle.
- **vault_read serving non-markdown files** (`writer.ts:112`, found today) — real ceiling, third
  wall of the incident, separate small cycle if wanted.
- **One-click "approve + retry"** — two clicks on two existing surfaces is acceptable; fusing
  them needs a new API and can wait for the ⑱ triage inbox.
