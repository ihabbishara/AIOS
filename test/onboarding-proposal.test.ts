// test/onboarding-proposal.test.ts — the proposal is the seam between where an org comes from
// (template now, Architect in plan 2b) and how it lands. proposalShape guards the whole-proposal
// invariants that per-item validators cannot see.
import { describe, it, expect } from "vitest";
import { templateToProposal, proposalShape } from "../src/onboarding/proposal.js";
import type { OrgTemplate } from "../src/onboarding/templates.js";

const tpl: OrgTemplate = {
  name: "tiny", title: "Tiny", summary: "Small.", firstJob: "Say hello.",
  departments: [{
    department: "operations", mission: "Front door.", memoDomain: "general",
    lead: "nova", capabilities: [], playbooks: [],
  }],
  agents: [{
    name: "nova", department: "operations", kind: "coordinator", title: "Coordinator",
    charter: "Route.", persona: "Brief.", prompt: "You route.", capabilities: ["coordination"], skills: [],
  }],
};

describe("templateToProposal", () => {
  it("carries the template through and records its source", () => {
    const p = templateToProposal(tpl);
    expect(p.source).toEqual({ kind: "template", template: "tiny" });
    expect(p.departments[0].department).toBe("operations");
    expect(p.agents[0].kind).toBe("coordinator");
    expect(p.firstJob).toBe("Say hello.");
  });
});

describe("proposalShape", () => {
  it("accepts a proposal produced from a template", () => {
    expect(proposalShape(templateToProposal(tpl)).ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(proposalShape(null)).toEqual({ ok: false, error: "proposal must be an object" });
    expect(proposalShape("nope")).toEqual({ ok: false, error: "proposal must be an object" });
  });

  it("requires at least one department and one agent", () => {
    const p = templateToProposal(tpl);
    expect(proposalShape({ ...p, departments: [] }))
      .toEqual({ ok: false, error: "proposal needs at least one department" });
    expect(proposalShape({ ...p, agents: [] }))
      .toEqual({ ok: false, error: "proposal needs at least one agent" });
  });

  it("requires exactly one coordinator — loadRegistry throws otherwise", () => {
    const p = templateToProposal(tpl);
    const worker = { ...p.agents[0], name: "scout", kind: "worker" as const };
    expect(proposalShape({ ...p, agents: [worker] }))
      .toEqual({ ok: false, error: "proposal needs exactly one coordinator, found 0" });
    expect(proposalShape({ ...p, agents: [p.agents[0], { ...p.agents[0], name: "nova2" }] }))
      .toEqual({ ok: false, error: "proposal needs exactly one coordinator, found 2" });
  });

  it("rejects duplicate agent names inside the proposal", () => {
    const p = templateToProposal(tpl);
    const dup = { ...p.agents[0], kind: "worker" as const };
    expect(proposalShape({ ...p, agents: [p.agents[0], dup] }))
      .toEqual({ ok: false, error: 'duplicate agent name "nova" in proposal' });
  });

  it("rejects duplicate department names inside the proposal", () => {
    const p = templateToProposal(tpl);
    expect(proposalShape({ ...p, departments: [p.departments[0], p.departments[0]] }))
      .toEqual({ ok: false, error: 'duplicate department "operations" in proposal' });
  });

  it("rejects an agent whose department is in neither the proposal nor anywhere else", () => {
    const p = templateToProposal(tpl);
    expect(proposalShape({ ...p, agents: [{ ...p.agents[0], department: "ghost" }] }))
      .toEqual({ ok: false, error: 'agent "nova" names department "ghost", which the proposal does not create' });
  });

  it("requires a non-empty firstJob", () => {
    const p = templateToProposal(tpl);
    expect(proposalShape({ ...p, firstJob: "  " })).toEqual({ ok: false, error: "firstJob required" });
  });
});
