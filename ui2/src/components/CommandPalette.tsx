// ui2/src/components/CommandPalette.tsx — ⌘K jump: sections, agents (chat/profile), goals.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type StateInfo, type GoalView } from "../api.js";
import { navigate } from "../lib/router.js";
import { toggleTheme } from "../lib/theme.js";

interface Item { label: string; hint: string; run: () => void }

export function CommandPalette({ state, onOpenChat, openSignal = 0 }: {
  state: StateInfo | undefined;
  onOpenChat: (name: string, seed?: string) => void;
  openSignal?: number;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [goals, setGoals] = useState<GoalView[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQ("");
        setSel(0);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Top-bar ⌘K button (works on touch too): an incrementing signal opens the palette.
  useEffect(() => {
    if (openSignal > 0) {
      setOpen(true);
      setQ("");
      setSel(0);
    }
  }, [openSignal]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      api.goals().then(setGoals).catch(() => {});
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const close = (fn: () => void) => () => { fn(); setOpen(false); };
    const base: Item[] = [
      { label: "home", hint: "section", run: close(() => navigate("home")) },
      { label: "goals", hint: "section", run: close(() => navigate("goals")) },
      { label: "staff", hint: "section", run: close(() => navigate("staff")) },
      { label: "mail", hint: "section", run: close(() => navigate("mail")) },
      { label: "system", hint: "section", run: close(() => navigate("system")) },
      { label: "governance", hint: "staff", run: close(() => navigate("staff/governance")) },
      { label: "events", hint: "system", run: close(() => navigate("system/events")) },
      { label: "costs", hint: "system", run: close(() => navigate("system/costs")) },
      { label: "toggle theme", hint: "dark / light", run: close(() => { toggleTheme(); }) },
    ];
    for (const a of state?.agents ?? []) {
      base.push({ label: `chat ${a.name}`, hint: a.description.slice(0, 40), run: close(() => onOpenChat(a.name)) });
      base.push({ label: `profile ${a.name}`, hint: "staff", run: close(() => navigate(`staff/agents/${a.name}`)) });
    }
    for (const g of goals) {
      base.push({ label: `goal ${g.title}`, hint: g.status, run: close(() => navigate(`goals/${g.slug}`)) });
    }
    return base;
  }, [state, goals, onOpenChat]);

  const filtered = items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())).slice(0, 12);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-32" onClick={() => setOpen(false)}>
      <div className="panel w-[520px] p-3" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setSel((s) => Math.min(s + 1, filtered.length - 1));
            if (e.key === "ArrowUp") setSel((s) => Math.max(s - 1, 0));
            if (e.key === "Enter") filtered[sel]?.run();
          }}
          placeholder="Jump to… (sections, agents, goals)"
          className="w-full bg-bg border border-line rounded-md px-3 py-2 text-[13px] text-strong outline-none focus:border-dim"
        />
        <div className="mt-2 flex flex-col">
          {filtered.map((i, idx) => (
            <button key={i.label} onClick={i.run}
              className={`text-left px-3 py-1.5 text-[12px] rounded-md flex gap-3 ${idx === sel ? "bg-raised text-strong" : "text-fg hover:bg-raised"}`}>
              <span>{i.label}</span>
              <span className="text-dim ml-auto text-[10px]">{i.hint}</span>
            </button>
          ))}
          {filtered.length === 0 && <div className="text-dim text-[11px] px-3 py-2">No match.</div>}
        </div>
      </div>
    </div>
  );
}
