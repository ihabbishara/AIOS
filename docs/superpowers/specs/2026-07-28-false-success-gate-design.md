# The false-success gate — a run node must not complete on an agent saying it could not work

## Problem

Goal `c03a3bda` ("apply audit blocker fixes to deck-full.md") produced two nodes that the engine
recorded as successful and that a downstream node then built on. Both artifacts say, in the agent's
own words, that no work was done.

The journal, verbatim:

```
gseq 11  attempt.finished  {"node":"fix-blockers-1-2-6","attempt":1,"outcome":"ok","costCents":15,"turns":10}
gseq 12  node.completed    {"node":"fix-blockers-1-2-6","artifactRef":"fix-blockers-1-2-6.md",...}
gseq 14  attempt.finished  {"node":"fix-gap-registers","attempt":1,"outcome":"ok","costCents":11,"turns":6}
gseq 15  node.completed    {"node":"fix-gap-registers","artifactRef":"fix-gap-registers.md",...}
```

The artifacts those two events point at:

```
fix-blockers-1-2-6.md → "I could not apply any fixes — the target files do not exist and I have
                         exhausted the tool budget locating them."
fix-gap-registers.md  → "I can't do this — the premise is wrong. `deck-final.md` does not exist,
                         and neither does the goal folder."
```

The agents behaved correctly. Told to edit a file that was not reachable from their working
directory, they searched, failed, and said so plainly instead of fabricating changelog lines. The
engine is what is wrong: it read articulate prose and called it a deliverable.

The failure then propagated. `fix-gap-registers` opens by citing its predecessor —
*"This matches the previous node's report verbatim: it was blocked, applied nothing"* — because
`ancestorArtifacts` (`workers.ts:54`) had handed it the first false success as established fact. A
node consumed a non-result as input and produced a second non-result. The goal ended on
`goal.failed {"error":"Goal wall-time budget exceeded"}`, which as usual names the last symptom and
not the cause.

Worth noting what the same journal shows immediately above: the node these two replaced,
`apply-blocker-fixes`, failed *honestly* twice (`error_max_turns`) and triggered a replan. The
engine handles an agent that crashes. It does not handle an agent that finishes cleanly and reports
that it accomplished nothing.

### Why the existing guards do not catch this

Three guards already stand in front of a run node's artifact, and this class walks past all of them:

- `isApiErrorOutput` (`workers.ts:42`) is anchored on `startsWith("api error:")` and deliberately
  stays that way — agents legitimately write *about* connection failures inside valid reports.
  A refusal is not an API error envelope.
- The empty-output guard (`workers.ts:250`) requires `!res.text.trim()`. These artifacts are 1.4 KB
  of well-organised markdown with bullet points.
- Any lexical sniff for "I could not" is the widening trap that ⑬ pinned a test against: a report
  that discusses a failure it investigated would match, and healthy goals would start erroring.

The asymmetry is the root cause. A `verify` node is safe because it demands a machine-checkable
`TestReport` and treats an unparseable one as a failed attempt (`workers.ts:329, 341`). A `loop`
node is safe because its critic must return a `Verdict`. A `run` node is gated by a string, and a
string cannot be checked. Every false success so far has lived in exactly that gap.

## Design

### 1. The contract (src/agents/roles/index.ts)

A third schema beside `VERDICT_SCHEMA` and `TEST_REPORT_SCHEMA`. The field `description`s carry the
whole instruction — no agent system prompt changes, no manifest edits, no golden regeneration:

```ts
export const WORK_REPORT_SCHEMA = {
  type: "object",
  properties: {
    completed: { type: "boolean", description:
      "true only if you actually produced the work this task asked for. false if you refused, were blocked, ran out of information, or produced only a placeholder or a description of what you would have done." },
    summary: { type: "string", description:
      "One or two sentences on what you produced, or on why you could not." },
    blockers: { type: "array", items: { type: "string" }, description:
      "Empty when completed is true. Otherwise one entry per concrete thing that stopped you." },
  },
  required: ["completed", "summary", "blockers"],
  additionalProperties: false,
} as const;
```

`export interface WorkReport { completed: boolean; summary: string; blockers: string[] }` joins
`Verdict` and `TestReport` in `workers.ts`.

This is deliberately **not** registered in `SCHEMA_BY_NAME` (`registry/loader.ts:13`). That map
exists so a manifest can tag an agent with a schema it always uses. The work report is not a
property of any agent — it is a property of being run as a `run` node — so it is injected per call
by the worker instead, and applies to every agent including ones that know nothing about it.

### 2. The gate (src/engine/workers.ts)

`runAgent` grows an optional third parameter, forwarded as `opts.outputSchema` on the underlying
`SpecialistRunFn` call. The seam already exists: `runner.ts:142` reads `role.outputSchema ??
opts.outputSchema`, and `runner.ts:143-145` widens `allowedTools` to include `StructuredOutput`
before the denial observer wraps — the ordering that ⑬ established and a test already pins.

`case "run"`, after the existing empty-output guard:

```ts
const res = await runAgent(spec.agent, brief, WORK_REPORT_SCHEMA);
if (!res.text.trim()) { /* unchanged: agent returned no output */ }
const rep = res.structured as Partial<WorkReport> | undefined;
if (rep?.completed === false) {
  finish("error", `did not complete: ${rep.blockers?.join("; ") || rep.summary || "no reason given"}`);
  return { claimed: true, outcome: "error", sessionLimit: false, apiUnreachable: false };
}
if (!rep) deps.log?.(`${spec.key}: no work report (agent ${spec.agent})`);
finish("ok", undefined, { artifactRef: save(file, res.text, spec.agent), roundsUsed: 0 });
```

Two properties are load-bearing:

**The artifact does not change.** `save()` still writes `res.text`. The report is read to decide
done-versus-error and then discarded; the blockers survive in the attempt error. On the happy path
the artifact is byte-identical to today, so no downstream node, context block, or vault consumer
sees a format shift. This also keeps large documents out of a JSON string field — `clio` and `minos`
write 40 KB reports, and pushing those through schema validation would invent a new failure mode
(`error_max_structured_output_retries`) in the exact place we are trying to add reliability.

The test is `rep?.completed === false`, not `!rep?.completed`, and that is not stylistic. An agent
carrying its own manifest schema (§4) returns a `Verdict` or a `TestReport` here, where `completed`
is `undefined` — under a truthiness test that object would error a node whose work was fine, which
is strictly worse than the hole being closed. Only an explicit `false` fails an attempt; every other
shape falls through to the lenient path below.

**A missing report is not an error.** If the model emits nothing parseable, the node falls back to
today's rule (non-empty text completes it) and the daemon logs which node and agent did so. This is
the deliberate lenient choice: the gate now sits in front of *every* run node in every goal, and
making the whole fleet depend on a tool call landing after a possibly-80-turn document write risks
reintroducing the ⑬ harm — infrastructure flakiness killing goals. Leniency means a misfire leaves
us no worse than today. The log line is how we learn whether reports land reliably in the wild; when
they do, this flips to strict and matches `verify`.

### 3. Blockers reach the retry (src/engine/workers.ts)

An identical retry of a deterministic refusal ("the source file does not exist") re-fails
identically and burns the second attempt for nothing. The retry brief therefore carries what the
previous attempt reported.

No new journal plumbing is required. `reduce.ts:170` already stores the attempt error on
`NodeState.lastError`, and nothing clears it before the next attempt — `review.resolved` clears
`lastVerdict`, `lastReport` and `lastFeedback` (`reduce.ts:226-228`) but deliberately leaves
`lastError` alone.

```ts
const prior = nodeState()?.lastError;
const blockers = prior?.startsWith("did not complete: ") ? prior.slice("did not complete: ".length) : "";
const brief = [
  spec.brief, ctx,
  blockers && `# Your previous attempt reported it could not complete\n${blockers}\n\nResolve these, or report completed:false again with what is still missing.`,
].filter(Boolean).join("\n\n");
```

The prefix test is what keeps this honest. `lastError` also holds timeouts, wall-clock messages and
transport errors; feeding `"Goal wall-time budget exceeded"` into an agent brief as though it were a
blocker would be noise at best and misdirection at worst. Only errors this code wrote are read back.
The prefix is a string contract between `workers.ts` and itself, so a test pins both directions.

### 4. Known ceilings

Each is marked with a `ponytail:` comment at the relevant line, naming the ceiling and the upgrade
path, rather than being silently absorbed:

- **No report means no gate** (§2). Upgrade: flip to strict once the log line shows reports landing.
- **A lying agent passes.** Self-attestation catches honest refusals — which is the entire observed
  class, three cases for three. An agent that claims `completed: true` having done nothing is not
  detected. Upgrade: a judge agent reading the output, at one extra call per run node.
- **`role.outputSchema ?? opts.outputSchema`** (`runner.ts:142`) — an agent carrying its own manifest
  schema keeps it and skips the gate. Today that is exactly two agents, `argus` (`test-report`) and
  `minos` (`verdict`), and both exist to serve gated node kinds. A plan that puts either in a `run`
  node loses the gate silently. Documented and pinned by a test rather than fixed: flipping the
  precedence globally to make the caller win is a larger blast radius than the case justifies.

## Security posture

Unchanged. No new tool is granted, no permission is widened beyond the `StructuredOutput` allowance
that `runner.ts:143` already applies whenever a schema is present, and no agent gains filesystem or
network reach. The gate reads a value the model produces and decides an outcome from it; the failure
mode of a compromised value is a node erroring that should have completed, never the reverse.

## Testing

TDD, root `test/workers.test.ts` (26 tests today), each written failing first:

1. `completed: false` yields `outcome: "error"`, the blockers appear in the attempt error text, and
   **no** `node.completed` is journaled.
2. `completed: false` with an empty `blockers` array falls back to `summary` in the error text.
   A report missing both falls back to `"no reason given"` rather than erroring on `undefined`.
3. `completed: true` completes the node and the saved artifact is byte-identical to `res.text` —
   the report contributes nothing to the artifact.
4. `structured: undefined` completes the node (lenient) and emits the log line.
5. The run fn receives `WORK_REPORT_SCHEMA` as `opts.outputSchema` for a `run` node.
6. A retry after `did not complete: X` carries `X` in the brief.
7. A retry after an unrelated `lastError` (`"timeout"`, `"Goal wall-time budget exceeded"`) carries
   **nothing** extra in the brief.
8. A `run` node whose agent returns a foreign structured shape — a `Verdict` (`{verdict, summary,
   reasons}`) with no `completed` key at all — still **completes**. This pins the `=== false` test:
   under a truthiness test this case would error, and it is reachable today via `argus` or `minos`.

Existing tests must stay green untouched, in particular the empty-output guard and the
`isApiErrorOutput` anchoring test.

Live verification: one real goal containing a node that cannot succeed (a file that does not exist),
confirming via `goal_journal` that the node reaches `outcome: "error"` with the blockers in the
error, and that the retry brief carried them. A false-positive check on the deployed daemon
afterwards: no healthy node newly erroring with `did not complete:`.

## Non-goals

- **Detecting a lying agent.** See §4. Out of scope by cost.
- **Gating loop producers.** A producer's output is reviewed by a critic that must return a
  `Verdict`, so a well-written refusal already draws a `revise` and burns rounds rather than
  completing. Adding a schema to every producer round would put the terse-text risk exactly where
  the prose matters most.
- **`SessionLimitError` still consumes an attempt.** Same flaw as api-unreachable had, carried
  forward from the ⑬ non-goals unchanged.
- **`max_turns` retried identically**, and **replan resetting the attempt budget**
  (`reduce.addNode` → `freshNode`). Both are visible in this very goal's journal — `apply-blocker-fixes`
  burned two identical `error_max_turns` attempts, then the replan handed its replacements a fresh
  budget. Both remain deferred by prior decision.
- **Reopening a failed goal.** Would need a `goal.reopened` event un-skipping skipped nodes. Cheap,
  since the journal already replays done nodes with artifacts, but out of scope here.
