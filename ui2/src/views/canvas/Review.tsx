// ui2/src/views/canvas/Review.tsx — parked needs-review node: last version + objections + verdict (spec §4).
import { useState } from "react";
import { api, type AttentionItem, type StoredEvent } from "../../api.js";
import { useLiveQuery } from "../../hooks.js";
import { T } from "../../lib/topics.js";
import { Button, Empty, SectionLabel } from "../../components/ui.js";
import { TwoStepButton } from "../../components/TwoStepButton.js";

export function ReviewCanvas({ item, events, onDone }: {
  item: AttentionItem; events: StoredEvent[]; onDone: () => void;
}) {
  const { data: goal } = useLiveQuery(() => api.goal(item.ref.goalId), events, T.goals, [item.ref.goalId]);
  const [guidance, setGuidance] = useState("");
  const [error, setError] = useState("");
  const node = goal?.nodes.find((n) => n.key === item.ref.node);
  const artifact = goal?.artifacts.find((a) => a.file === node?.artifact);
  const resolve = async (verdict: "accept" | "retry" | "abandon") => {
    setError("");
    try {
      await api.resolveReview(item.ref.goalId, item.ref.node, verdict, verdict === "retry" ? guidance : undefined);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  // Policy-wall park (triage-inbox spec §B3): the folded grants approve first, then the node
  // retries past the wall. Partial failure (grants in, retry threw) recovers via plain Retry.
  const grants = item.grants ?? [];
  const approveAndRetry = async () => {
    setError("");
    try {
      for (const g of grants) await api.resolveAction(g.id, "approve");
      await api.resolveReview(item.ref.goalId, item.ref.node, "retry", guidance.trim() ? guidance : undefined);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (!goal) return <Empty>Loading…</Empty>;
  return (
    <div className="max-w-3xl">
      <div className="text-[15px] text-strong mb-1">{goal.title} · {item.ref.node}</div>
      <div className="text-[12px] text-dim mb-4">{node?.agent} hit the quality cap without approval — your call.</div>
      <SectionLabel>Outstanding objections</SectionLabel>
      <ul className="text-[13px] mb-4 list-disc pl-5">
        {(node?.error ?? "").split("; ").filter(Boolean).map((o, i) => <li key={i}>{o}</li>)}
      </ul>
      <SectionLabel>Last version{node?.artifact ? ` (${node.artifact})` : ""}</SectionLabel>
      <pre className="text-[12px] whitespace-pre-wrap bg-raised rounded p-3 mb-4 max-h-80 overflow-y-auto">
        {artifact?.content ?? "(artifact not found)"}
      </pre>
      <textarea
        value={guidance} onChange={(e) => setGuidance(e.target.value)} rows={3}
        placeholder="Guidance for a retry (optional — injected as producer feedback)"
        className="w-full bg-raised rounded p-2 text-[13px] mb-3"
      />
      {grants.length > 0 && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {grants.map((g) => (
            <span key={g.id} className="text-[11px] bg-raised rounded px-2 py-1">grant: {g.role} → {g.tool}</span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        {grants.length > 0 && (
          <Button variant="primary" onClick={() => void approveAndRetry()}>Approve grant & Retry</Button>
        )}
        <Button variant={grants.length ? "ghost" : "primary"} onClick={() => void resolve("accept")}>Accept with waiver</Button>
        <Button variant="ghost" onClick={() => void resolve("retry")}>Retry</Button>
        <TwoStepButton label="Abandon node" onConfirm={() => void resolve("abandon")} />
      </div>
      {error && <div className="text-[12px] text-err mt-2">{error}</div>}
    </div>
  );
}
