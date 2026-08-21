// ui2/src/views/home/Field.tsx — the org as a body (spec 2026-08-02 §6).
// The tide changes scale and spacing, never structure: every dot stays mounted in
// the same grid slot at every level, so it cannot move when work starts. Compression
// is the same picture drawn smaller, not a second layout.
import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "../../components/ui.js";
import { DOT_TOKEN, dotOrdinals, type Cluster } from "../../lib/field.js";
import type { Offer } from "../../lib/offers.js";
import { pickTravel, travelPath, type Point, type Travel } from "../../lib/travel.js";
import type { TideLevel } from "../../lib/tide.js";
import type { StoredEvent } from "../../api.js";

const DOT_SIZE: Record<TideLevel, string> = {
  high: "size-2.5",
  mid: "size-2",
  // Not smaller than a full stop. At the low tide this dot IS the screen, and a 5px
  // one read as dust rather than as an org standing by.
  low: "size-[7px]",
};

/** Gap between neighbouring dots' pulses, so the field ripples in reading order
 *  rather than blinking in unison — a heartbeat, not a strobe. */
const PULSE_STAGGER_MS = 150;

const NO_OFFERS: Offer[] = [];
const NO_EVENTS: StoredEvent[] = [];

/** Centres of every [data-dot] inside `ref`, in the container's own coordinates.
 *  Stays empty until something has real geometry — jsdom measures every rect at 0,
 *  which is honestly the same case as "we do not know where the dots are". */
function useDotCenters(
  ref: { current: HTMLDivElement | null },
  clusters: Cluster[],
  level: TideLevel,
  offerCount: number,
): Record<string, Point> {
  const [centers, setCenters] = useState<Record<string, Point>>({});
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const base = el.getBoundingClientRect();
      const next: Record<string, Point> = {};
      for (const d of el.querySelectorAll<HTMLElement>("[data-dot]")) {
        const r = d.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        next[d.dataset.dot ?? ""] = {
          x: r.left - base.left + r.width / 2,
          y: r.top - base.top + r.height / 2,
        };
      }
      setCenters(next);
    };
    // The tide moves every dot's size and gap over 1400ms, and each of those fires
    // its own transitionend. Coalesce the burst — one measure per settled layout.
    let queued: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (queued) return;
      queued = setTimeout(() => { queued = undefined; measure(); }, 0);
    };
    measure();
    el.addEventListener("transitionend", schedule);
    // Guarded: jsdom has no ResizeObserver, and a missing one has to leave the field
    // inert rather than take the whole component down with it.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    ro?.observe(el);
    return () => {
      clearTimeout(queued);
      el.removeEventListener("transitionend", schedule);
      ro?.disconnect();
    };
  }, [ref, clusters, level, offerCount]);
  return centers;
}

export function Field({ clusters, level, live, offers = NO_OFFERS, onOffer, events = NO_EVENTS }: {
  clusters: Cluster[];
  level: TideLevel;
  /** SSE connected. False freezes every animation — motion on stale data is a lie. */
  live: boolean;
  /** What an idle agent could pick up (lib/offers.ts). The low tide's mirror of the
   *  busy captions: at rest the field says what it COULD do instead of what it is doing. */
  offers?: Offer[];
  onOffer?: (offer: Offer) => void;
  /** The SSE buffer, read only for `travel`. Optional so the field renders without one. */
  events?: StoredEvent[];
}) {
  const compact = level === "low";
  // What the working agents are actually doing, in words. The dots say how many;
  // this says what — and it is the only thing on screen that fills the field with
  // information rather than padding.
  const busy = clusters.flatMap((c) =>
    c.dots.filter((d) => d.state === "now" && d.currentTask).map((d) => ({ name: d.name, task: d.currentTask! })),
  );
  const ordinals = useMemo(() => dotOrdinals(clusters), [clusters]);

  const fieldRef = useRef<HTMLDivElement>(null);
  const centers = useDotCenters(fieldRef, clusters, level, offers.length);

  const onField = useMemo(
    () => new Set(clusters.flatMap((c) => c.dots.map((d) => d.name))),
    [clusters],
  );
  const [travel, setTravel] = useState<Travel | null>(null);
  const flown = useRef<number | null>(null);
  useEffect(() => {
    // The first pass only takes a high-water mark. The stream replays its last events
    // on reconnect, and re-flying a memo the org has already moved past would be
    // motion that is not happening.
    if (flown.current === null) { flown.current = events.at(-1)?.id ?? 0; return; }
    const next = pickTravel(events, flown.current, onField);
    if (!next) return;
    flown.current = next.id;
    setTravel(next);
  }, [events, onField]);
  const path = travel && centers[travel.from] && centers[travel.to]
    ? travelPath(centers[travel.from], centers[travel.to])
    : null;

  // Ids seen in a previous render never re-animate (spec §3 arrival rule).
  const seen = useRef(new Set<string>());
  const isNew = (id: string) => {
    if (seen.current.has(id)) return false;
    seen.current.add(id);
    if (seen.current.size > 500) { // bound it — the cockpit runs for weeks at a time
      const it = seen.current.values();
      for (let i = 0; i < 250; i++) seen.current.delete(it.next().value as string);
    }
    return true;
  };

  return (
    // content-center, not content-start: the field owns most of the height at high
    // tide, and top-aligning a few clusters inside it reads as a broken layout
    // rather than as air.
    <div ref={fieldRef} className="relative h-full flex flex-col justify-center gap-7 px-5 py-4">
    <div
      className={`flex flex-wrap content-center transition-all duration-[1400ms] ${
        compact ? "gap-x-6 gap-y-4" : "gap-x-10 gap-y-7"
      }`}
    >
      {clusters.map((c) => (
        <div key={c.department} className="flex flex-col">
          {/* Kept legible at every tide: at rest the names ARE the content, and a
              field of anonymous dots is a chart of a company rather than the company. */}
          <div
            data-labels
            className={`label transition-all duration-[1400ms] ${compact ? "mb-1" : "mb-2"}`}
          >
            {c.department}
          </div>
          <div
            className="grid transition-all duration-[1400ms]"
            style={{
              gridTemplateColumns: "repeat(4, min-content)",
              columnGap: compact ? "10px" : "20px",
              rowGap: compact ? "8px" : "16px",
            }}
          >
            {c.dots.map((d) => {
              // Ambient, and bound to a fact: the SSE link is alive while the org rests.
              // Opacity and scale only — a dot never moves (lib/field.ts).
              const pulses = live && compact && d.state === "rest";
              return (
              <div
                key={d.name}
                style={{ gridColumn: d.col + 1, gridRow: d.row + 1 }}
                className="text-center"
              >
                <div
                  data-dot={d.name}
                  title={d.currentTask ?? d.title}
                  style={pulses ? { animationDelay: `${(ordinals.get(d.name) ?? 0) * PULSE_STAGGER_MS}ms` } : undefined}
                  className={`${DOT_SIZE[level]} rounded-full mx-auto transition-all duration-[1400ms] ${
                    DOT_TOKEN[d.state]
                  } ${live && d.state === "now" ? "breath" : ""} ${pulses ? "rest-pulse" : ""}`}
                />
                <div
                  className={`text-[9px] transition-all duration-[1400ms] ${compact ? "mt-1" : "mt-1.5"} ${
                    d.state === "rest" ? "text-dim" : "text-fg"
                  }`}
                >
                  {d.name}
                </div>
              </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>

    {/* One block, two tides. Busy: what is running, in words. At rest: what an idle
        agent could pick up — the same space answering the only question left. */}
    {compact
      ? offers.length > 0 && (
        <div className="flex flex-col items-start gap-1.5">
          {offers.map((o) => (
            <button
              key={o.id}
              onClick={() => onOffer?.(o)}
              className={`group flex items-center gap-2.5 text-left rounded-full border border-line bg-raised/60 pl-1 pr-3 py-1 hover:border-dim transition-colors ${
                isNew(o.id) ? "arrive" : ""
              }`}
            >
              <Avatar name={o.agent} />
              <span className="text-[13px] leading-snug text-fg group-hover:text-strong transition-colors">{o.text}</span>
              <span className="text-dim shrink-0 group-hover:text-strong transition-colors">→</span>
            </button>
          ))}
        </div>
      )
      : busy.length > 0 && (
        <div className="flex flex-col gap-1.5 text-[13px] leading-relaxed">
          {busy.map((b) => (
            <div key={b.name} className="flex items-baseline gap-2">
              <span className={`size-1.5 rounded-full shrink-0 translate-y-[-1px] bg-now ${live ? "breath" : ""}`} />
              <span className="text-strong">{b.name}</span>
              <span className="text-fg">{b.task}</span>
            </div>
          ))}
        </div>
      )}

    {/* One memo crossing, once. No geometry (a fresh mount, or a headless test) means
        no mote — an arc drawn between dots we cannot locate would be decoration. */}
    {live && travel && path && (
      <span
        key={travel.id}
        aria-hidden
        className="travel absolute left-0 top-0 size-[5px] rounded-full bg-info pointer-events-none"
        style={{ offsetPath: `path("${path}")` }}
      />
    )}
    </div>
  );
}
