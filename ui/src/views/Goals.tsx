// ui/src/views/Goals.tsx — goals tab: status buckets → goal detail with DAG canvas + node side panel.
import { useEffect, useMemo, useState } from "react";
import { api, type GoalView, type GoalNodeView, type StoredEvent } from "../api.js";
import { usePoll } from "../hooks.js";
import { layoutDag, BOX_W, BOX_H } from "./dag-layout.js";

/** Deep-link payload from org agent cards: which goal to open, which node to select. */
export interface GoalTarget { slug: string; nodeKey: string | null }

const BUCKETS: Array<{ title: string; accent: string; match: string[] }> = [
  { title: "Active", accent: "text-amber glow-amber", match: ["planning", "running", "replanning"] },
  { title: "Paused", accent: "text-cyan", match: ["paused-budget", "paused-user"] },
  { title: "Waiting", accent: "text-cyan", match: ["awaiting-mail"] },
  { title: "Completed", accent: "text-phosphor glow-green", match: ["done"] },
  { title: "Failed", accent: "text-alert", match: ["failed", "abandoned"] },
];

// Spec §9 status palette: pending dim, ready cyan, running amber sweep, done phosphor, failed alert, skipped struck.
const STRIP: Record<string, string> = {
  pending: "bg-panel-2", ready: "bg-cyan", running: "bg-amber live-dot",
  done: "bg-phosphor", failed: "bg-alert", skipped: "bg-dim",
};
const NODE_BOX: Record<string, string> = {
  pending: "hud opacity-40", ready: "hud hud-cyan", running: "hud hud-amber running-sweep",
  done: "hud", failed: "hud hud-alert", skipped: "hud opacity-40",
};
const NODE_TEXT: Record<string, string> = {
  pending: "text-dim", ready: "text-cyan", running: "text-amber",
  done: "text-phosphor", failed: "text-alert", skipped: "text-dim",
};
const GOAL_STATUS_TEXT: Record<string, string> = {
  planning: "text-cyan", running: "text-amber", replanning: "text-amber",
  "paused-budget": "text-cyan", "paused-user": "text-cyan",
  "awaiting-mail": "text-cyan",
  done: "text-phosphor", failed: "text-alert", abandoned: "text-dim",
};

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const ts = (iso: string | null) => (iso ? iso.slice(5, 16).replace("T", " ") : "…");

export function Goals({ events, target, onConsumeTarget, onOpenAgent }: {
  events: StoredEvent[]; target: GoalTarget | null; onConsumeTarget: () => void; onOpenAgent: (name: string) => void;
}) {
  const lastEvt = useMemo(
    () => events.filter((e) => e.event.type.startsWith("goal.") || e.event.type.startsWith("node.")).at(-1)?.id,
    [events],
  );
  const { data: goals } = usePoll(() => api.goals(), [lastEvt]);
  const [selected, setSelected] = useState<string | null>(null);
  const [initialNode, setInitialNode] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setSelected(target.slug);
    setInitialNode(target.nodeKey);
    onConsumeTarget();
  }, [target, onConsumeTarget]);

  if (selected) {
    return (
      <GoalDetailView idOrSlug={selected} events={events} initialNode={initialNode} onOpenAgent={onOpenAgent}
        onBack={() => { setSelected(null); setInitialNode(null); }} />
    );
  }

  const inBucket = (match: string[]) => (goals ?? []).filter((g) => match.includes(g.status));

  return (
    <div className="grid grid-cols-4 gap-4 h-full min-h-0">
      {BUCKETS.map(({ title, accent, match }, i) => (
        <section key={title} className="boot flex flex-col min-h-0" style={{ animationDelay: `${i * 80}ms` }}>
          <div className="flex items-baseline gap-2 mb-3">
            <span className={`font-display uppercase tracking-[0.2em] text-[11px] ${accent}`}>{title}</span>
            <span className="text-dim text-[11px]">{inBucket(match).length}</span>
          </div>
          <div className="flex flex-col gap-3 overflow-auto pr-1">
            {inBucket(match).map((g) => <GoalCard key={g.id} goal={g} onClick={() => setSelected(g.id)} />)}
            {inBucket(match).length === 0 && (
              <div className="border border-dashed border-line text-dim text-[11px] p-4 text-center">empty</div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function GoalCard({ goal, onClick }: { goal: GoalView; onClick: () => void }) {
  const hudClass =
    goal.status === "running" || goal.status === "replanning" ? "hud hud-amber running-sweep" :
    goal.status === "failed" ? "hud hud-alert" :
    goal.status.startsWith("paused") ? "hud hud-cyan" : "hud";
  const doneNodes = goal.nodes.filter((n) => n.status === "done").length;
  return (
    <button onClick={onClick} className={`${hudClass} p-3 text-left hover:bg-panel-2 transition-colors`}>
      <div className="text-bright text-[13px] leading-snug">{goal.title}</div>
      <div className="flex items-center gap-2 mt-2">
        <span className="text-[10px] text-cyan">{goal.department} · {goal.lead}</span>
        <span className="text-[10px] text-dim ml-auto">{ts(goal.createdAt)}</span>
      </div>
      {goal.nodes.length > 0 && (
        <div className="flex gap-1 mt-2">
          {goal.nodes.map((n) => (
            <span key={n.key} title={`${n.key}: ${n.status}`} className={`h-1 flex-1 ${STRIP[n.status] ?? "bg-panel-2"}`} />
          ))}
        </div>
      )}
      {(goal.status === "running" || goal.status === "replanning") && (
        <div className="text-[10px] text-amber mt-1">{doneNodes}/{goal.nodes.length} nodes</div>
      )}
      {goal.error && <div className="text-[10px] text-alert mt-1 line-clamp-2">{goal.error}</div>}
    </button>
  );
}

function GoalDetailView({ idOrSlug, events, initialNode, onOpenAgent, onBack }: {
  idOrSlug: string; events: StoredEvent[]; initialNode: string | null;
  onOpenAgent: (name: string) => void; onBack: () => void;
}) {
  const lastEvt = useMemo(
    () => events.filter((e) => e.event.type.startsWith("goal.") || e.event.type.startsWith("node.")).at(-1)?.id,
    [events],
  );
  const { data: goal, error, reload } = usePoll(() => api.goal(idOrSlug), [idOrSlug, lastEvt]);
  const [selectedNode, setSelectedNode] = useState<string | null>(initialNode);
  const [msg, setMsg] = useState<string | null>(null);
  const [armAbandon, setArmAbandon] = useState(false);
  const [answer, setAnswer] = useState("");

  if (error) {
    return (
      <div className="text-alert text-[12px]">
        error: {error} <button className="text-dim underline" onClick={onBack}>back</button>
      </div>
    );
  }
  if (!goal) return <div className="text-dim">loading…</div>;

  const node = goal.nodes.find((n) => n.key === selectedNode) ?? null;
  const artifact = node?.artifact ? goal.artifacts.find((a) => a.file === node.artifact) ?? null : null;
  const totalCents = goal.nodes.reduce((s, n) => s + n.costCents, 0);

  const act = (verb: "pause" | "resume" | "abandon") => {
    setArmAbandon(false);
    api.goalAction(goal.id, verb)
      .then((r) => { setMsg(r.message); reload(); })
      .catch((e) => setMsg((e as Error).message));
  };

  const sendAnswer = () => {
    const ask = goal.awaitingUserAsk;
    if (!ask || !answer.trim()) return;
    const text = answer;
    setAnswer(""); // clear optimistically
    api.answerMail(ask.mailId, text)
      .then(() => reload())
      .catch((e) => { setMsg((e as Error).message); setAnswer(text); });
  };

  const canPause = goal.status === "running" || goal.status === "replanning";
  const canResume = goal.status.startsWith("paused");
  const canAbandon = !["done", "failed", "abandoned"].includes(goal.status);

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={onBack} className="text-[11px] text-dim border border-line px-2 py-1 hover:text-fg hover:border-fg">← goals</button>
        <span className="font-display text-bright tracking-wider text-lg">{goal.title}</span>
        <span className={`text-[11px] uppercase tracking-widest ${GOAL_STATUS_TEXT[goal.status] ?? "text-dim"}`}>{goal.status}</span>
        <span className="text-[11px] text-dim">{goal.department} · lead: <span className="text-cyan">{goal.lead}</span></span>
        <span className="text-[11px] text-dim">replans: {goal.replansUsed}</span>
        <span className="text-[11px] text-dim">total: {usd(totalCents)}</span>
        <div className="ml-auto flex gap-2">
          {canPause && <CtlButton label="pause" onClick={() => act("pause")} />}
          {canResume && <CtlButton label="resume" onClick={() => act("resume")} />}
          {canAbandon && (armAbandon
            ? <CtlButton label="confirm abandon?" alert onClick={() => act("abandon")} />
            : <CtlButton label="abandon" alert onClick={() => setArmAbandon(true)} />)}
        </div>
      </div>
      {msg && <div className="text-[11px] text-cyan">{msg}</div>}
      {goal.error && <div className="text-[11px] text-alert">{goal.error}</div>}
      {goal.spawnedBy && (
        <div
          onClick={() => onOpenAgent(goal.spawnedBy!.from)}
          className="text-[11px] text-cyan underline decoration-dotted cursor-pointer hover:text-bright w-fit"
        >
          ← spawned by mail from {goal.spawnedBy.from}
        </div>
      )}
      {goal.awaitingUserAsk && (
        <div className="hud hud-cyan p-3">
          <div className="text-[10px] uppercase tracking-widest text-cyan">🙋 {goal.awaitingUserAsk.from} is asking</div>
          <div className="text-[12px] text-bright mt-1 whitespace-pre-wrap">{goal.awaitingUserAsk.question}</div>
          <div className="flex gap-2 mt-2">
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && answer.trim()) sendAnswer(); }}
              placeholder="your answer…"
              className="flex-1 bg-void border border-cyan/40 px-2 py-1 text-[12px] text-bright outline-none focus:border-cyan"
            />
            <button
              disabled={!answer.trim()}
              onClick={sendAnswer}
              className="text-[11px] text-cyan border border-cyan px-3 hover:bg-cyan hover:text-void transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-cyan"
            >
              send
            </button>
          </div>
        </div>
      )}
      <div className="text-[11px] text-dim">{goal.planSummary}</div>

      <div className="flex gap-4 flex-1 min-h-0">
        <div className="flex-1 min-w-0 overflow-auto">
          <DagCanvas nodes={goal.nodes} selected={selectedNode} onSelect={setSelectedNode} />
        </div>
        {node && <NodePanel node={node} artifact={artifact} onClose={() => setSelectedNode(null)} />}
      </div>
    </div>
  );
}

function CtlButton({ label, alert, onClick }: { label: string; alert?: boolean; onClick: () => void }) {
  const color = alert ? "border-alert text-alert hover:bg-alert" : "border-phosphor text-phosphor hover:bg-phosphor";
  return (
    <button onClick={onClick}
      className={`border px-3 py-1 font-display uppercase tracking-[0.2em] text-[10px] hover:text-void transition-colors ${color}`}>
      {label}
    </button>
  );
}

function DagCanvas({ nodes, selected, onSelect }: {
  nodes: GoalNodeView[]; selected: string | null; onSelect: (key: string) => void;
}) {
  const layout = useMemo(() => layoutDag(nodes.map((n) => ({ key: n.key, deps: n.deps }))), [nodes]);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  return (
    <div className="relative" style={{ width: layout.width, height: layout.height }}>
      <svg className="absolute inset-0 pointer-events-none" width={layout.width} height={layout.height}>
        {layout.edges.map((e) => (
          <path key={`${e.from}→${e.to}`} d={e.path} fill="none" stroke="var(--color-line)" strokeWidth="1.5" />
        ))}
      </svg>
      {layout.boxes.map((b) => {
        const n = byKey.get(b.key)!;
        return (
          <button key={b.key} onClick={() => onSelect(b.key)}
            className={`absolute p-2 text-left overflow-hidden ${NODE_BOX[n.status] ?? "hud"} ${selected === b.key ? "outline outline-1 outline-bright" : ""}`}
            style={{ left: b.x, top: b.y, width: BOX_W, height: BOX_H }}>
            <div className={`text-[11px] truncate font-display tracking-wider ${n.status === "skipped" ? "line-through text-dim" : "text-bright"}`}>
              {n.key}
            </div>
            <div className="text-[10px] text-dim truncate">{n.agent}{n.critic ? ` ⇄ ${n.critic}` : ""}</div>
            <div className={`text-[9px] uppercase tracking-widest ${NODE_TEXT[n.status] ?? "text-dim"}`}>
              {n.type} · {n.status}{n.costCents > 0 ? ` · ${usd(n.costCents)}` : ""}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function NodePanel({ node, artifact, onClose }: {
  node: GoalNodeView; artifact: { file: string; content: string } | null; onClose: () => void;
}) {
  return (
    <aside className="w-80 shrink-0 hud p-4 overflow-auto flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="font-display text-bright tracking-wider">{node.key}</span>
        <span className={`text-[10px] uppercase tracking-widest ${NODE_TEXT[node.status] ?? "text-dim"}`}>
          {node.type} · {node.status}
        </span>
        <button onClick={onClose} className="ml-auto text-dim hover:text-fg text-[11px]">✕</button>
      </div>
      <div className="text-[11px] text-dim">
        agent: <span className="text-cyan">{node.agent}</span>
        {node.critic && <> · critic: <span className="text-violet">{node.critic}</span></>}
      </div>
      <div className="text-[11px] text-dim">
        cost: <span className="text-fg">{usd(node.costCents)}</span> · rounds: <span className="text-fg">{node.rounds}</span>
      </div>
      {(node.startedAt || node.finishedAt) && (
        <div className="text-[10px] text-dim">{ts(node.startedAt)} → {ts(node.finishedAt)}</div>
      )}
      {node.error && <div className="text-[11px] text-alert whitespace-pre-wrap">{node.error}</div>}
      <div>
        <div className="label mb-1">Brief</div>
        <p className="text-[11px] text-fg leading-relaxed whitespace-pre-wrap">{node.brief}</p>
      </div>
      {artifact && (
        <div className="min-h-0">
          <div className="label mb-1">Artifact · {artifact.file}</div>
          <pre className="text-[10px] text-fg whitespace-pre-wrap bg-void border border-line p-2 max-h-64 overflow-auto">
            {artifact.content.slice(0, 8000)}
          </pre>
        </div>
      )}
    </aside>
  );
}
