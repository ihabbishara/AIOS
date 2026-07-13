// ui2/src/views/Goals.tsx — status-grouped list; detail = Ember DAG + inspector (spec §6).
import { useState } from "react";
import { api, type GoalNodeView, type StoredEvent } from "../api.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { navigate, type Route } from "../lib/router.js";
import { BUCKETS, bucketOf, provenance } from "../lib/goal-buckets.js";
import { Button, Empty, SectionLabel, Tag, toneOfStatus } from "../components/ui.js";
import { TwoStepButton } from "../components/TwoStepButton.js";
import { ts, usd } from "../lib/format.js";
import { MiniDag } from "./MiniDag.js";

export function Goals({ events, route, onOpenChat }: {
  events: StoredEvent[]; route: Route; onOpenChat: (t: string, s?: string) => void;
}) {
  const slug = route.section === "goals" ? route.parts[0] : undefined;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      {slug ? <GoalDetailView slug={slug} events={events} onOpenChat={onOpenChat} /> : <GoalList events={events} />}
    </div>
  );
}

function GoalList({ events }: { events: StoredEvent[] }) {
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);
  const [dept, setDept] = useState<string>("");
  if (!goals) return <Empty>Loading…</Empty>;
  const depts = [...new Set(goals.map((g) => g.department))].sort();
  const filtered = dept ? goals.filter((g) => g.department === dept) : goals;
  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-2 mb-4">
        <h1 className="text-[20px] text-strong">Goals</h1>
        <select value={dept} onChange={(e) => setDept(e.target.value)}
          className="ml-auto bg-surface border border-line rounded-md px-2 py-1 text-[12px] text-fg outline-none">
          <option value="">all departments</option>
          {depts.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      {BUCKETS.map(({ key, label }) => {
        const items = filtered.filter((g) => bucketOf(g.status) === key);
        if (items.length === 0) return null;
        return (
          <div key={key} className="mb-6">
            <SectionLabel>{label} · {items.length}</SectionLabel>
            {items.map((g) => {
              const done = g.nodes.filter((n) => n.status === "done").length;
              const cost = g.nodes.reduce((s, n) => s + n.costCents, 0);
              return (
                <button key={g.id} onClick={() => navigate(`goals/${g.slug}`)}
                  className="w-full text-left px-3 py-2.5 rounded-md hover:bg-raised flex items-center gap-3 min-h-11">
                  <Tag tone={toneOfStatus(g.status)}>{g.status}</Tag>
                  <span className="text-strong truncate">{g.title}</span>
                  <span className="text-[11px] text-dim ml-auto shrink-0">
                    {g.department} · {g.lead} · {done}/{g.nodes.length} · {usd(cost)}
                  </span>
                  <Tag>{provenance(g.originChannel)}</Tag>
                  {bucketOf(g.status) === "running" && g.nodes.some((n) => n.status === "running") && (
                    <span className="w-16 shrink-0"><span className="shimmer block" /></span>
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
      {filtered.length === 0 && <Empty>No goals yet.</Empty>}
    </div>
  );
}

function GoalDetailView({ slug, events, onOpenChat }: {
  slug: string; events: StoredEvent[]; onOpenChat: (t: string, s?: string) => void;
}) {
  const { data: goal, error } = useLiveQuery(() => api.goal(slug), events, T.goals, [slug]);
  const [nodeKey, setNodeKey] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [askError, setAskError] = useState("");
  if (error) return <Empty>{error}</Empty>;
  if (!goal) return <Empty>Loading…</Empty>;
  const node: GoalNodeView | undefined = goal.nodes.find((n) => n.key === nodeKey) ?? goal.nodes.find((n) => n.status === "failed");
  const cost = goal.nodes.reduce((s, n) => s + n.costCents, 0);
  const failedKey = goal.nodes.find((n) => n.status === "failed")?.key;

  const verb = async (v: "pause" | "resume" | "abandon") => { await api.goalAction(goal.id, v).catch(() => {}); };
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
        <h1 className="text-[20px] text-strong">{goal.title}</h1>
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
          {["paused-user", "paused-budget"].includes(goal.status) && <Button variant="primary" onClick={() => verb("resume")}>Resume</Button>}
          {!["done", "abandoned"].includes(goal.status) && <TwoStepButton label="Abandon" onConfirm={() => verb("abandon")} />}
        </span>
      </div>
      <div className="text-[12px] text-dim mb-4">{goal.planSummary}</div>

      {goal.awaitingUserAsk && (
        <div className="border border-accent/40 rounded-lg bg-surface p-4 mb-4 max-w-2xl">
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
          <MiniDag nodes={goal.nodes} failedKey={failedKey} scale={1} onSelect={setNodeKey} />
        </div>
        {node && (
          <div className="lg:w-96 shrink-0 border border-line rounded-lg bg-surface p-4 h-fit">
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
