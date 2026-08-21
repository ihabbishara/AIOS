// ui2/src/views/Home.tsx — the Organism (spec 2026-08-02).
// Home shows the org working: a field of agent dots over a day clock, whose
// proportions tide with how much is running. The needs-you queue lives one
// keystroke away in a sheet — nothing about triage itself changed.
import { useEffect, useMemo, useState } from "react";
import { api, type AttentionItem, type StoredEvent } from "../api.js";
import { groupQueue, flatQueue } from "../lib/queue.js";
import { useLiveQuery, useFetch } from "../hooks.js";
import { T } from "../lib/topics.js";
import { usd } from "../lib/format.js";
import { fieldLayout, workingCount } from "../lib/field.js";
import { buildOffers, type Offer } from "../lib/offers.js";
import { clockMarks } from "../lib/clock.js";
import { navigate } from "../lib/router.js";
import { useTide } from "../lib/tide.js";
import { Field } from "./home/Field.js";
import { Clock } from "./home/Clock.js";
import { Dock } from "./home/Dock.js";
import { QueueSheet } from "./home/QueueSheet.js";

/** Field / clock split per tide level (spec §6). The two always sum to 80.
 *  Low used to be [14, 66], which squeezed the org into a strip and handed two thirds
 *  of the screen to an empty day. Rest is a state the org spends most of its time in,
 *  so it gets a body worth looking at — and room for what an idle agent could do. */
const SPLIT = { high: [68, 12], mid: [50, 30], low: [32, 48] } as const;

const COUNT = ["Nothing", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const spell = (n: number) => COUNT[n] ?? String(n);

export function Home({ events, attention, connected, onOpenChat }: {
  events: StoredEvent[];
  attention: AttentionItem[] | undefined;
  /** SSE health. False freezes all motion — a moving screen on stale data lies (spec §9). */
  connected: boolean;
  onOpenChat: (target: string, seed?: string) => void;
}) {
  const [selected, setSelected] = useState<AttentionItem | null>(null);
  const [handled, setHandled] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState(false);

  // The NOW marker has to advance with no event to prompt it. 30s, not 1s: the
  // axis is 1440 minutes wide, so a second of drift is invisible anyway.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const { data: org } = useLiveQuery(() => api.org(), events, T.agentsActions);
  const { data: schedule } = useLiveQuery(() => api.schedule(), events, T.schedule);
  const { data: budget } = useLiveQuery(() => api.budget(), events, T.budget);
  const { data: mine } = useLiveQuery(() => api.mailMine(), events, T.agentMail);
  // Both feed the rest offers only. Undefined (in flight, or the read failed) makes an
  // agent offer nothing rather than claim it has nothing to pick up.
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);
  const { data: unread } = useLiveQuery(() => api.mailUnread(), events, T.agentMail);
  // Uptime only ever grows, so no event invalidates it — it rides the 30s tick.
  const { data: health } = useFetch(() => api.health(), [Math.floor(now.getTime() / 30_000)]);

  // neo is the coordinator; "hermes" matches pre-rename brief threads still in the store.
  const brief = mine?.threads.find((t) => t.lastFrom === "neo" || t.lastFrom === "hermes");

  const visible = useMemo(
    () => (attention ?? []).filter((i) => !handled.has(i.id)),
    [attention, handled],
  );
  const groups = useMemo(() => groupQueue(visible), [visible]);
  const clusters = useMemo(() => fieldLayout(org ?? []), [org]);
  // undefined until /api/org lands, so the tide initialises from the first real
  // reading instead of dwelling 8s away from a placeholder zero.
  const working = useMemo(() => (org ? workingCount(org) : undefined), [org]);
  const marks = useMemo(() => (schedule ? clockMarks(schedule, now) : []), [schedule, now]);
  const level = useTide(working);
  const [fieldPct, clockPct] = SPLIT[level];
  const offers = useMemo(() => buildOffers({
    org: org ?? [],
    goals,
    unreadByAgent: unread?.byAgent,
    attention: attention ?? [],
    today: now.toISOString().slice(0, 10),
    now: now.getTime(),
  }), [org, goals, unread, attention, now]);

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
    const optimistic = ["approve", "reject", "read", "abandon", "resume", "accept", "retry", "reopen"].includes(verb);
    if (optimistic) mark(setHandled, item.id, true);
    try {
      if (item.kind === "review" && (verb === "accept" || verb === "retry" || verb === "abandon")) {
        await api.resolveReview(item.ref.goalId, item.ref.node, verb);
      } else if (verb === "approve" || verb === "reject") await api.resolveAction(item.ref.actionId, verb);
      else if (verb === "read") {
        const thread = await api.mailThreadView(item.ref.threadId);
        await Promise.all(thread.filter((m) => m.to === "user" && m.status === "unread").map((m) => api.markMailRead(m.id)));
      } else if (verb === "abandon") await api.goalAction(item.ref.goalId, "abandon");
      else if (verb === "resume") await api.goalAction(item.ref.goalId, "resume");
      else if (verb === "reopen") await api.goalAction(item.ref.goalId, "reopen");
      if (selected?.id === item.id) setSelected(null);
    } catch (err) {
      if (optimistic) mark(setHandled, item.id, false); // rollback
      setRowErrors((e) => ({ ...e, [item.id]: (err as Error).message }));
    } finally {
      mark(setBusy, item.id, false);
    }
  };

  // An offer is a sentence an agent said, so taking it up goes where that sentence
  // points: at the artifact it named, or at the agent itself with the work already
  // typed. Never a silent mutation — nothing here is blocking anyone.
  const takeOffer = (o: Offer) => {
    if ("nav" in o.action) navigate(o.action.nav);
    else onOpenChat(o.action.chat.target, o.action.chat.seed);
  };

  // The brief opens in the canvas, which now lives inside the sheet — so opening
  // one has to raise the sheet too, or the selection would render nowhere.
  const openBrief = (threadId: string) => {
    setSheet(true);
    setSelected({
      kind: "mail", id: `brief:${threadId}`, title: "Brief", meta: "", severity: 4,
      ts: new Date().toISOString(), actions: [], ref: { threadId, brief: "1" },
    });
  };

  // `q` toggles the sheet. j/k/a/r/d only mean something over the queue, so they
  // are gated on it being open — otherwise `a` would fire an approval blind.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "q") { setSheet((s) => !s); return; }
      if (!sheet) return;
      const flat = flatQueue(groupQueue(visible));
      const idx = selected ? flat.findIndex((i) => i.id === selected.id) : -1;
      if (e.key === "j") setSelected(flat[Math.min(idx + 1, flat.length - 1)] ?? null);
      if (e.key === "k") setSelected(flat[Math.max(idx - 1, 0)] ?? null);
      if (!selected) return;
      if (e.key === "a" && selected.actions.includes("approve")) void act(selected, "approve");
      if (e.key === "r" && selected.actions.includes("reject")) void act(selected, "reject");
      if (e.key === "d") onOpenChat("neo", `About "${selected.title}" (${selected.kind} ${selected.id}): `);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, selected, sheet]);

  const needs = visible.length;
  const uptime = health
    ? `up ${Math.floor(health.uptimeMs / 3_600_000)}h ${Math.floor((health.uptimeMs % 3_600_000) / 60_000)}m`
    : "";
  const date = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    // `night` pins this subtree to the dark token set in both themes. The nav
    // outside Home still follows the toggle, so there is no flash on navigation.
    <div className="night flex-1 min-h-0 flex flex-col relative field-ground" data-tide={level}>
      <div className="px-5 pt-6 pb-2 shrink-0">
        <div className="text-[42px] font-extralight tracking-[-0.03em] leading-[1.1] text-bright">
          {/* Blank (not "Resting.") until /api/org lands — claiming the org is idle
              before we know would be the same lie as a dot breathing on dead data.
              The nbsp holds the line box so the block does not jump. */}
          {working === undefined
            ? " "
            : working === 0
              ? "Resting."
              : `${spell(working)} ${working === 1 ? "is" : "are"} working.`}
          <br />
          <span className={needs > 0 ? "text-accent" : "text-dim"}>
            {needs === 0
              ? "Nothing needs you."
              : `${spell(needs)} thing${needs === 1 ? "" : "s"} need${needs === 1 ? "s" : ""} you.`}
          </span>
        </div>
        <div className="font-mono text-[11px] text-dim mt-2 flex items-center gap-2 flex-wrap">
          <span>{date}</span>
          {uptime && <span>· {uptime}</span>}
          {budget && <span>· {usd(budget.spentCents)} today</span>}
          {brief && (
            <button
              onClick={() => openBrief(brief.threadId)}
              className="border border-line rounded-md px-2 py-0.5 text-[10.5px] text-fg hover:text-strong hover:border-dim transition-colors"
            >
              Today's brief →
            </button>
          )}
        </div>
      </div>

      {/* min-h floors the low tide: a percentage of a short viewport clips the grid.
          Raised with the rest state — the low tide now carries labels, names and the
          offers strip, none of which fitted in 92px. */}
      <div className="tide overflow-hidden min-h-[150px]" style={{ height: `${fieldPct}%` }}>
        <Field
          clusters={clusters}
          level={level}
          live={connected}
          offers={offers}
          onOffer={takeOffer}
          events={events}
        />
      </div>
      <div className="tide overflow-hidden" style={{ height: `${clockPct}%` }}>
        <Clock marks={marks} nowMinutes={now.getHours() * 60 + now.getMinutes()} live={connected} />
      </div>

      <div className="mt-auto shrink-0">
        <Dock items={visible} onOpenQueue={() => setSheet(true)} />
      </div>

      <QueueSheet
        open={sheet}
        onClose={() => { setSheet(false); setSelected(null); }}
        groups={groups}
        selected={selected}
        onSelect={setSelected}
        onAct={act}
        rowErrors={rowErrors}
        busy={busy}
        events={events}
        onOpenChat={onOpenChat}
      />
    </div>
  );
}
