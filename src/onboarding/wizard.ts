// src/onboarding/wizard.ts — server-side wizard state machine (spec §1).
// The browser is a thin renderer; every transition is validated here and persisted
// in the existing kv table so refresh/crash resumes in place.

export const STEPS = ["welcome", "auth", "workspace", "connect", "interview", "review", "provision", "first-job", "done"] as const;
export type Step = (typeof STEPS)[number];

export interface KvLike {
  kvGet(key: string): string | undefined;
  kvSet(key: string, value: string): void;
}

const KEY = "onboarding.step";

export class Wizard {
  constructor(private kv: KvLike) {}

  current(): Step {
    const raw = this.kv.kvGet(KEY);
    return (STEPS as readonly string[]).includes(raw ?? "") ? (raw as Step) : "welcome";
  }

  /** Advance one step; `from` must match current so a stale browser tab cannot double-advance. */
  advance(from: Step): Step {
    const cur = this.current();
    if (from !== cur) throw new Error(`stale advance from "${from}" — current step is ${cur}`);
    if (cur === "done") throw new Error("wizard is terminal (done)");
    const next = STEPS[STEPS.indexOf(cur) + 1];
    this.kv.kvSet(KEY, next);
    return next;
  }

  /** Back-navigation to any completed (strictly earlier) step. */
  goBack(to: Step): Step {
    const cur = this.current();
    // -1 catches a `to` that is no step at all, which an HTTP body can carry past the types.
    const at = STEPS.indexOf(to);
    if (at < 0 || at >= STEPS.indexOf(cur)) throw new Error(`cannot go back to "${to}" from ${cur}`);
    this.kv.kvSet(KEY, to);
    return to;
  }
}
