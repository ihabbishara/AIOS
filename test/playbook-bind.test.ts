// test/playbook-bind.test.ts — binding a shipped playbook to an org that never heard of its agents.
import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { bindPlaybook, type RosterAgent } from "../src/agents/registry/bind.js";
import { loadPlaybook, playbookSlots, playbookSchema, type Playbook } from "../src/engine/playbook.js";

/** name → canonical, the shape loadRegistry builds. Aliases map to their agent. */
function agentOf(roster: RosterAgent[], aliases: Record<string, string> = {}): Map<string, string> {
  const m = new Map(roster.map((a) => [a.name, a.name]));
  for (const [alias, canonical] of Object.entries(aliases)) m.set(alias, canonical);
  return m;
}

/** A roster with none of the author's names, shaped like something the architect would produce
 *  for a software company: a coordinator, a research pair, and a build/test pair. */
const GENERIC: RosterAgent[] = [
  { name: "axis", kind: "coordinator", capabilities: ["coordination", "memory"] },
  { name: "quill", kind: "lead", capabilities: ["web", "files-ro", "memory"] },
  { name: "vera", kind: "critic", capabilities: ["web-fetch", "files-ro"] },
  { name: "forge", kind: "worker", capabilities: ["editing", "shell", "files-ro", "code-sandbox"] },
  { name: "probe", kind: "critic", capabilities: ["shell", "code-sandbox", "files-ro"] },
  { name: "muse", kind: "worker", capabilities: ["web", "files-ro", "code-sandbox"] },
];

/** A research-only org, the shape onboarding actually produced on 2026-08-11. */
const RESEARCH_ONLY: RosterAgent[] = [
  { name: "nova", kind: "coordinator", capabilities: ["coordination", "memory"] },
  { name: "delve", kind: "lead", capabilities: ["web", "web-fetch", "memory", "drafting"] },
  { name: "sift", kind: "critic", capabilities: ["web-fetch", "files-ro", "memory"] },
  { name: "pulse", kind: "lead", capabilities: ["memory", "drafting", "todo"] },
];

function stockPlaybooks(dir = "playbooks"): Playbook[] {
  const out: Playbook[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...stockPlaybooks(full));
    else if (/\.ya?ml$/.test(entry)) out.push(loadPlaybook(full));
  }
  return out;
}

function pb(over: Partial<Playbook> & Pick<Playbook, "stages">): Playbook {
  return playbookSchema.parse({ name: "t", description: "d", ...over });
}

describe("bindPlaybook", () => {
  it("binds every shipped playbook for an org with none of the author's agent names", () => {
    // The bug this whole mechanism exists for: the seven stock playbooks named the author's
    // roster, the architect names every org afresh, so a new install loaded ZERO playbooks and
    // said nothing about it. Any playbook added later has to clear the same bar.
    const books = stockPlaybooks();
    expect(books.length).toBeGreaterThanOrEqual(7);
    for (const book of books) {
      const r = bindPlaybook(book, GENERIC, agentOf(GENERIC));
      expect(r.unresolved, `${book.name} should bind against a generic roster`).toEqual([]);
      for (const name of playbookSlots(r.playbook)) {
        expect(GENERIC.map((a) => a.name)).toContain(name);
      }
    }
  });

  it("keeps a research-only org's playbooks and honestly drops the ones it cannot staff", () => {
    const byName = new Map(stockPlaybooks().map((b) => [b.name, b]));
    const of = agentOf(RESEARCH_ONLY);
    for (const name of ["research-report", "market-research", "echo"]) {
      expect(bindPlaybook(byName.get(name)!, RESEARCH_ONLY, of).unresolved,
        `${name} should bind for a research org`).toEqual([]);
    }
    // Nobody here can edit files or run a shell, so offering these would be a lie.
    for (const name of ["code-build", "code-inplace", "code-analyze"]) {
      expect(bindPlaybook(byName.get(name)!, RESEARCH_ONLY, of).unresolved.length,
        `${name} should drop for a research org`).toBeGreaterThan(0);
    }
  });

  it("prefers the named agent over an agent aliased to the slot id", () => {
    // Regression: agents here carry role-shaped aliases (odin answers to "researcher"), so
    // reading a slot id as an agent name first silently rebound research-report's producer from
    // clio to odin — on the very install the playbook was written for.
    const roster: RosterAgent[] = [
      { name: "odin", kind: "worker", capabilities: ["web"] },
      { name: "clio", kind: "lead", capabilities: ["web"] },
      { name: "minos", kind: "critic", capabilities: [] },
    ];
    const book = pb({
      bind: {
        researcher: { prefer: "clio", kind: ["lead", "worker"], capabilities: ["web"] },
        reviewer: { prefer: "minos", kind: ["critic"], capabilities: [] },
      },
      stages: [{ type: "loop", id: "r", producer: "researcher", critic: "reviewer", maxRounds: 2 }],
    });
    const r = bindPlaybook(book, roster, agentOf(roster, { researcher: "odin" }));
    expect(r.unresolved).toEqual([]);
    expect(r.playbook.stages[0]).toMatchObject({ producer: "clio", critic: "minos" });
  });

  it("falls back to the selector when the preferred agent is not in this org", () => {
    const book = pb({
      bind: { researcher: { prefer: "clio", kind: ["lead"], capabilities: ["web"] } },
      stages: [{ type: "single", id: "s", role: "researcher" }],
    });
    const r = bindPlaybook(book, RESEARCH_ONLY, agentOf(RESEARCH_ONLY));
    expect(r.unresolved).toEqual([]);
    expect(r.playbook.stages[0]).toMatchObject({ role: "delve" });
  });

  it("never puts the same agent on both sides of a review loop", () => {
    const roster: RosterAgent[] = [
      { name: "solo", kind: "lead", capabilities: ["web"] },
      { name: "judge", kind: "critic", capabilities: ["web"] },
    ];
    const book = pb({
      bind: {
        producer: { kind: ["lead", "critic"], capabilities: ["web"] },
        checker: { kind: ["critic", "lead"], capabilities: ["web"] },
      },
      stages: [{ type: "loop", id: "r", producer: "producer", critic: "checker", maxRounds: 2 }],
    });
    const r = bindPlaybook(book, roster, agentOf(roster));
    const stage = r.playbook.stages[0] as { producer: string; critic: string };
    expect(r.unresolved).toEqual([]);
    expect(stage.producer).not.toBe(stage.critic);
  });

  it("still fills a tight roster that a greedy in-order assignment would strand", () => {
    // `wide` matches both agents and `narrow` only matches one. Taken in playbook order, wide
    // takes `only` and narrow is left with nothing — so the assignment has to back off.
    const roster: RosterAgent[] = [
      { name: "only", kind: "critic", capabilities: ["rare"] },
      { name: "other", kind: "critic", capabilities: [] },
    ];
    const book = pb({
      bind: {
        wide: { kind: ["critic"], capabilities: [] },
        narrow: { kind: ["critic"], capabilities: ["rare"] },
      },
      stages: [{ type: "loop", id: "r", producer: "wide", critic: "narrow", maxRounds: 2 }],
    });
    const r = bindPlaybook(book, roster, agentOf(roster));
    expect(r.unresolved).toEqual([]);
    expect(r.playbook.stages[0]).toMatchObject({ producer: "other", critic: "only" });
  });

  it("reports the unfillable slots, and leaves an unbound playbook alone", () => {
    const book = pb({
      bind: { welder: { kind: ["worker"], capabilities: ["plasma"] } },
      stages: [{ type: "single", id: "s", role: "welder" }],
    });
    const r = bindPlaybook(book, RESEARCH_ONLY, agentOf(RESEARCH_ONLY));
    expect(r.unresolved).toEqual(["welder"]);
    expect(r.playbook.stages[0]).toMatchObject({ role: "welder" });
  });

  it("still resolves a playbook that names its agents outright, and drops one that cannot", () => {
    const book = pb({ stages: [{ type: "single", id: "s", role: "delve" }] });
    expect(bindPlaybook(book, RESEARCH_ONLY, agentOf(RESEARCH_ONLY)).unresolved).toEqual([]);
    const missing = pb({ stages: [{ type: "single", id: "s", role: "ghost" }] });
    expect(bindPlaybook(missing, RESEARCH_ONLY, agentOf(RESEARCH_ONLY)).unresolved).toEqual(["ghost"]);
  });

  it("lets one agent hold two slots when the playbook names it for both", () => {
    // code-inplace implements and then fixes with the same agent on purpose — the distinctness
    // rule applies to inferred slots, not to what the author wrote down.
    const book = pb({
      stages: [
        { type: "single", id: "impl", role: "delve" },
        { type: "verify", id: "test", runner: "sift", fixer: "delve", maxRounds: 2 },
      ],
    });
    const r = bindPlaybook(book, RESEARCH_ONLY, agentOf(RESEARCH_ONLY));
    expect(r.unresolved).toEqual([]);
    expect(r.playbook.stages[1]).toMatchObject({ runner: "sift", fixer: "delve" });
  });
});
