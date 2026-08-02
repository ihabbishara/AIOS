// ui2/src/lib/tide.ts — how much of Home the field gets (spec 2026-08-02 §6).
// Three discrete levels, never a continuum: a continuum is unpredictable to use
// and impossible to assert on.
import { useEffect, useRef, useState } from "react";

export type TideLevel = "high" | "mid" | "low";

/** How long a new level must hold before it commits. Agents finish turns
 *  constantly; without this the page twitches on every agent.end. */
export const TIDE_DWELL_MS = 8000;

export function tideLevel(working: number): TideLevel {
  if (working >= 3) return "high";
  if (working >= 1) return "mid";
  return "low";
}

export interface TideState {
  level: TideLevel;
  /** The level trying to take over, or null when the input agrees with `level`. */
  pending: TideLevel | null;
  /** When `pending` was first observed. Meaningless while pending is null. */
  since: number;
}

export function tideInit(working: number): TideState {
  return { level: tideLevel(working), pending: null, since: 0 };
}

export function tideStep(s: TideState, working: number, now: number): TideState {
  const want = tideLevel(working);
  if (want === s.level) return s.pending === null ? s : { ...s, pending: null, since: 0 };
  // A different pending level restarts the clock — otherwise a flapping input
  // could ride an old timestamp across the threshold.
  if (want !== s.pending) return { ...s, pending: want, since: now };
  if (now - s.since >= TIDE_DWELL_MS) return { level: want, pending: null, since: 0 };
  return s;
}

/** Drives tideStep from the working count plus a ticker, because the dwell can
 *  elapse with no new event arriving to prompt a re-evaluation.
 *
 *  Pass `undefined` while the org payload is still in flight. The dwell must NOT
 *  apply to the first real reading: initialising from a placeholder 0 would park
 *  every page load at "low" for 8s and then swell, which reads as a bug rather
 *  than a tide. */
export function useTide(working: number | undefined): TideLevel {
  const [state, setState] = useState<TideState | null>(null);
  const latest = useRef(working);
  latest.current = working;

  // Seed during render, not in an effect. An effect would leave one frame where
  // the status line says work is happening while the field is still compressed —
  // invisible in a browser, but a genuine flake in tests and a real flash on a
  // slow first paint. React re-renders immediately without committing this pass.
  let seeded = state;
  if (state === null && working !== undefined) {
    seeded = tideInit(working);
    setState(seeded);
  }

  useEffect(() => {
    if (working === undefined) return;
    setState((s) => (s === null ? tideInit(working) : tideStep(s, working, Date.now())));
  }, [working]);
  useEffect(() => {
    const id = setInterval(() => setState((s) => {
      const w = latest.current;
      return s === null || w === undefined ? s : tideStep(s, w, Date.now());
    }), 1000);
    return () => clearInterval(id);
  }, []);
  // Nothing is known to be running before the first payload, so "low" is the
  // honest placeholder.
  return seeded?.level ?? "low";
}
