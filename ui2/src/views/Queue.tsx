// ui2/src/views/Queue.tsx — the needs-you list: grouped rows, inline actions, one-time arrival animation.
import { useRef } from "react";
import type { AttentionItem } from "../api.js";
import type { QueueGroup } from "../lib/queue.js";
import { Button } from "../components/ui.js";
import { TwoStepButton } from "../components/TwoStepButton.js";
import { ts } from "../lib/format.js";

const ACTION_LABEL: Record<string, string> = {
  approve: "Approve", reject: "Reject", answer: "Answer", open: "Open",
  read: "Mark read", resume: "Resume", abandon: "Abandon",
  accept: "Accept", retry: "Retry",
};

const KICKER: Record<string, { label: string; cls: string }> = {
  approval: { label: "approval", cls: "text-accent" },
  ask: { label: "question", cls: "text-accent" },
  review: { label: "review", cls: "text-accent" },
  goal: { label: "goal", cls: "text-err" },
  mail: { label: "mail", cls: "text-info" },
  sense: { label: "sense", cls: "text-err" },
};

export function Queue({ groups, selected, onSelect, onAct, rowErrors, busy }: {
  groups: QueueGroup[];
  selected: AttentionItem | null;
  onSelect: (i: AttentionItem) => void;
  onAct: (i: AttentionItem, verb: string) => void;
  rowErrors: Record<string, string>;
  busy: Set<string>;
}) {
  // Ids seen in a previous render never re-animate (spec §3 arrival rule).
  const seen = useRef(new Set<string>());
  const isNew = (id: string) => {
    if (seen.current.has(id)) return false;
    seen.current.add(id);
    return true;
  };

  return (
    <div className="flex flex-col gap-4 overflow-y-auto min-h-0">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="label px-3 mb-1">{g.label} · {g.items.length}</div>
          {g.items.map((i) => (
            <div
              key={i.id}
              onClick={() => onSelect(i)}
              className={`card card-hover mx-3 mb-2 px-3 py-2.5 cursor-pointer ${
                selected?.id === i.id ? "!border-accent" : ""
              } ${isNew(i.id) ? "arrive" : ""}`}
            >
              <div className="flex items-baseline gap-2">
                <span className={`font-mono text-[9.5px] uppercase tracking-wide ${KICKER[i.kind]?.cls ?? "text-dim"}`}>
                  {KICKER[i.kind]?.label ?? i.kind}
                </span>
                <span className="text-[10px] text-dim ml-auto shrink-0 font-mono">{ts(i.ts)}</span>
              </div>
              <div className="text-[13px] text-bright font-semibold truncate mt-0.5">{i.title}</div>
              <div className="text-[11px] text-dim truncate">{i.meta}</div>
              {rowErrors[i.id] && <div className="text-[11px] text-err mt-1">{rowErrors[i.id]}</div>}
              <div className="flex gap-1.5 mt-1.5" onClick={(e) => e.stopPropagation()}>
                {i.actions.map((verb) =>
                  verb === "abandon" ? (
                    <TwoStepButton key={verb} label="Abandon" disabled={busy.has(i.id)} onConfirm={() => onAct(i, verb)} />
                  ) : (
                    <Button
                      key={verb}
                      variant={verb === "approve" || verb === "answer" || verb === "accept" ? "primary" : verb === "reject" ? "danger" : "ghost"}
                      disabled={busy.has(i.id)}
                      onClick={() => onAct(i, verb)}
                    >
                      {ACTION_LABEL[verb] ?? verb}
                    </Button>
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
      {groups.length === 0 && <div className="text-dim px-3 py-6">Nothing needs you.</div>}
    </div>
  );
}
