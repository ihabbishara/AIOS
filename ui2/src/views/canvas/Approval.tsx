// ui2/src/views/canvas/Approval.tsx — gate-authored preview by type + Approve/Reject(reason)/Discuss.
import { useState } from "react";
import { api, type AttentionItem, type StoredEvent } from "../../api.js";
import { useLiveQuery } from "../../hooks.js";
import { T } from "../../lib/topics.js";
import { parseApproval } from "../../lib/preview.js";
import { Button, Tag, SectionLabel, Empty } from "../../components/ui.js";

export function ApprovalCanvas({ item, events, onAct, onOpenChat }: {
  item: AttentionItem; events: StoredEvent[];
  onAct: (i: AttentionItem, verb: string) => void;
  onOpenChat: (t: string, s?: string) => void;
}) {
  const [reason, setReason] = useState("");
  const { data: actions } = useLiveQuery(() => api.actions("proposed"), events, T.actions);
  const action = actions?.find((a) => a.id === item.ref.actionId);
  if (actions && !action) return <Empty>Already handled.</Empty>;
  if (!action) return <Empty>Loading…</Empty>;
  const p = parseApproval(action);

  const rejectWithReason = async () => {
    if (!reason.trim()) return;
    await api.resolveAction(item.ref.actionId, "reject", reason.trim()).catch(() => {});
    onAct(item, "open"); // reselect; the next /api/attention refresh drops the row
  };

  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <SectionLabel>Approval</SectionLabel>
        <Tag tone="accent">{action.type}</Tag>
        <span className="text-[11px] text-dim ml-auto">expires {action.expires_at.slice(5, 16).replace("T", " ")}</span>
      </div>

      {p.form === "email" && (
        <div className="panel p-4">
          <div className="text-[11px] text-dim">To <span className="text-fg">{p.to}</span></div>
          <div className="text-[15px] text-strong mt-1 mb-3">{p.subject}</div>
          <div className="whitespace-pre-wrap leading-relaxed">{p.body}</div>
        </div>
      )}
      {p.form === "vault" && (
        <div className="panel p-4">
          <div className="text-[11px] text-dim mb-2 font-mono">{p.path}</div>
          <pre className="font-mono text-[12px] whitespace-pre-wrap text-fg">{p.markdown}</pre>
        </div>
      )}
      {p.form === "permission" && (
        <div className="panel p-4 flex items-center gap-3">
          <Tag tone={p.op === "grant" ? "ok" : "err"}>{p.op}</Tag>
          <span className="text-strong">{p.tool}</span>
          <span className="text-dim">for role</span>
          <span className="text-strong">{p.role}</span>
        </div>
      )}
      {p.form === "generic" && (
        <div className="panel p-4">
          <div className="mb-3">{p.preview}</div>
          {p.fields.length > 0 && (
            <table className="text-[12px] w-full">
              <tbody>
                {p.fields.map(([k, v]) => (
                  <tr key={k}><td className="text-dim pr-4 py-0.5 align-top whitespace-nowrap">{k}</td><td className="break-all">{v}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="primary" onClick={() => onAct(item, "approve")}>Approve ↵</Button>
        <Button variant="danger" onClick={() => onAct(item, "reject")}>Reject</Button>
        <input
          value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason (optional)"
          className="bg-bg border border-line rounded-md px-2 py-1.5 text-[12px] outline-none focus:border-dim w-48"
          onKeyDown={(e) => { if (e.key === "Enter") void rejectWithReason(); }}
        />
        <Button onClick={() => onOpenChat("neo", `About approval "${item.title}" (${action.type}): `)}>Discuss ⌘J</Button>
      </div>
    </div>
  );
}
