// ui2/src/views/Goals.tsx — Command Deck kanban lanes; detail = DAG + inspector (spec §6).
import { useEffect, useState } from "react";
import { api, type GoalNodeView, type GoalView, type StoredEvent } from "../api.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { navigate, type Route } from "../lib/router.js";
import { provenance } from "../lib/goal-buckets.js";
import { groupByBand } from "../lib/goal-recency.js";
import { statusClock, CLOCK_TOKEN, CLOCK_TEXT, isMuted } from "../lib/goal-clock.js";
import { Button, Empty, PageHeader, SectionLabel, Tag, toneOfStatus } from "../components/ui.js";
import { TwoStepButton } from "../components/TwoStepButton.js";
import { ts, usd } from "../lib/format.js";
import { Thread } from "./Thread.js";

export function Goals({ events, route, onOpenChat }: {
  events: StoredEvent[]; route: Route; onOpenChat: (t: string, s?: string) => void;
}) {
  const slug = route.section === "goals" ? route.parts[0] : undefined;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="page">
        {slug ? <GoalDetailView slug={slug} events={events} onOpenChat={onOpenChat} /> : <GoalList events={events} />}
      </div>
    </div>
  );
}

export function GoalList({ events }: { events: StoredEvent[] }) {
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);
  const [dept, setDept] = useState<string>("");
  const [q, setQ] = useState("");
  if (!goals) return <Empty>Loading…</Empty>;

  const depts = [...new Set(goals.map((g) => g.department))].sort();
  const needle = q.trim().toLowerCase();
  const filtered = goals.filter((g) =>
    (!dept || g.department === dept) && (!needle || g.title.toLowerCase().includes(needle)));

  const weekAgo = Date.now() - 7 * 86_400_000;
  const weekCost = filtered
    .filter((g) => Date.parse(g.createdAt) >= weekAgo)
    .reduce((s, g) => s + g.nodes.reduce((n, x) => n + x.costCents, 0), 0);

  const bands = groupByBand(filtered, new Date());

  return (
    <div>
      <PageHeader title="Goals" meta={`${filtered.length} total · ${usd(weekCost)} this week`}>
        <select value={dept} onChange={(e) => setDept(e.target.value)}
          className="bg-surface border border-line rounded-md px-2 py-1 text-[12px] text-fg outline-none">
          <option value="">all departments</option>
          {depts.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter…"
          className="bg-surface border border-line rounded-md px-2 py-1 text-[12px] text-fg outline-none focus:border-dim w-40" />
      </PageHeader>

      {bands.length === 0 && <Empty>No goals yet</Empty>}

      {bands.map(({ key, label, items }) => (
        <div key={key} className="mb-7">
          <div className="label mb-2 flex items-center gap-2">
            {label}
            <span className="h-px flex-1 bg-line" />
            <span className="font-mono text-[10px] text-dim">{items.length}</span>
          </div>
          {items.map((g) => <GoalRow key={g.id} g={g} />)}
        </div>
      ))}
    </div>
  );
}

const VIA: Record<string, string> = { chat: "via chat", mail: "via mail", speculate: "speculated" };

function GoalRow({ g }: { g: GoalView }) {
  const clock = statusClock(g.status);
  const done = g.nodes.filter((n) => n.status === "done").length;
  const cost = g.nodes.reduce((s, n) => s + n.costCents, 0);
  const current = g.nodes.find((n) => statusClock(n.status) === "now");
  const artifacts = g.nodes.map((n) => n.artifact).filter((a): a is string => Boolean(a));

  return (
    <button onClick={() => navigate(`goals/${g.slug}`)}
      className={`w-full text-left flex gap-3 py-2.5 px-1 rounded-md hover:bg-raised ${
        isMuted(g.status) ? "opacity-55" : ""}`}>
      <span className={`size-1.5 rounded-full shrink-0 mt-[7px] ${CLOCK_TOKEN[clock]} ${
        clock === "now" ? "breath" : ""}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] text-bright truncate">{g.title}</span>
          <span className="text-[11px] text-dim shrink-0 ml-auto">{g.department} · {g.lead}</span>
        </div>
        <div className="flex items-baseline gap-2 mt-0.5 flex-wrap">
          <span className={`font-mono text-[10px] uppercase ${CLOCK_TEXT[clock]}`}>{g.status}</span>
          <span className="text-[10.5px] text-dim">
            {g.nodes.length === 1 ? "1 node" : `node ${done} of ${g.nodes.length}`}
          </span>
          {current && <span className="text-[10.5px] text-agent truncate">→ {current.key} · {current.agent}</span>}
          <span className="text-[10.5px] text-dim">{VIA[provenance(g.originChannel)]}</span>
          {artifacts.length > 0 && (
            <span className="text-[10.5px] text-info truncate">{artifacts.join(" · ")}</span>
          )}
          {cost > 0 && <span className="font-mono text-[10.5px] text-dim ml-auto shrink-0">{usd(cost)}</span>}
        </div>
      </div>
    </button>
  );
}

function GoalDetailView({ slug, events, onOpenChat }: {
  slug: string; events: StoredEvent[]; onOpenChat: (t: string, s?: string) => void;
}) {
  const { data: goal, error } = useLiveQuery(() => api.goal(slug), events, T.goals, [slug]);
  const [nodeKey, setNodeKey] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [askError, setAskError] = useState("");
  const [actionError, setActionError] = useState("");
  const [reopenGuidance, setReopenGuidance] = useState("");
  // A refused action leaves the status untouched, so once it changes the notice is stale — drop it.
  useEffect(() => setActionError(""), [goal?.status]);
  if (error) return <Empty>{error}</Empty>;
  if (!goal) return <Empty>Loading…</Empty>;
  // Inspector never starts empty: explicit pick → the failure → the node in flight → the first.
  const node: GoalNodeView | undefined =
    goal.nodes.find((n) => n.key === nodeKey)
    ?? goal.nodes.find((n) => n.status === "failed")
    ?? goal.nodes.find((n) => ["running", "working", "executing"].includes(n.status))
    ?? goal.nodes[0];
  const cost = goal.nodes.reduce((s, n) => s + n.costCents, 0);
  const failedKey = goal.nodes.find((n) => n.status === "failed")?.key;

  // The endpoint answers 200 with a plain-string reason even when it refuses (e.g. a frozen
  // legacy or already-terminal goal), so a swallowed message reads as a dead button. Surface it;
  // on success the status flips and the effect above clears the (now stale) notice.
  const verb = async (v: "pause" | "resume" | "abandon" | "reopen") => {
    setActionError("");
    try {
      const body = v === "reopen" && reopenGuidance.trim() ? { guidance: reopenGuidance.trim() } : undefined;
      setActionError((await api.goalAction(goal.id, v, body)).message);
      if (v === "reopen") setReopenGuidance("");
    }
    catch (err) { setActionError((err as Error).message); }
  };
  const sendAnswer = async () => {
    if (!goal.awaitingUserAsk || !answer.trim()) return;
    setAskError("");
    try { await api.answerMail(goal.awaitingUserAsk.mailId, answer.trim()); setAnswer(""); }
    catch (err) { setAskError((err as Error).message); }
  };

  return (
    <div>
      <button onClick={() => navigate("goals")} className="label hover:text-fg mb-3">← goals</button>
      <div className="flex items-center gap-3 flex-wrap mb-1">
        <h1 className="text-[18px] font-bold text-bright">{goal.title}</h1>
        <Tag tone={toneOfStatus(goal.status)}>{goal.status}</Tag>
        <span className="text-[11px] text-dim">
          {goal.department} · {goal.lead} · replans {goal.replansUsed} · {usd(cost)} · {ts(goal.createdAt)}
        </span>
        {goal.spawnedBy && (
          <button className="text-[11px] text-dim underline underline-offset-2 hover:text-fg"
            onClick={() => navigate(`mail/${goal.spawnedBy!.mailId}`)}>
            spawned by {goal.spawnedBy.from}
          </button>
        )}
        <span className="ml-auto flex gap-2">
          {["planning", "running", "replanning"].includes(goal.status) && <Button onClick={() => verb("pause")}>Pause</Button>}
          {["paused-user", "paused-budget", "paused-api", "paused-session"].includes(goal.status) && <Button variant="primary" onClick={() => verb("resume")}>Resume</Button>}
          {!["done", "abandoned"].includes(goal.status) && <TwoStepButton label="Abandon" onConfirm={() => verb("abandon")} />}
          {["failed", "abandoned"].includes(goal.status) && <Button variant="primary" onClick={() => verb("reopen")}>Reopen</Button>}
        </span>
      </div>
      {actionError && <div className="text-[12px] text-err mb-2">{actionError}</div>}
      {["failed", "abandoned"].includes(goal.status) && (
        <div className="flex gap-2 mb-2 max-w-2xl">
          <input value={reopenGuidance} onChange={(e) => setReopenGuidance(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && verb("reopen")}
            placeholder="Optional guidance for the retry (what changed?)…"
            className="flex-1 bg-bg border border-line rounded-md px-3 py-2 outline-none focus:border-dim text-[12px]" />
        </div>
      )}
      <div className="text-[12px] text-dim mb-4">{goal.planSummary}</div>

      {goal.awaitingUserAsk && (
        <div className="panel !border-accent/40 p-4 mb-4 max-w-2xl">
          <SectionLabel>{goal.awaitingUserAsk.from} asks</SectionLabel>
          <div className="whitespace-pre-wrap mb-3">{goal.awaitingUserAsk.question}</div>
          <div className="flex gap-2">
            <input value={answer} onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendAnswer()} placeholder="Your answer resumes the goal…"
              className="flex-1 bg-bg border border-line rounded-md px-3 py-2 outline-none focus:border-dim" />
            <Button variant="primary" onClick={sendAnswer}>Answer</Button>
          </div>
          {askError && <div className="text-[12px] text-err mt-2">{askError}</div>}
        </div>
      )}

      <div className="flex gap-6 flex-col lg:flex-row">
        <div className="min-w-0">
          <Thread nodes={goal.nodes} failedKey={failedKey} onSelect={setNodeKey} />
        </div>
        {node && (
          <div className="panel lg:w-96 shrink-0 p-4 h-fit">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-strong">{node.key}</span>
              <Tag tone={toneOfStatus(node.status)}>{node.status}</Tag>
              <span className="text-[11px] text-dim ml-auto">{node.agent} · rounds {node.rounds} · {usd(node.costCents)}</span>
            </div>
            <div className="text-[12px] text-dim whitespace-pre-wrap mb-3">{node.brief}</div>
            {node.error && <pre className="text-[11px] text-err whitespace-pre-wrap mb-3">{node.error}</pre>}
            {node.artifact && <ArtifactPreview goalArtifacts={goal.artifacts} file={node.artifact} />}
            <Button onClick={() => onOpenChat(node.agent, `About node "${node.key}" of goal "${goal.title}": `)}>Discuss ⌘J</Button>
          </div>
        )}
      </div>

      {goal.artifacts.length > 0 && (
        <div className="mt-6 max-w-3xl">
          <SectionLabel>Artifacts · {goal.artifacts.length}</SectionLabel>
          {goal.artifacts.map((a) => (
            <ArtifactPreview key={a.file} goalArtifacts={goal.artifacts} file={a.file} />
          ))}
        </div>
      )}
    </div>
  );
}

function ArtifactPreview({ goalArtifacts, file }: {
  goalArtifacts: Array<{ file: string; content: string }>; file: string;
}) {
  const [open, setOpen] = useState(false);
  const art = goalArtifacts.find((a) => a.file === file);
  if (!art) return null;
  return (
    <div className="mb-3">
      <button onClick={() => setOpen((v) => !v)} className="label hover:text-fg">
        {open ? "▾" : "▸"} {file}
      </button>
      {open && <pre className="font-mono text-[11px] whitespace-pre-wrap mt-2 max-h-80 overflow-y-auto border border-line rounded-md p-3 bg-bg">{art.content}</pre>}
    </div>
  );
}
