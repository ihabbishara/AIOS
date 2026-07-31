import { describe, it, expect } from "vitest";
import {
  ARCHITECT_SYSTEM, INTERVIEW_SCHEMA, buildArchitectContext, renderTranscript, productCapabilities,
  interviewTurn, redraftAgent,
} from "../src/onboarding/architect.js";
import type { OrgTemplate } from "../src/onboarding/templates.js";

const tpl: OrgTemplate = {
  name: "starter", title: "Starter", summary: "Small.", firstJob: "Say hello.",
  departments: [{ department: "operations", mission: "Front door.", memoDomain: "general", lead: "nova", capabilities: [], playbooks: [] }],
  agents: [{
    name: "nova", department: "operations", kind: "coordinator", title: "Coordinator",
    charter: "Route.", persona: "Brief.", prompt: "You route.", capabilities: ["coordination"], skills: [],
  }],
};

describe("productCapabilities", () => {
  it("keeps the personal-domain capabilities — they are product features for every user", () => {
    const out = productCapabilities([
      { name: "money-analysis" }, { name: "lifeops" }, { name: "ledger" }, { name: "research-kb" },
    ]);
    expect(out).toEqual(["money-analysis", "lifeops", "ledger", "research-kb"]);
  });

  it("drops client-specific capabilities", () => {
    const out = productCapabilities([
      { name: "web" }, { name: "halalo-aws", labels: ["client.halalo"] },
    ]);
    expect(out).toEqual(["web"]);
  });
});

describe("buildArchitectContext", () => {
  const ctx = buildArchitectContext({
    capabilities: [{ name: "web" }, { name: "coordination" }, { name: "halalo-aws", labels: ["client.halalo"] }],
    skills: [{ name: "market-sizing", description: "Estimate market size." }],
    templates: [tpl],
  });

  it("lists the capabilities the Architect may use", () => {
    expect(ctx).toContain("web");
    expect(ctx).toContain("coordination");
  });

  it("never shows a client capability — proposing it would fail validation", () => {
    expect(ctx).not.toContain("halalo-aws");
  });

  it("lists skills with their descriptions", () => {
    expect(ctx).toContain("market-sizing");
    expect(ctx).toContain("Estimate market size.");
  });

  it("includes a template as a worked example", () => {
    expect(ctx).toContain("starter");
    expect(ctx).toContain("nova");
  });
});

describe("ARCHITECT_SYSTEM", () => {
  it("states the hard rules the validators will enforce anyway", () => {
    // These are not style preferences — each one mirrors a validator that would reject the
    // proposal at provision, so telling the model up front is what keeps drafts provisionable.
    expect(ARCHITECT_SYSTEM).toMatch(/exactly one coordinator/i);
    expect(ARCHITECT_SYSTEM).toMatch(/kebab/i);
  });
});

describe("INTERVIEW_SCHEMA", () => {
  it("forces a done flag and forbids extra keys", () => {
    expect(INTERVIEW_SCHEMA.additionalProperties).toBe(false);
    expect((INTERVIEW_SCHEMA.required as readonly string[])).toContain("done");
    const props = INTERVIEW_SCHEMA.properties as Record<string, unknown>;
    expect(props.question).toBeTruthy();
    expect(props.proposal).toBeTruthy();
  });

  it("describes an agent with every field renderAgentYaml needs", () => {
    const props = INTERVIEW_SCHEMA.properties as Record<string, any>;
    const agent = props.proposal.properties.agents.items.properties;
    for (const f of ["name", "department", "kind", "title", "charter", "persona", "prompt", "capabilities", "skills"]) {
      expect(agent[f], f).toBeTruthy();
    }
    expect(agent.kind.enum).toEqual(["coordinator", "lead", "worker", "critic"]);
  });
});

describe("renderTranscript", () => {
  it("labels both sides so a stateless replay reads as a conversation", () => {
    const out = renderTranscript([
      { role: "user", text: "I run a design studio." },
      { role: "architect", text: "What eats most of your time?" },
      { role: "user", text: "Writing proposals." },
    ]);
    expect(out).toContain("I run a design studio.");
    expect(out).toContain("What eats most of your time?");
    expect(out.indexOf("design studio")).toBeLessThan(out.indexOf("Writing proposals"));
  });

  it("survives an empty transcript — the first turn has nothing to replay", () => {
    expect(() => renderTranscript([])).not.toThrow();
  });
});

describe("interviewTurn", () => {
  const ctx = "CAPABILITIES YOU MAY USE:\nweb, coordination";
  const goodProposal = {
    departments: [{ department: "operations", mission: "Front door.", memoDomain: "general", lead: "nova", capabilities: [], playbooks: [] }],
    agents: [{
      name: "nova", department: "operations", kind: "coordinator", title: "Coordinator",
      charter: "Route.", persona: "Brief.", prompt: "You route.", capabilities: [], skills: [],
    }],
    firstJob: "Say hello.",
  };

  it("returns the next question when the Architect is not done", async () => {
    const r = await interviewTurn([{ role: "user", text: "hi" }], ctx,
      async () => ({ done: false, question: "What do you do?" }));
    expect(r).toEqual({ done: false, question: "What do you do?" });
  });

  it("returns a proposal stamped with the interview source", async () => {
    const r = await interviewTurn([], ctx, async () => ({ done: true, proposal: goodProposal }));
    expect(r.done).toBe(true);
    if (!r.done) return;
    expect(r.proposal.source).toEqual({ kind: "interview" });
    expect(r.proposal.agents[0].name).toBe("nova");
  });

  it("passes the system prompt and the replayed transcript to the model", async () => {
    let seenSystem = "", seenPrompt = "";
    await interviewTurn([{ role: "user", text: "I run a bakery" }], ctx, async (s, p) => {
      seenSystem = s; seenPrompt = p;
      return { done: false, question: "ok?" };
    });
    expect(seenSystem).toContain("exactly one coordinator".toLowerCase().slice(0, 8));
    expect(seenSystem).toContain("CAPABILITIES YOU MAY USE");
    expect(seenPrompt).toContain("I run a bakery");
  });

  // The whole architecture principle: LLM creativity upstream, deterministic validation
  // downstream. A bad proposal must die here, not at provision.
  it("rejects a proposal that fails the structural gate", async () => {
    const twoCoordinators = {
      ...goodProposal,
      agents: [goodProposal.agents[0], { ...goodProposal.agents[0], name: "nova2" }],
    };
    await expect(interviewTurn([], ctx, async () => ({ done: true, proposal: twoCoordinators })))
      .rejects.toThrow(/exactly one coordinator/);
  });

  it("rejects a done response with no proposal", async () => {
    await expect(interviewTurn([], ctx, async () => ({ done: true })))
      .rejects.toThrow(/no proposal/i);
  });

  it("rejects a not-done response with no question", async () => {
    await expect(interviewTurn([], ctx, async () => ({ done: false })))
      .rejects.toThrow(/no question/i);
  });

  // structured_output is undefined whenever the SDK denied the StructuredOutput tool — the
  // exact failure that made this a named constraint.
  it("names the structured-output failure rather than throwing on undefined", async () => {
    await expect(interviewTurn([], ctx, async () => undefined))
      .rejects.toThrow(/structured output/i);
  });
});

describe("redraftAgent", () => {
  const proposal = {
    source: { kind: "interview" as const },
    departments: [{ department: "operations", mission: "Front door.", memoDomain: "general", capabilities: [], playbooks: [] }],
    agents: [{
      name: "nova", department: "operations", kind: "coordinator" as const, title: "Coordinator",
      charter: "Route.", persona: "Brief.", prompt: "You route.", capabilities: [], skills: [],
    }],
    firstJob: "Say hello.",
  };

  it("returns a redrafted agent keeping its identity", async () => {
    const r = await redraftAgent(proposal, "nova", "make it warmer", "ctx", async () => ({
      done: true,
      proposal: { ...proposal, agents: [{ ...proposal.agents[0], persona: "Warm and unhurried." }] },
    }));
    expect(r.name).toBe("nova");
    expect(r.department).toBe("operations");
    expect(r.kind).toBe("coordinator");
    expect(r.persona).toBe("Warm and unhurried.");
  });

  it("puts the note and the current draft in front of the model", async () => {
    let seen = "";
    await redraftAgent(proposal, "nova", "make it warmer", "ctx", async (_s, p) => {
      seen = p;
      return { done: true, proposal };
    });
    expect(seen).toContain("make it warmer");
    expect(seen).toContain("You route.");
  });

  it("refuses an agent that is not in the proposal", async () => {
    await expect(redraftAgent(proposal, "ghost", "x", "ctx", async () => ({ done: true, proposal })))
      .rejects.toThrow(/ghost/);
  });

  // Identity is the anchor for the department lead and playbook roles — a redraft that renames
  // or moves the agent would silently break both.
  it("ignores a model attempt to rename or move the agent", async () => {
    const r = await redraftAgent(proposal, "nova", "x", "ctx", async () => ({
      done: true,
      proposal: { ...proposal, agents: [{ ...proposal.agents[0], name: "renamed", department: "elsewhere", kind: "worker" }] },
    }));
    expect(r.name).toBe("nova");
    expect(r.department).toBe("operations");
    expect(r.kind).toBe("coordinator");
  });
});
