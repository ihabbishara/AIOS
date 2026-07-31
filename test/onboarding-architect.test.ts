import { describe, it, expect } from "vitest";
import {
  ARCHITECT_SYSTEM, INTERVIEW_SCHEMA, buildArchitectContext, renderTranscript, productCapabilities,
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
    expect((INTERVIEW_SCHEMA.required as string[])).toContain("done");
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
