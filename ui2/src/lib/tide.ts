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
 *  elapse with no new event arriving to prompt a re-evaluation. */
export function useTide(working: number): TideLevel {
  const [state, setState] = useState<TideState>(() => tideInit(working));
  const latest = useRef(working);
  latest.current = working;
  useEffect(() => {
    setState((s) => tideStep(s, working, Date.now()));
  }, [working]);
  useEffect(() => {
    const id = setInterval(() => setState((s) => tideStep(s, latest.current, Date.now())), 1000);
    return () => clearInterval(id);
  }, []);
  return state.level;
}
