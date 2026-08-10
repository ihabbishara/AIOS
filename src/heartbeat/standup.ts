// src/heartbeat/standup.ts — daily lead standups (spec §6). Deterministic digest, one lead
// one-shot per ACTIVE department, result lands as standup mail to neo.
import { randomUUID } from "node:crypto";
import type { Store, GoalRow } from "../store/db.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import type { SpecialistRunFn } from "../agents/runner.js";
import type { SpendGuard } from "../engine/budget.js";
import type { AiosEvent } from "../events.js";
import { wallVerdict, type Policy } from "../kernel/policy.js";
import { deptLabel } from "../kernel/labels.js";

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function membersOf(registry: LoadedRegistry, dept: string): Set<string> {
  return new Set([...registry.agents.entries()].filter(([, a]) => a.department === dept).map(([n]) => n));
}

/** Departments with last-24h activity. Private-labeled departments (finance) NEVER run standups —
 *  the policy table denies their label at the standup sink (wall-deletion spec). */
export function activeDepartments(store: Store, registry: LoadedRegistry, sinceIso: string, policy?: Policy): string[] {
  const recentGoals = store.goalsUpdatedSince(sinceIso);
  const recentMail = store.listMail(undefined, 500).filter((m) => m.created_at >= sinceIso);
  const out: string[] = [];
  for (const dept of registry.departments.keys()) {
    // The table is the wall (wall-deletion spec): personal.finance denies the standup sink,
    // which is exactly the old privateMemo carve-out — standup notes are vaulted + indexed.
    if (wallVerdict(policy, { labels: [deptLabel(dept)], sink: "standup" }, "standup:dept", dept) === "deny") continue;
    const members = membersOf(registry, dept);
    const active =
      recentGoals.some((g) => g.department === dept) ||
      recentMail.some((m) => members.has(m.from_agent));
    if (active) out.push(dept);
  }
  return out;
}

/** Pure data digest — reads goals/task_nodes/mail ONLY (never personal_*, never email content). */
export function standupDigest(store: Store, registry: LoadedRegistry, dept: string, sinceIso: string): string {
  const members = membersOf(registry, dept);
  const goals = store.goalsUpdatedSince(sinceIso).filter((g) => g.department === dept);
  const line = (g: GoalRow) => {
    const cost = store.listNodes(g.id).reduce((s, n) => s + n.cost_cents, 0);
    return `- ${g.title} [${g.status}]${cost ? ` ${usd(cost)}` : ""}${g.error ? ` — ${g.error.slice(0, 200)}` : ""}`;
  };
  const finished = goals.filter((g) => ["done", "failed", "abandoned"].includes(g.status));
  const open = goals.filter((g) => !["done", "failed", "abandoned"].includes(g.status));
  const mail = store.listMail(undefined, 500).filter((m) => m.created_at >= sinceIso);
  const sent = mail.filter((m) => members.has(m.from_agent)).length;
  const received = mail.filter((m) => members.has(m.to_agent)).length;
  const queued = store.queuedRequests().filter((m) => members.has(m.to_agent)).length;
  return [
    "# Yesterday", ...(finished.length ? finished.map(line) : ["- (nothing finished)"]),
    "# In flight", ...(open.length ? open.map(line) : ["- (nothing running)"]),
    `# Mail\n- mail sent: ${sent}, received: ${received}, queued requests for your team: ${queued}`,
  ].join("\n");
}

export interface StandupDeps {
  store: Store;
  registry: LoadedRegistry;
  run: SpecialistRunFn;
  spendGuard: SpendGuard;
  onEvent?: (e: AiosEvent) => void;
  policy?: Policy;
  log?: (l: string) => void;
  nowFn?: () => Date;
}

const PROMPT =
  "Write your department's daily standup for the chief of staff — exactly 3 lines: " +
  "done / today / blockers. Max 60 words total, plain text. Your department's last-24h data:\n\n";

/** One lead one-shot per active dept; standup lands as mail lead→neo. Returns count written. */
export async function runStandups(deps: StandupDeps): Promise<number> {
  const now = (deps.nowFn ?? (() => new Date()))();
  const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  let written = 0;
  for (const dept of activeDepartments(deps.store, deps.registry, since, deps.policy)) {
    if (!deps.spendGuard.allow()) {
      deps.log?.(`standups: budget cap reached, skipping remaining departments`);
      break;
    }
    const lead = deps.registry.departments.get(dept)?.lead;
    if (!lead) continue;
    const context = `standup:${dept}`;
    // start/end must be paired: an unpaired start leaves the lead stuck "working" forever in
    // the org view, whose liveRuns map clears only on agent.end.
    deps.onEvent?.({ type: "agent.start", agent: lead, context });
    let res;
    try {
      res = await deps.run(lead, PROMPT + standupDigest(deps.store, deps.registry, dept, since), {
        cwd: process.cwd(),
      });
    } catch (err) {
      deps.onEvent?.({ type: "agent.end", agent: lead, context, ok: false });
      deps.log?.(`standup for ${dept} failed: ${(err as Error).message}`); // fail-silent per dept
      continue;
    }
    // Bill the moment the turn returns, BEFORE the mail write: the spend is real whether or not
    // the mail lands, and costUsd on agent.end is the ONLY thing attachBudgetLedger and the
    // cost_daily rollup read. 48 standups ran before this line existed, every one recorded free.
    deps.onEvent?.({ type: "agent.end", agent: lead, context, ok: true, costUsd: res.costUsd, turns: res.numTurns });
    try {
      const id = randomUUID();
      deps.store.insertMail({
        id, from_agent: lead, to_agent: "neo", kind: "standup", body: res.text.slice(0, 1200),
        goal_id: null, origin_channel: "system", origin_chat_id: "standup",
        chain_depth: 1, status: "unread", error: null,
      });
      deps.onEvent?.({ type: "mail.sent", id, from: lead, to: "neo", kind: "standup" });
      written++;
    } catch (err) {
      // Contained per dept, as the run failure is: one bad mail write must not cost the
      // remaining departments their standup.
      deps.log?.(`standup mail for ${dept} failed: ${(err as Error).message}`);
    }
  }
  return written;
}
