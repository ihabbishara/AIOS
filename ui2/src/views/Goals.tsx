// ui2/src/views/Goals.tsx — Command Deck kanban lanes; detail = DAG + inspector (spec §6).
import { useState } from "react";
import { api, type GoalNodeView, type GoalView, type StoredEvent } from "../api.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { navigate, type Route } from "../lib/router.js";
import { LANES, laneOf, provenance } from "../lib/goal-buckets.js";
import { Button, Dot, Empty, SectionLabel, Tag, toneOfStatus } from "../components/ui.js";
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

const DONE_CAP = 10;

export function GoalList({ events }: { events: StoredEvent[] }) {
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);
  const [dept, setDept] = useState<string>("");
  const [showAllDone, setShowAllDone] = useState(false);
  if (!goals) return <Empty>Loading…</Empty>;
  const depts = [...new Set(goals.map((g) => g.department))].sort();
  const filtered = dept ? goals.filter((g) => g.department === dept) : goals;
  const weekAgo = Date.now() - 7 * 86_400_000;
  const weekCost = filtered
    .filter((g) => Date.parse(g.createdAt) >= weekAgo)
    .reduce((s, g) => s + g.nodes.reduce((n, x) => n + x.costCents, 0), 0);

  const lanes = LANES.map(({ key, label }) => ({
    key, label, items: filtered.filter((g) => laneOf(g.status) === key),
  }));

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h1 className="text-[17px] font-bold text-bright">Goals</h1>
        <span className="text-[12px] text-dim font-mono">{filtered.length} total · {usd(weekCost)} this week</span>
        <select value={dept} onChange={(e) => setDept(e.target.value)}
          className="ml-auto bg-surface border border-line rounded-md px-2 py-1 text-[12px] text-fg outline-none">
          <option value="">all departments</option>
          {depts.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 items-start">
        {lanes.map(({ key, label, items }) => {
          const capped = key === "done" && !showAllDone ? items.slice(0, DONE_CAP) : items;
          return (
            <div key={key} className={`panel p-3.5 ${key === "needs" && items.length > 0 ? "border-err-line" : ""}`}>
              <div className={`label mb-2.5 flex items-center justify-between ${key === "needs" ? "text-accent" : ""}`}>
                {label}
                <span className={`font-mono rounded-full px-2 py-px text-[10px] ${
                  key === "needs" && items.length > 0 ? "bg-accent-bg text-accent" : "bg-raised text-dim"}`}>
                  {items.length}
                </span>
              </div>
              {capped.map((g) => <GoalCard key={g.id} g={g} />)}
              {items.length === 0 && (
                <div className="border border-dashed border-line rounded-lg px-3.5 py-5 text-center">
                  <div className="text-[11.5px] text-dim">
                    {key === "needs" ? "Nothing needs you" : key === "running" ? "All quiet — agents idle" : "No finished goals yet"}
                  </div>
                  {key === "running" && <div className="text-[10.5px] text-dim opacity-60 mt-1">new goals appear here live</div>}
                </div>
              )}
              {key === "done" && items.length > DONE_CAP && !showAllDone && (
                <button onClick={() => setShowAllDone(true)}
                  className="w-full text-center text-[11px] text-info hover:opacity-80 py-1.5">
                  Show all {items.length} →
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GoalCard({ g }: { g: GoalView }) {
  const done = g.nodes.filter((n) => n.status === "done").length;
  const cost = g.nodes.reduce((s, n) => s + n.costCents, 0);
  const failed = g.status === "failed";
  const live = ["planning", "running", "replanning"].includes(g.status);
  return (
    <button onClick={() => navigate(`goals/${g.slug}`)}
      className={`card card-hover w-full text-left p-3 mb-2.5 ${failed ? "!bg-err-bg !border-err-line" : ""} ${g.status === "abandoned" ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Dot tone={toneOfStatus(g.status)} breathing={live} />
        <span className={`font-mono text-[10px] uppercase ${failed ? "text-err" : "text-dim"}`}>
          {g.status} · {done}/{g.nodes.length}
        </span>
        <Tag tone="dim">{provenance(g.originChannel)}</Tag>
      </div>
      <div className={`text-[13px] font-semibold leading-snug ${g.status === "abandoned" ? "text-fg" : "text-bright"}`}>{g.title}</div>
      <div className="flex justify-between items-baseline mt-1.5">
        <span className="text-[10.5px] text-dim truncate">{g.department} · {g.lead} · {ts(g.createdAt)}</span>
        {cost > 0 && <span className="font-mono text-[10.5px] text-dim shrink-0 ml-2">{usd(cost)}</span>}
      </div>
      {live && <div className="shimmer mt-2" />}
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
          {["paused-user", "paused-budget"].includes(goal.status) && <Button variant="primary" onClick={() => verb("resume")}>Resume</Button>}
          {!["done", "abandoned"].includes(goal.status) && <TwoStepButton label="Abandon" onConfirm={() => verb("abandon")} />}
        </span>
      </div>
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
          <MiniDag nodes={goal.nodes} failedKey={failedKey} scale={1} onSelect={setNodeKey} />
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
