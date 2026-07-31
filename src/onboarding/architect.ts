// src/onboarding/architect.ts — the built-in Org Architect (spec §4).
//
// NOT a registry agent, and it cannot be one: no org exists during onboarding, so there is no
// coordinator to route to and no manifest to load. It is a hardcoded prompt plus a direct
// query() with no tools and no filesystem — its only output is a forced-JSON proposal, which
// then replays through the same validators that guard manual hiring.
//
// STATELESS PER TURN: every turn replays the whole transcript instead of resuming a session.
// Interviews are 4-6 turns, so the cost is trivial, and it sidesteps SDK session-resume
// semantics entirely (a resumed session freezes its systemPrompt at creation, so per-turn
// context has to ride on the user message anyway).
import type { OrgTemplate } from "./templates.js";

export interface Turn { role: "user" | "architect"; text: string }

/** Client-scoped capabilities are one user's integration, not a product feature — proposing one
 *  would fail validation on any other install. Personal domains (money, lifeops, ledger) stay:
 *  the spec is explicit that those are product capabilities for everyone. */
export function productCapabilities(all: Array<{ name: string; labels?: string[] }>): string[] {
  return all.filter((c) => !(c.labels ?? []).some((l) => l.startsWith("client."))).map((c) => c.name);
}

export const ARCHITECT_SYSTEM = `
You design small AI organisations for a product called AIOS. You are interviewing one person
about their work so you can draft an org of AI agents that will do that work with them.

HOW THE CONVERSATION GOES
Ask ONE question at a time, in plain language, about what they do and what eats their time.
Ask at most 6 questions total, and stop earlier the moment you know enough. Never ask about
technical structure — departments, agent counts, capabilities are your job, not theirs. Never
ask two questions in one turn.

WHEN YOU HAVE ENOUGH
Return done: true with a complete proposal. Everything below is enforced by validators that
will reject the org outright, so treat them as hard constraints rather than preferences:
- There is exactly one coordinator: EXACTLY ONE agent has kind "coordinator". Not zero, not two.
- Every agent name and department name is kebab-case: ^[a-z][a-z0-9-]*$. Names are unique
  across the whole proposal. The name "user" is reserved and must never be used.
- Every agent's department is one the proposal itself creates.
- capabilities and skills come ONLY from the catalogues given to you. Invented names are rejected.
- At most 3 departments and between 2 and 5 agents. Small orgs work; large ones stall.
- Every agent needs a title, charter, persona, and prompt, all non-empty.

HOW TO WRITE AN AGENT
charter: what it owns, in one or two sentences.
persona: how it talks. Give it an actual temperament, not "helpful and friendly".
prompt: instructions addressed to the agent as "you", covering how it should behave and what
it must not do. Write the prompt you would want if you were the one being asked to do this job.

Name agents like colleagues, not job titles: short, memorable, pronounceable.
Set firstJob to something concrete this specific person would genuinely ask for on day one.
`.trim();

/** Flat-ish object with a done flag rather than a oneOf: the codebase's other forced schemas
 *  (VERDICT_SCHEMA, TEST_REPORT_SCHEMA) are flat, and unions are the part of JSON Schema that
 *  model-side enforcement handles least reliably. The shape is checked in code after. */
export const INTERVIEW_SCHEMA = {
  type: "object",
  properties: {
    done: { type: "boolean", description: "true when the proposal is ready" },
    question: { type: "string", description: "the next question; omit when done" },
    proposal: {
      type: "object",
      properties: {
        departments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              department: { type: "string" },
              mission: { type: "string" },
              memoDomain: { type: "string" },
              lead: { type: "string" },
              capabilities: { type: "array", items: { type: "string" } },
              playbooks: { type: "array", items: { type: "string" } },
            },
            required: ["department", "mission", "memoDomain", "capabilities", "playbooks"],
            additionalProperties: false,
          },
        },
        agents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              department: { type: "string" },
              kind: { type: "string", enum: ["coordinator", "lead", "worker", "critic"] },
              title: { type: "string" },
              charter: { type: "string" },
              persona: { type: "string" },
              prompt: { type: "string" },
              capabilities: { type: "array", items: { type: "string" } },
              skills: { type: "array", items: { type: "string" } },
            },
            required: ["name", "department", "kind", "title", "charter", "persona", "prompt", "capabilities", "skills"],
            additionalProperties: false,
          },
        },
        firstJob: { type: "string" },
      },
      required: ["departments", "agents", "firstJob"],
      additionalProperties: false,
    },
  },
  required: ["done"],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

export function buildArchitectContext(input: {
  capabilities: Array<{ name: string; labels?: string[] }>;
  skills: Array<{ name: string; description: string }>;
  templates: OrgTemplate[];
}): string {
  const caps = productCapabilities(input.capabilities);
  const skills = input.skills.map((s) => `- ${s.name}: ${s.description}`).join("\n") || "- (none)";
  const examples = input.templates.map((t) => {
    const agents = t.agents
      .map((a) => `    ${a.name} (${a.kind}, ${t.departments.find((d) => d.department === a.department)?.department ?? a.department}) — ${a.title}; capabilities: ${a.capabilities.join(", ") || "none"}`)
      .join("\n");
    return `  ${t.name}: ${t.summary}\n${agents}`;
  }).join("\n\n");

  return [
    "CAPABILITIES YOU MAY USE (exact names, nothing else):",
    caps.join(", "),
    "",
    "SKILLS YOU MAY ATTACH (exact names, nothing else):",
    skills,
    "",
    "WORKED EXAMPLES — real orgs that provision cleanly. Match this shape, not this content:",
    examples,
  ].join("\n");
}

export function renderTranscript(turns: Turn[]): string {
  if (turns.length === 0) return "(the conversation has not started — greet them and ask your first question)";
  return turns.map((t) => (t.role === "user" ? `THEM: ${t.text}` : `YOU: ${t.text}`)).join("\n\n");
}
