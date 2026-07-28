// src/web/attention-view.ts — pure builder behind /api/attention (Ember Cockpit spec §5, §9.1).
// Assembles the unified needs-you queue server-side: proposed actions + nodes parked for
// review (verification-hardening §4) + user asks + failed/paused goals + unread user mail +
// degraded senses.
import type { Store } from "../store/db.js";
import type { AttentionItem } from "./dto.js";

export type { AttentionItem } from "./dto.js";
export type SensesFn = () => Array<{ name: string; ok: boolean; reason?: string }>;

const FAILED_WINDOW_MS = 48 * 3_600_000;

function firstLine(s: string, max = 140): string {
  const l = s.split("\n")[0].trim();
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
}

export function buildAttentionView(
  store: Store,
  senses?: SensesFn,
  now: () => Date = () => new Date(),
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const nowIso = now().toISOString();

  // 2 — nodes parked at a quality cap awaiting a verdict (verification-hardening §4).
  // Built before approvals: a policy-wall park's auto-proposed permission.grant folds into
  // its review row (one human decision, one row — triage-inbox spec §A), matched by the
  // exact denial line workers.ts writes into the objections.
  const linkedGrantIds = new Set<string>();
  const proposedGrants = store.listActions("proposed", 200)
    .filter((a) => a.type === "permission.grant" && a.expires_at > nowIso)
    .map((a) => {
      const p = JSON.parse(a.payload) as { role?: string; tool?: string };
      return { id: a.id, role: p.role ?? "", tool: p.tool ?? "" };
    });
  for (const n of store.needsReviewNodes()) {
    const grants = proposedGrants.filter((g) =>
      (n.error ?? "").includes(`${g.role} was denied: ${g.tool} (not in allowlist)`));
    for (const g of grants) linkedGrantIds.add(g.id);
    items.push({
      kind: "review", id: `${n.goal_id}:${n.node_key}`,
      title: `${n.goal_title} · ${n.node_key} hit its quality cap`,
      meta: firstLine(n.error ?? "no objections recorded"),
      severity: 2, ts: n.finished_at ?? nowIso,
      actions: ["accept", "retry", "abandon", "open"],
      ref: {
        goalId: n.goal_id, node: n.node_key, slug: n.goal_slug,
        ...(n.artifact ? { artifact: n.artifact } : {}),
      },
      ...(grants.length ? { grants } : {}),
    });
  }

  // 1 — approvals (proposed, not yet expired; the sweep is lazy so filter here too).
  // Grants folded into a review row above are skipped — resolving them happens there.
  for (const a of store.listActions("proposed", 100)) {
    if (a.expires_at <= nowIso) continue;
    if (linkedGrantIds.has(a.id)) continue;
    items.push({
      kind: "approval", id: a.id, title: firstLine(a.preview),
      meta: `${a.type} · expires ${a.expires_at.slice(5, 16).replace("T", " ")}`,
      severity: 1, ts: a.created_at, actions: ["approve", "reject", "open"],
      ref: { actionId: a.id },
    });
  }

  // 2 — agent asks blocking parked goals
  for (const m of store.pendingUserAsks()) {
    items.push({
      kind: "ask", id: m.id, title: firstLine(m.body),
      meta: `${m.from_agent} is blocked on your answer`,
      severity: 2, ts: m.created_at, actions: ["answer", "open"],
      ref: { mailId: m.id, threadId: m.thread_id ?? m.id, ...(m.goal_id ? { goalId: m.goal_id } : {}) },
    });
  }

  // 3 — failed (48h window on updated_at) + paused goals (any age)
  const cutoff = new Date(now().getTime() - FAILED_WINDOW_MS).toISOString();
  const failed = store.goalsUpdatedSince(cutoff).filter((g) => g.status === "failed" && g.legacy !== 1);
  const pausedUser = store.listGoals(200).filter((g) => g.status === "paused-user" && g.legacy !== 1);
  for (const g of [...failed, ...store.pausedBudgetGoals(), ...store.pausedApiGoals(), ...store.pausedSessionGoals(), ...pausedUser]) {
    items.push({
      kind: "goal", id: g.id, title: g.title,
      meta: `${g.department} · ${g.status === "failed" ? firstLine(g.error ?? "failed", 80) : g.status}`,
      severity: 3, ts: g.updated_at,
      actions: g.status === "failed" ? ["open", "reopen", "abandon"] : ["open", "resume", "abandon"],
      ref: { goalId: g.id, slug: g.slug, status: g.status },
    });
  }

  // 4 — unread user mail (a thread whose only flag is a pending ask is already ranked 2)
  for (const t of store.userThreads()) {
    if (t.unread === 0 || t.pending_ask > 0) continue;
    items.push({
      kind: "mail", id: t.thread_id, title: firstLine(t.last_body), meta: `from ${t.last_from}`,
      severity: 4, ts: t.last_ts, actions: ["open", "read"], ref: { threadId: t.thread_id },
    });
  }

  // 5 — ambient: degraded senses
  for (const s of senses?.() ?? []) {
    if (s.ok) continue;
    items.push({
      kind: "sense", id: s.name, title: `${s.name} needs attention`, meta: s.reason ?? "degraded",
      severity: 5, ts: nowIso, actions: ["open"], ref: { sense: s.name },
    });
  }

  return items.sort((a, b) => a.severity - b.severity || (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}
