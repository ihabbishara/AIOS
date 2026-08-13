// src/agents/registry/bind.ts — bind a playbook's slots to the agents an org actually has.
//
// playbooksDir is shared install state; agents/ is per-user. A playbook shipped with the product
// therefore cannot name agents and expect them to exist: onboarding's architect invents a fresh
// roster for every org, so the seven stock playbooks — all written against the author's roster —
// resolved to nothing at all for every user but the author, and were dropped in silence.
//
// Resolution is deliberately in this order:
//   1. the slot IS an agent (or alias) here            — a playbook written for this org
//   2. its binding prefers an agent that exists here   — the author's roster, unchanged
//   3. its binding describes a kind + capabilities     — any other org
// so an install that has the named agents binds exactly as it did before this file existed, and
// only orgs that don't have them fall through to inference.
import { playbookSlots, type Playbook, type Stage } from "../../engine/playbook.js";

/** The subset of an AgentDef binding needs. Structural on purpose: loader.ts imports this module,
 *  so this module must not import loader.ts back. */
export interface RosterAgent {
  name: string;
  kind: string;
  capabilities: string[];
}

export interface BindResult {
  /** Every slot rewritten to a real agent name. Meaningful only when `unresolved` is empty. */
  playbook: Playbook;
  /** Slot ids nothing in this org can fill. Non-empty means the playbook cannot run here. */
  unresolved: string[];
}

function rewrite(pb: Playbook, pick: Map<string, string>): Playbook {
  const n = (slot: string) => pick.get(slot) ?? slot;
  const stages = pb.stages.map((s): Stage => {
    if (s.type === "single") return { ...s, role: n(s.role) };
    if (s.type === "loop") return { ...s, producer: n(s.producer), critic: n(s.critic) };
    return { ...s, runner: n(s.runner), fixer: n(s.fixer) };
  });
  return { ...pb, stages };
}

export function bindPlaybook(pb: Playbook, roster: RosterAgent[], agentOf: Map<string, string>): BindResult {
  const pick = new Map<string, string>();
  const open: Array<{ slot: string; candidates: string[] }> = [];

  // Slot pairs that must not land on the same agent: a producer cannot review its own output and
  // a fixer cannot sign off on its own fix. Nothing else is constrained — a small org may quite
  // reasonably have one agent both research and design, and requiring a distinct agent for every
  // slot instead made the biggest playbooks unstaffable (code-build has six slots, so any org
  // with five eligible agents was refused a playbook it could actually run).
  const conflict = new Map<string, Set<string>>();
  const pair = (a: string, b: string) => {
    if (a === b) return; // named for both on purpose — the author's call, not a conflict
    if (!conflict.has(a)) conflict.set(a, new Set());
    if (!conflict.has(b)) conflict.set(b, new Set());
    conflict.get(a)!.add(b);
    conflict.get(b)!.add(a);
  };
  for (const s of pb.stages) {
    if (s.type === "loop") pair(s.producer, s.critic);
    else if (s.type === "verify") pair(s.runner, s.fixer);
  }
  const clashes = (slot: string, name: string) =>
    [...(conflict.get(slot) ?? [])].some((other) => pick.get(other) === name);

  // Pass 1 — the explicit slots. These are exempt from the pairing rule, because a playbook may
  // deliberately use one agent twice: code-inplace implements and then fixes with the same one,
  // which is the whole point of a verify stage.
  for (const slot of playbookSlots(pb)) {
    const binding = pb.bind?.[slot];
    // A slot that HAS a binding is a role and is never re-read as an agent name, even when the
    // org happens to have one by that name. Agents here carry role-shaped aliases — odin answers
    // to "researcher", athena to "architect" — so reading the id as a name first silently rebound
    // research-report's producer from clio to odin on the very install it was written for.
    const fixed = binding
      ? (binding.prefer ? agentOf.get(binding.prefer) : undefined)
      : agentOf.get(slot);
    if (fixed) {
      pick.set(slot, fixed);
      continue;
    }
    if (!binding) {
      // A slot that is neither an agent here nor described. Nothing to infer from — this is the
      // old "no such agent" case, and it still drops the playbook.
      open.push({ slot, candidates: [] });
      continue;
    }
    const kinds: string[] = binding.kind ?? [];
    const candidates = roster
      .filter((a) => !kinds.length || kinds.includes(a.kind))
      .filter((a) => binding.capabilities.every((c) => a.capabilities.includes(c)))
      // Kind order in the binding is a preference, so a slot listing [lead, worker] takes the
      // lead when both are available. Name breaks the tie, so a given org always binds the same
      // way — a playbook that silently picked a different agent per boot would be untraceable.
      .sort((x, y) => (kinds.indexOf(x.kind) - kinds.indexOf(y.kind)) || (x.name < y.name ? -1 : 1))
      .map((a) => a.name);
    open.push({ slot, candidates });
  }

  // Pass 2 — infer the rest. Most-constrained first with backtracking: taking slots in playbook
  // order lets a roomy early slot take the one agent a later, tighter slot could have used.
  open.sort((a, b) => a.candidates.length - b.candidates.length);
  const assign = (i: number): boolean => {
    const slot = open[i];
    if (!slot) return true;
    for (const name of slot.candidates) {
      if (clashes(slot.slot, name)) continue;
      pick.set(slot.slot, name);
      if (assign(i + 1)) return true;
      pick.delete(slot.slot);
    }
    return false;
  };

  if (!assign(0)) {
    // Prefer the precise complaint: slots with no candidate at all are why this failed. Only when
    // every slot had candidates is the failure a collision, and then the open set is the answer —
    // no single slot is at fault.
    const empty = open.filter((o) => !o.candidates.length).map((o) => o.slot);
    return { playbook: pb, unresolved: empty.length ? empty : open.map((o) => o.slot) };
  }

  return { playbook: rewrite(pb, pick), unresolved: [] };
}
