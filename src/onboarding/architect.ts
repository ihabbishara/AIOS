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
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { OrgTemplate } from "./templates.js";
import { proposalShape, growthShape, type OrgProposal, type ProposalAgent } from "./proposal.js";
import { pingFailure } from "./auth.js";
import { DOMAINS } from "../memory/recall.js";

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

HOW YOU SPEAK
Every single reply you make is a StructuredOutput call. That tool is not only for the finished
org — it is the only channel you have, and plain text is never delivered to the person.
- Still gathering? Call it with done: false and your next question in "question".
- Ready? Call it with done: true and the proposal.
Do not explain, refuse, or greet in plain text. If you have nothing yet, that is precisely when
you call it with done: false and ask your first question.

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
- Every department's "playbooks" list is EMPTY. A brand-new org has no playbooks yet, and a
  department naming one that does not exist is rejected outright. Never invent one.
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
              // An ENUM, not free text. memoDomain names the memo file an agent loads
              // (`memos/<domain>.md`) and the distiller only ever writes the seven real domains,
              // so prose here — "research, articles, and drafts", observed live — points every
              // agent in that department at a file nothing writes: no department memory, ever,
              // and teachings to it stay undistilled forever.
              memoDomain: { type: "string", enum: [...DOMAINS] },
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

/** Injectable so tests never touch the network — same shape as auth.ts's `Ping`. */
export type Architect = (system: string, prompt: string) => Promise<unknown>;

/**
 * One stateless turn. No tools beyond StructuredOutput, no session, no filesystem.
 *
 * allowedTools MUST list "StructuredOutput": forced JSON arrives through that tool, and if it
 * is not allowed the SDK denies it and msg.structured_output comes back undefined with no error
 * anywhere (runner.ts:171 widens the allowlist for exactly this reason).
 */
export const sdkArchitect: Architect = async (system, prompt) => {
  const q = query({
    prompt,
    options: {
      systemPrompt: system,
      allowedTools: ["StructuredOutput"],
      // Headless: the setup server has no TTY, so a call that stops to ask about a tool never
      // answers and structured_output comes back undefined. Every other daemon-side query in
      // this repo (capture, entities, distiller) sets this for the same reason.
      permissionMode: "dontAsk",
      // No maxTurns. Forced JSON needs a turn to emit the StructuredOutput call and another to
      // finish, so maxTurns: 1 fails every call with error_max_turns (observed live). runner.ts
      // sets no maxTurns on its schema calls for the same reason. The only tool on the allowlist
      // is StructuredOutput, so there is nothing here for an unbounded run to wander into.
      settingSources: [],
      persistSession: false,
      outputFormat: { type: "json_schema" as const, schema: INTERVIEW_SCHEMA as Record<string, unknown> },
    },
  });
  for await (const msg of q) {
    if (msg.type === "result") {
      // Subtype first: it is what narrows msg to the variant that carries structured_output.
      if (msg.subtype !== "success") throw new Error(`architect call failed: ${msg.subtype}`);
      // A rejected call still arrives as subtype "success" with is_error set. pingFailure is
      // already that lie-detector — is_error AND api_error_status — so it is reused rather than
      // re-implemented; on a success subtype it returns the API's own message, unprefixed.
      const failure = pingFailure(msg);
      if (failure) throw new Error(failure);
      return msg.structured_output;
    }
  }
  throw new Error("architect call failed: no result from SDK");
};

export async function interviewTurn(
  turns: Turn[], context: string, ask: Architect,
): Promise<{ done: false; question: string } | { done: true; proposal: OrgProposal }> {
  const out = await ask(`${ARCHITECT_SYSTEM}\n\n${context}`, renderTranscript(turns));
  if (out === undefined || out === null || typeof out !== "object") {
    throw new Error("the Architect returned no structured output");
  }
  const r = out as { done?: unknown; question?: unknown; proposal?: unknown };
  if (r.done !== true) {
    if (typeof r.question !== "string" || !r.question.trim()) {
      throw new Error("the Architect returned no question and is not done");
    }
    return { done: false, question: r.question.trim() };
  }
  if (!r.proposal || typeof r.proposal !== "object") throw new Error("the Architect said done but sent no proposal");
  // Playbooks are normalised away, not validated: an interviewed org has none (templates ship
  // their own; an interview has nothing to name), and the model reliably fills the field with
  // prose that provision then rejects as `unknown playbook` — killing a finished interview at
  // the last step over a field the user never saw and cannot fix from the review screen.
  const p = r.proposal as { departments?: Array<Record<string, unknown>> };
  const proposal = {
    ...p,
    departments: (p.departments ?? []).map((d) => ({ ...d, playbooks: [] })),
  };
  // Deterministic validation downstream: creativity is allowed upstream of this line only.
  const shaped = proposalShape({ ...proposal, source: { kind: "interview" } });
  if (!shaped.ok) throw new Error(shaped.error);
  return { done: true, proposal: shaped.proposal };
}

export const GROWTH_SYSTEM = `
You design small AI organisations for a product called AIOS. This person ALREADY HAS one, and is
telling you what it cannot do yet. Your job is to draft the ADDITION — never a replacement.

HOW YOU SPEAK
Every single reply you make is a StructuredOutput call. That tool is not only for the finished
proposal — it is the only channel you have, and plain text is never delivered to the person.
- Still gathering? Call it with done: false and your next question in "question".
- Ready? Call it with done: true and the proposal.

HOW THE CONVERSATION GOES
Ask ONE question at a time about the work that is going unserved. Ask at most 4 questions, and
stop as soon as you know enough — this person already went through setup once and is here for a
specific gap. Never ask about departments, agent counts or capabilities: those are your job.

WHAT YOU RETURN
The proposal contains ONLY what is being added. Everything below is enforced by validators that
reject the whole thing, so treat them as hard constraints:
- NO COORDINATOR. The org already has one, and a second makes it fail to load. Every agent you
  return has kind "lead", "worker" or "critic".
- Never reuse a department name or an agent name the org already has. They are listed below.
- New agents may join an EXISTING department — that is usually the right answer. Only create a
  department when the work genuinely does not belong in any of them.
- "departments" may be empty. "agents" must not be: adding nothing is not an answer.
- Add at most 2 departments and at most 4 agents in one pass. They can always come back.
- capabilities and skills come ONLY from the catalogues given to you. Invented names are rejected.
- Every department's "playbooks" list is EMPTY. Never invent one.
- Every agent needs a title, charter, persona, and prompt, all non-empty.
- firstJob is ignored here — send an empty string.

HOW TO WRITE AN AGENT
charter: what it owns, in one or two sentences.
persona: how it talks. Give it an actual temperament, not "helpful and friendly".
prompt: instructions addressed to the agent as "you", covering how it should behave and what it
must not do. Say who it hands off to, using the real names of the colleagues listed below.

Name agents like colleagues, not job titles: short, memorable, pronounceable.
`.trim();

/** What the org already is, for the growth prompt. The roster is not decoration: the model is
 *  told to avoid these names, and to write hand-offs that address the real colleagues. */
export function renderExistingOrg(
  departments: Array<{ department: string; mission: string }>,
  agents: Array<{ name: string; kind: string; department: string; title: string }>,
): string {
  const depts = departments.map((d) => `- ${d.department}: ${d.mission}`).join("\n") || "- (none)";
  const roster = agents
    .map((a) => `- ${a.name} (${a.kind}, ${a.department}) — ${a.title}`)
    .join("\n") || "- (none)";
  return [
    "THE ORG AS IT STANDS. Do not recreate any of this; add to it.",
    "",
    "DEPARTMENTS (a new agent may join any of these):",
    depts,
    "",
    "AGENTS ALREADY HIRED (every one of these names is taken):",
    roster,
  ].join("\n");
}

/**
 * One stateless growth turn. Same contract as interviewTurn — and the same reason for existing
 * separately: the invariants invert once an org is on disk, so the shape gate is growthShape and
 * a coordinator is a rejection rather than a requirement.
 */
export async function growthTurn(
  turns: Turn[], context: string, ask: Architect,
  existing: { departments: Set<string>; agents: Set<string> },
): Promise<{ done: false; question: string } | { done: true; proposal: OrgProposal }> {
  const out = await ask(`${GROWTH_SYSTEM}\n\n${context}`, renderTranscript(turns));
  if (out === undefined || out === null || typeof out !== "object") {
    throw new Error("the Architect returned no structured output");
  }
  const r = out as { done?: unknown; question?: unknown; proposal?: unknown };
  if (r.done !== true) {
    if (typeof r.question !== "string" || !r.question.trim()) {
      throw new Error("the Architect returned no question and is not done");
    }
    return { done: false, question: r.question.trim() };
  }
  if (!r.proposal || typeof r.proposal !== "object") throw new Error("the Architect said done but sent no proposal");
  // Same normalisation as the interview, for the same reason: the model fills `playbooks` with
  // prose that provision then rejects as `unknown playbook`, killing a finished conversation at
  // the last step over a field the user never saw.
  const p = r.proposal as { departments?: Array<Record<string, unknown>> };
  const shaped = growthShape({
    ...p,
    departments: (p.departments ?? []).map((d) => ({ ...d, playbooks: [] })),
    source: { kind: "interview" },
  }, existing);
  if (!shaped.ok) throw new Error(shaped.error);
  return { done: true, proposal: shaped.proposal };
}

export const DEPARTMENT_DRAFT_SYSTEM = `
You design small AI organisations for a product called AIOS. This person already has one and
wants ONE new department in it. They have described what it is for in their own words. Turn that
description into the department and the agents that staff it.

HOW YOU ANSWER
One StructuredOutput call with done: true, on your first and only turn. NEVER ask a question —
there is nobody to answer it, and a reply with done: false is discarded. If the description is
thin, make the most reasonable department it could mean and keep it small.

WHAT YOU RETURN — all enforced by validators that reject the whole draft:
- EXACTLY ONE department, and it is not one the org already has.
- Between 1 and 3 agents, every one of them in that new department.
- NO COORDINATOR. The org has one; a second makes it fail to load.
- Never reuse an agent name the org already has. They are listed below.
- capabilities and skills come ONLY from the catalogues given to you. Invented names are rejected.
- The department's "playbooks" list is EMPTY. Never invent one.
- Every agent needs a title, charter, persona, and prompt, all non-empty.
- firstJob is ignored here — send an empty string.

WRITING THE DEPARTMENT
mission: one or two sentences saying what this department OWNS, in the person's own terms. Not a
restatement of their sentence — the version they would have written with more time.
memoDomain: which of the seven memory domains its work belongs to. Pick the closest honest fit;
"general" is correct more often than a forced match.
capabilities: the department-wide floor every agent in it inherits. Be sparing — an agent can add
its own, and a capability granted here is granted to everyone in the department forever.

WRITING AN AGENT
charter: what it owns, in one or two sentences.
persona: how it talks. Give it an actual temperament, not "helpful and friendly".
prompt: instructions addressed to the agent as "you", covering how it should behave and what it
must not do. Name the real colleagues it hands off to, from the roster below.

Name agents like colleagues, not job titles: short, memorable, pronounceable.
`.trim();

/**
 * One department, drafted from a sentence. This is the same machinery as growthTurn with the
 * conversation taken out: the person has already said what they want, and making them answer
 * four questions to get one department would be worse than the form it replaces.
 *
 * Returns a growth proposal, so the review screen and /api/org/grow/apply are unchanged.
 */
export async function draftDepartment(
  description: string, context: string, ask: Architect,
  existing: { departments: Set<string>; agents: Set<string> },
): Promise<OrgProposal> {
  const out = await ask(`${DEPARTMENT_DRAFT_SYSTEM}\n\n${context}`, `WHAT THEY WANT:\n${description.trim()}`);
  if (out === undefined || out === null || typeof out !== "object") {
    throw new Error("the Architect returned no structured output");
  }
  const r = out as { done?: unknown; proposal?: unknown };
  // A question here is a dead end — nothing is going to answer it — so it is a failure the user
  // can retry, not a conversation to start.
  if (r.done !== true || !r.proposal || typeof r.proposal !== "object") {
    throw new Error("the Architect did not draft a department — try describing it in a bit more detail");
  }
  const p = r.proposal as { departments?: Array<Record<string, unknown>> };
  const shaped = growthShape({
    ...p,
    departments: (p.departments ?? []).map((d) => ({ ...d, playbooks: [] })),
    source: { kind: "interview" },
  }, existing);
  if (!shaped.ok) throw new Error(shaped.error);
  // The one rule growthShape cannot express, because growth in general allows any number: this
  // endpoint exists to make ONE department, and the review screen is written to show one.
  if (shaped.proposal.departments.length !== 1) {
    throw new Error(`expected exactly one department, got ${shaped.proposal.departments.length}`);
  }
  return shaped.proposal;
}

const REDRAFT_NOTE = `
Redraft ONE agent in the org below, applying the note. Return done: true with the whole
proposal, changing only that agent's title, charter, persona, capabilities, and skills.
Keep every other agent exactly as it is.
`.trim();

/**
 * Identity is deliberately re-imposed rather than trusted: the agent's name anchors its
 * department's lead and any playbook role naming it, so a model that renames or moves it during
 * a redraft would silently break both.
 */
export async function redraftAgent(
  proposal: OrgProposal, name: string, note: string, context: string, ask: Architect,
): Promise<ProposalAgent> {
  const current = proposal.agents.find((a) => a.name === name);
  if (!current) throw new Error(`no agent "${name}" in the proposal`);
  const prompt = [
    REDRAFT_NOTE,
    `NOTE FROM THE USER: ${note}`,
    `AGENT TO REDRAFT: ${name}`,
    "CURRENT DRAFT:",
    JSON.stringify(proposal, null, 2),
  ].join("\n\n");
  const out = await ask(`${ARCHITECT_SYSTEM}\n\n${context}`, prompt);
  const r = (out ?? {}) as { proposal?: { agents?: ProposalAgent[] } };
  const drafted = r.proposal?.agents?.find((a) => a.name === name)
    ?? r.proposal?.agents?.[0];
  if (!drafted) throw new Error("the Architect returned no redrafted agent");
  return {
    ...drafted,
    name: current.name, department: current.department, kind: current.kind,
    capabilities: drafted.capabilities ?? current.capabilities,
    skills: drafted.skills ?? current.skills,
  };
}
