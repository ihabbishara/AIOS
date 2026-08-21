// ui2/src/lib/offers.ts — what an idle agent could do, said in its own voice.
//
// This is the COMPLEMENT of the needs-you queue, not a second copy of it. The Dock
// already carries everything a human is blocking: approvals, parked reviews, agent
// asks, recently-failed and paused goals, unread user mail. An offer is work that
// nobody is waiting on — which is why it only surfaces at the low tide, and why
// anything the attention view already lists is excluded here rather than shown twice.
import type { AttentionItem, GoalView, OrgAgentCard, OrgDepartmentView } from "../api.js";
import { agentClock, daysBetween } from "./staff-clock.js";

export interface Offer {
  /** "revive:<goalId>" | "inbox:<agent>" | "hands:<agent>" — stable across rebuilds,
   *  so the arrival animation fires once per genuinely new offer. */
  id: string;
  agent: string;
  kind: "revive" | "inbox" | "hands";
  text: string;
  action: { nav: string } | { chat: { target: string; seed: string } };
  ts: string;
}

/** Three, because the strip is the low tide's whole caption. A fourth line reads as
 *  a list to work through, which is exactly what the Dock is for. */
export const OFFERS_MAX = 3;

/** The attention view's own failed-goal window (src/web/attention-view.ts). Inside it
 *  the Dock owns the goal; past it nothing is watching any more, which is precisely
 *  when the lead offering to pick it back up is worth something. */
const REVIVE_AFTER_MS = 48 * 3_600_000;

/** revive first: an abandoned goal is real work with a plan already attached. hands
 *  last: it is the only offer with no artifact behind it. */
const RANK: Record<Offer["kind"], number> = { revive: 0, inbox: 1, hands: 2 };

function firstLine(s: string, max = 90): string {
  const l = s.split("\n")[0].trim();
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function buildOffers(args: {
  org: OrgDepartmentView[];
  /** undefined while /api/goals is in flight or failed — contributes no offers rather
   *  than an agent claiming it has nothing to revive. */
  goals: GoalView[] | undefined;
  unreadByAgent: Record<string, number> | undefined;
  attention: AttentionItem[];
  /** YYYY-MM-DD — the same day-granular axis lastActiveAt is measured on. */
  today: string;
  now: number;
}): Offer[] {
  const { org, goals, unreadByAgent, attention, today, now } = args;

  const idle = new Map<string, OrgAgentCard>();
  for (const d of org) for (const a of d.agents) if (a.status === "idle") idle.set(a.name, a);

  // Every goal the Dock is already showing, however it got there: a failed/paused row
  // carries the id in ref.goalId, a parked review carries it alongside its node key,
  // and an ask blocking a goal carries it too. Matching on ref (not the row id, which
  // is "<goalId>:<node>" for reviews) is what makes the exclusion honest.
  const claimed = new Set<string>();
  for (const i of attention) {
    if (i.ref.goalId) claimed.add(i.ref.goalId);
    if (i.kind === "goal") claimed.add(i.id);
  }

  const offers: Offer[] = [];

  for (const g of goals ?? []) {
    if (g.status !== "failed" || claimed.has(g.id)) continue;
    if (!idle.has(g.lead)) continue;
    if (!(Date.parse(g.updatedAt) <= now - REVIVE_AFTER_MS)) continue;
    const d = daysBetween(g.updatedAt.slice(0, 10), today);
    offers.push({
      id: `revive:${g.id}`,
      agent: g.lead,
      kind: "revive",
      text: `I could pick "${g.title}" back up — it failed ${d} ${plural(d, "day", "days")} ago.`,
      action: { nav: `goals/${g.slug || g.id}` },
      ts: g.updatedAt,
    });
  }

  const nowIso = new Date(now).toISOString();
  for (const [name] of idle) {
    const n = unreadByAgent?.[name] ?? 0;
    if (n <= 0) continue;
    offers.push({
      id: `inbox:${name}`,
      agent: name,
      kind: "inbox",
      text: `${n} unread ${plural(n, "memo", "memos")} in my inbox — want me to work through ${plural(n, "it", "them")}?`,
      action: {
        chat: {
          target: name,
          seed: `You have ${n} unread ${plural(n, "memo", "memos")} — please process ${plural(n, "it", "them")} and report back.`,
        },
      },
      ts: nowIso,
    });
  }

  // At most one pair of idle hands, and the stalest pair. Every stale agent offering
  // itself at once would fill the strip with the one offer that has no work behind it.
  const stale = [...idle.values()]
    .filter((a) => agentClock(a.lastActiveAt, today) === "stale" && a.charter.trim() !== "")
    .sort((a, b) => (a.lastActiveAt! < b.lastActiveAt! ? -1 : a.lastActiveAt! > b.lastActiveAt! ? 1 : a.name.localeCompare(b.name)));
  const hands = stale[0];
  if (hands) {
    const d = daysBetween(hands.lastActiveAt!, today);
    offers.push({
      id: `hands:${hands.name}`,
      agent: hands.name,
      kind: "hands",
      text: `My hands are free — nothing has needed me in ${d} ${plural(d, "day", "days")}.`,
      action: {
        chat: {
          target: hands.name,
          seed: `Nothing has needed you in ${d} ${plural(d, "day", "days")}. Your charter: ${firstLine(hands.charter)} — what is the most useful thing you could do about it today?`,
        },
      },
      ts: hands.lastActiveAt!,
    });
  }

  // id last, so a shuffled org or goal list can never reorder the strip.
  return offers
    .sort((a, b) =>
      RANK[a.kind] - RANK[b.kind] ||
      (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0) ||
      a.id.localeCompare(b.id))
    .slice(0, OFFERS_MAX);
}
