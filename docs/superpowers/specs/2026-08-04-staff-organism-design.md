# Staff — the roster as a living thing

Applies the Organism language (2026-08-02 Home spec) to Staff. Fourth section
converted, after home, goals and mail.

This describes what is built. It is not a plan and there is nothing to execute.

## 0. What the store actually says

Interrogated before choosing a shape, because two prior cycles were nearly
designed against a guess. Counts on 2026-08-04, **canonicalized through
`registry.agentOf`** — see §1, which is the whole reason the first pass was wrong.

| agent | dept | goals led | nodes | mail | usd | runs | last active |
|---|---|---|---|---|---|---|---|
| odin | engineering | 0 | 20 | 1 | **480.52** | 38 | Jul 26 |
| clio | research | 19 | 29 | 23 | 83.36 | 48 | **Aug 4** |
| vulcan | engineering | 0 | 20 | 6 | 45.94 | 41 | Aug 2 |
| minos | research | 0 | **0** | **0** | 23.51 | **46** | Jul 31 |
| argus | engineering | 0 | 8 | 1 | 21.00 | 26 | Aug 2 |
| janus | research | 0 | 6 | 0 | 13.95 | 7 | Jul 29 |
| themis | engineering | 0 | 7 | 0 | 10.14 | 14 | Jul 31 |
| athena | engineering | **26** | 7 | 13 | 8.74 | 24 | Aug 3 |
| atlas | engineering | 0 | 5 | 7 | 4.40 | 12 | Jul 30 |
| venus | research | 0 | 1 | 0 | 0.75 | 2 | Jul 31 |
| halalo | clients | 1 | 1 | 2 | 0.67 | 1 | Jul 16 |
| jasmine | life | 2 | 2 | 3 | 0.44 | 2 | Jul 11 |
| neo | operations | 9 | 1 | 13 | 0.38 | 1 | Jul 20 |
| juno | finance | 0 | 0 | 0 | 0.00 | 0 | **never** |
| midas | finance | 0 | 0 | 0 | 0.00 | 0 | **never** |

Four facts the old view could not show:

1. **odin is 69% of all spend** ($480.52 of $693.80), leads nothing, and went
   quiet 9 days ago. Its card read `$0 today` — identical to juno, which has
   never run at all.
2. **Finance works only in chat.** juno and midas have run 16 times between them
   and produced no goal, no node, no mail and no cost — see §3.1, which is the
   correction that followed the first cut of this spec.
3. **minos has 46 runs and zero nodes, mail and goals.** Money in, nothing out.
4. **Leading and doing are disjoint.** athena leads 26 goals on $8.74; neo leads
   9 with a single node; odin and vulcan execute 20 nodes each and lead nothing.
   clio alone does both.

## 1. The rename trap (why the first read of this data was wrong)

Agents were renamed twice — `895944a` (role names → mythological, "old names stay
as aliases") and `053b651` (hermes → neo). Every write path stores **whatever
name the router emitted**, so one agent has rows under every name it has held.

Grouping `cost_daily` on the raw `agent` column produces nine plausible-looking
agents that are not in the roster, holding **73% of all spend** — and the reading
"most of the org's money went to staff who no longer exist", which is false.
`researcher` is odin. `developer` is vulcan. `architect` is athena. `reviewer` is
minos. `tester` is argus. `code-reviewer` is themis. `market-researcher` is
janus. `ui-ux-designer` is venus. `hermes` is neo.

**Any aggregate keyed by agent MUST fold through `registry.agentOf` first, and
MUST accumulate rather than assign** — several raw names collapse onto one
canonical agent. `buildOrgView` already did this for today's cost;
`GET /api/costs` did not, and shipped the split view to System. Fixed here via
`costsByAgentCanonical`.

A name that does not resolve is **kept, not dropped** — an agent deleted outright
has no alias to fold into, and discarding its rows would silently understate the
total.

## 2. The card

The department org chart stays the frame: structure is the one thing the registry
actually asserts, and it does not lie. What changes is what a card *leads with*.

Before, a card led with `costTodayUsd`, which is `0` for nearly every agent nearly
always — so 99% of the time the card was static registry data with a dead number
attached.

Now the card leads with **aliveness**, and colour is the clock:

```
● vulcan   Senior Engineer                    2 days ago
  20 nodes · 6 mail · $45.94

○ odin     Researcher                         9 days ago
  20 nodes · 1 mail · $480.52

· juno     Finance                              never run
  hired, never run
```

- **recent** (`bg-now` / `text-now`) — active within `RECENT_DAYS`
- **stale** (`bg-past` / `text-past`) — ran once, has gone quiet
- **never** (`bg-line` / `text-dim`, card at `opacity-55`) — no history at all

The secondary line is lifetime work, **goals led first** because the lead/doer
split is the point of it: `9 goals led · 1 nodes · 13 mail · $0.38`. Each part is
omitted when zero, so minos renders `$23.51` alone — spend with nothing to show
for it, which is the finding, not a rendering bug. Only an agent with no history
whatsoever falls back to `hired, never run`.

### Threshold

`RECENT_DAYS = 7`. Against the real roster it splits **9 recent / 4 stale /
2 never**. At 3 days only 4 agents survive; at 30 nothing is ever stale and the
colour stops meaning anything. Seven days is also longer than a working week, so
a Friday-only agent still reads alive on the following Thursday.

### Motion

The dot breathes **only** when `status === "working"` — a run happening right
now. Recent activity is not motion; it already happened. No new `@keyframes`:
this reuses `breath`, which is in the doctrine allowlist and already rendered.

## 3. Last active

`lastActiveAt` is the max across **five** sources: cost, nodes, mail, goals led,
and completed runs. Cost alone is not enough — it says clio went quiet on Jul 31
when clio sent mail *today*, and that single-source reading is what produced the
false claim "nothing has run in two days."

### 3.1 Runs are load-bearing, not a refinement

The first cut of this section used the four **artifact** sources only, and was
wrong on three of fifteen cards:

| agent | artifacts say | truth | completed runs |
|---|---|---|---|
| neo | 15 days stale | **ran today** | 591 |
| midas | never run | Jul 13 | 22 |
| juno | never run | Jun 28 | 10 |

`neo` is the moderator and the most-invoked agent in the org; it rendered as
going quiet. The cause is that **a chat run leaves no artifact at all** — no
goal, no node, no mail — and **570 of 875 `agent.end` events (65%) carry no
`costUsd`**, so `attachBudgetLedger` never writes a `cost_daily` row for them.
Artifacts describe goal execution; they do not describe an org that mostly
answers questions.

`store.runsByAgent()` reads `agent.end` from the event stream and is folded on
the same canonical path as the rest. An agent that has run but produced nothing
renders `10 runs · no output` rather than a blank line.

With runs counted, **no agent on the current roster is in the `never` state.** It
is kept because a newly hired agent genuinely has no history, and because
rendering "never" only when it is true is the point of the distinction.

It is a **date** (`YYYY-MM-DD`), not a timestamp. `cost_daily` has no time
column, so a full ISO stamp would be false precision on one of the four inputs.
`null` means never — distinct from "0 today", which is the distinction the old
card could not draw.

## 4. Deliberately not done

- **No lead/doer grouping.** The data supports it (§0.4) but it would replace the
  department chart, which was kept on purpose. It lives inside the card instead,
  as `goals led` before `nodes`.
- **No cost ranking or department subtotals.** Would make odin's $480 the
  headline of the section; aliveness is the headline, cost is a supporting number.
- **No runs→output ratio.** minos's 46-runs-for-nothing shows up as an absence on
  the card. A `$/node` column reads as a verdict on an agent, on 3 failed nodes
  org-wide — not enough evidence to accuse anything.
- **Trust is not on the card.** `trust` is keyed by `action_type` (5 rows), not by
  agent. There is nothing per-agent to hang there.
- **Governance tab untouched.**

## 5. Open

- **`runs` shows only as a fallback**, when an agent has no artifacts at all. On
  every other card the number is omitted, so neo's 591 runs against $0.38 of
  recorded cost is not visible. A runs column on every card is arguable; it was
  left out to keep the second line short.
- **`runsByAgent()` scans the whole `events` table** (11,812 rows) on every
  `/api/org`. Fine now, and `pruneEvents` exists, but it is the first query here
  that grows without bound.
- **Finance produces nothing durable.** Its agents answer in chat and write no
  goal, node or mail. That is a roster question, not a UI one — the section now
  reports it accurately either way.
- **`RECENT_DAYS` is tuned to a roster that works most days.** If the org goes
  quiet for a fortnight, everything reads stale at once and the axis flattens.
  Revisit if a whole department is legitimately seasonal.
