// ui2/src/views/Home.tsx — the Triage Cockpit: queue (left) + canvas (right) (spec §5).
import { useEffect, useMemo, useState } from "react";
import { api, type AttentionItem, type StoredEvent } from "../api.js";
import { groupQueue, flatQueue } from "../lib/queue.js";
import { Queue } from "./Queue.js";
import { TodayStrip } from "./TodayStrip.js";
import { Canvas } from "./canvas/index.js";

export function Home({ events, attention, onOpenChat }: {
  events: StoredEvent[];
  attention: AttentionItem[] | undefined;
  onOpenChat: (target: string, seed?: string) => void;
}) {
  const [selected, setSelected] = useState<AttentionItem | null>(null);
  const [handled, setHandled] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const visible = useMemo(
    () => (attention ?? []).filter((i) => !handled.has(i.id)),
    [attention, handled],
  );
  const groups = useMemo(() => groupQueue(visible), [visible]);

  // A fresh /api/attention read is the truth — drop optimistic tombstones it no longer lists.
  useEffect(() => {
    if (!attention) return;
    setHandled((h) => new Set([...h].filter((id) => attention.some((i) => i.id === id))));
  }, [attention]);

  const mark = (set: (updater: (s: Set<string>) => Set<string>) => void, id: string, on: boolean) =>
    set((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });

  const act = async (item: AttentionItem, verb: string) => {
    if (verb === "open" || verb === "answer") { setSelected(item); return; } // answering happens in the canvas with context
    setRowErrors((e) => ({ ...e, [item.id]: "" }));
    mark(setBusy, item.id, true);
    const optimistic = ["approve", "reject", "read", "abandon", "resume"].includes(verb);
    if (optimistic) mark(setHandled, item.id, true);
    try {
      if (verb === "approve" || verb === "reject") await api.resolveAction(item.ref.actionId, verb);
      else if (verb === "read") {
        const thread = await api.mailThreadView(item.ref.threadId);
        await Promise.all(thread.filter((m) => m.to === "user" && m.status === "unread").map((m) => api.markMailRead(m.id)));
      } else if (verb === "abandon") await api.goalAction(item.ref.goalId, "abandon");
      else if (verb === "resume") await api.goalAction(item.ref.goalId, "resume");
      if (selected?.id === item.id) setSelected(null);
    } catch (err) {
      if (optimistic) mark(setHandled, item.id, false); // rollback
      setRowErrors((e) => ({ ...e, [item.id]: (err as Error).message }));
    } finally {
      mark(setBusy, item.id, false);
    }
  };

  // j/k walk · enter open · a approve · r reject · d discuss (spec §4).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const flat = flatQueue(groupQueue(visible));
      const idx = selected ? flat.findIndex((i) => i.id === selected.id) : -1;
      if (e.key === "j") setSelected(flat[Math.min(idx + 1, flat.length - 1)] ?? null);
      if (e.key === "k") setSelected(flat[Math.max(idx - 1, 0)] ?? null);
      if (!selected) return;
      if (e.key === "a" && selected.actions.includes("approve")) void act(selected, "approve");
      if (e.key === "r" && selected.actions.includes("reject")) void act(selected, "reject");
      if (e.key === "d") onOpenChat("hermes", `About "${selected.title}" (${selected.kind} ${selected.id}): `);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, selected]);

  const openBrief = (threadId: string) => {
    setSelected({
      kind: "mail", id: `brief:${threadId}`, title: "Brief", meta: "", severity: 4,
      ts: new Date().toISOString(), actions: [], ref: { threadId, brief: "1" },
    });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TodayStrip events={events} onOpenBrief={openBrief} />
      <div className="flex-1 min-h-0 flex">
        <div className="w-[360px] shrink-0 border-r border-line py-2 hidden md:flex flex-col">
          <Queue groups={groups} selected={selected} onSelect={setSelected} onAct={act} rowErrors={rowErrors} busy={busy} />
        </div>
        {/* Phone: the queue IS the home screen (Task 11 adds the full-screen detail push). */}
        <div className="flex-1 min-h-0 md:hidden py-2">
          <Queue groups={groups} selected={selected} onSelect={setSelected} onAct={act} rowErrors={rowErrors} busy={busy} />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 hidden md:block">
          <Canvas item={selected} events={events} onAct={act} onOpenChat={onOpenChat} onDone={() => setSelected(null)} />
        </div>
      </div>
    </div>
  );
}
