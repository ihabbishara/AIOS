# Org Architect Interview (plan 2b/4) Implementation Plan

> ## ⛔ THIS PLAN IS COMPLETE — DO NOT EXECUTE IT
>
> **All 8 tasks were implemented, verified, and merged to `main` (43182f3, PR #14) on 2026-07-31.**
> Re-running them would recreate files that already exist and re-apply landed changes.
>
> **The code below is also WRONG in four places.** The live smoke forced changes the plan could
> not anticipate, and the plan text was deliberately left as originally written rather than
> back-edited, so that the record shows what was planned versus what shipped. Read
> "Execution outcome" at the bottom before treating any snippet here as current. `src/onboarding/architect.ts`
> on `main` is the only authority.

**Goal:** A new user answers 4-6 questions in chat and gets a drafted org they can read, edit, and approve — instead of picking a preset.

**Architecture:** A built-in "Org Architect" — a hardcoded system prompt plus a direct SDK `query()`, never a registry agent, because no org exists yet to run one. It is **stateless per turn**: each turn replays the whole transcript in the prompt, so there is no session to resume and nothing to leak between users. It has no tools and no filesystem access; its only output is a forced-JSON `OrgProposal`, which lands in the same kv key the template gallery already writes and provisions through the same `provision()` from plan 2a. The review screen gains editing, and every edit is re-validated at provision time by the validators that are already there.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` specifiers), `@anthropic-ai/claude-agent-sdk` `query()` with `outputFormat: {type:"json_schema"}`, vitest, React 19 + Tailwind (ui2).

## Global Constraints

- **Subscription auth only.** The Architect runs on `CLAUDE_CODE_OAUTH_TOKEN`. Never introduce `ANTHROPIC_API_KEY`.
- **`allowedTools` MUST contain `"StructuredOutput"`.** Forced JSON arrives via that tool; if it is not in the allowlist the SDK denies it and `msg.structured_output` is silently `undefined` (runner.ts:171-175 widens the list for exactly this reason). `sdkPing` uses `allowedTools: []` — do not copy it verbatim.
- **The interview never writes to disk.** It produces a proposal object. All writes stay in `provision()`.
- **Every Architect output passes `proposalShape` before it is stored.** An LLM that emits two coordinators must be rejected at the seam, not at provision.
- **Imports use `.js` specifiers** even for `.ts` sources.
- **Tests are read via the "Tests" summary line**, never exit codes: `npx vitest run`. Baseline on `main` (82290af) is **209 files / 1673 passing**.
- **The Architect eval is never part of `npx vitest run`** — it is LLM-flaky by design and needs live auth. Same rule as `scripts/eval-capture.ts`.
- **Do not restart the live daemon** (port 4280). Smoke on `AIOS_UI_PORT=4291` with `AIOS_AGENTS_DIR` pointed at an empty dir.
- Client-specific capabilities (`halalo-aws`, anything with a `labels: [client.*]`) are excluded from what the Architect may propose.

## Why the Architect can authenticate at all

`verifyToken` sets `process.env.CLAUDE_CODE_OAUTH_TOKEN` and, on success, **deliberately leaves it set** (auth.ts:82-92 restores it only on failure). So after the auth step the running setup-mode process already carries the token, and the Architect's `query()` inherits it with no restart and no env plumbing. If that ever changes, the interview breaks with a 401 and this is the first place to look.

## File Structure

**New source**
- `src/onboarding/architect.ts` — `ARCHITECT_SYSTEM`, `INTERVIEW_SCHEMA`, `buildArchitectContext`, `renderTranscript`, `interviewTurn`, and the injectable `Architect` type with `sdkArchitect` as the production default. Mirrors `auth.ts`'s injectable-`Ping` shape so tests never touch the network.
- `scripts/eval-architect.ts` — on-demand eval over 5 fixture personas.
- `scripts/fixtures/architect-personas.json` — the personas and their rubric.

**Modified**
- `src/onboarding/server.ts` — `POST /api/onboarding/interview`, `PATCH /api/onboarding/proposal`, `POST /api/onboarding/redraft`; `SetupDeps` gains an injectable `architect`.
- `ui2/src/views/Setup.tsx` — the `interview` step becomes chat + an always-visible "Skip — pick a template instead"; `Review` gains inline editing and chips.
- `ui2/src/api.ts` — interview/patch/redraft methods.
- `src/web/skills-view.ts` — no change; `listSkills(root)` is already exported and is what feeds the Architect its skills context.

---

### Task 1: Interview schema, system prompt, and context assembly

All pure functions — no SDK, no network. This is the majority of the Architect's correctness and it is fully testable offline.

**Files:**
- Create: `src/onboarding/architect.ts`
- Test: `test/onboarding-architect.test.ts`

**Interfaces:**
- Consumes: `listSkills` from `src/web/skills-view.js`; `OrgTemplate` from `./templates.js`; `CapabilityDef` from the registry.
- Produces:
  - `ARCHITECT_SYSTEM: string`
  - `INTERVIEW_SCHEMA: Record<string, unknown>`
  - `buildArchitectContext(input: { capabilities: Array<{ name: string; labels?: string[] }>; skills: Array<{ name: string; description: string }>; templates: OrgTemplate[] }): string`
  - `renderTranscript(turns: Turn[]): string` where `type Turn = { role: "user" | "architect"; text: string }`
  - `productCapabilities(all: Array<{ name: string; labels?: string[] }>): string[]`

- [ ] **Step 1: Write the failing test**

```ts
// test/onboarding-architect.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onboarding-architect.test.ts`
Expected: FAIL — `Failed to resolve import "../src/onboarding/architect.js"`

- [ ] **Step 3: Write the implementation**

```ts
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
- EXACTLY ONE agent has kind "coordinator". Not zero, not two.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/onboarding-architect.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/architect.ts test/onboarding-architect.test.ts
git commit -m "feat(onboarding): Org Architect prompt, schema, and context

Every hard rule in the system prompt mirrors a validator that would
reject the proposal at provision — stating them up front is what keeps
drafts provisionable. Client-scoped capabilities are filtered out: they
are one user's integration and would fail on any other install."
```

---

### Task 2: The SDK call and `interviewTurn`

**Files:**
- Modify: `src/onboarding/architect.ts`
- Test: `test/onboarding-architect.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's exports; `proposalShape` from `./proposal.js`.
- Produces:
  - `type Architect = (system: string, prompt: string) => Promise<unknown>` — returns the raw `structured_output`. Injectable exactly like `Ping`.
  - `sdkArchitect: Architect`
  - `interviewTurn(turns: Turn[], context: string, ask: Architect): Promise<{ done: false; question: string } | { done: true; proposal: OrgProposal }>`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onboarding-architect.test.ts`
Expected: FAIL — `interviewTurn is not a function`

- [ ] **Step 3: Write the implementation**

Append to `src/onboarding/architect.ts`:

```ts
import { proposalShape, type OrgProposal } from "./proposal.js";

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
      maxTurns: 1,
      settingSources: [],
      persistSession: false,
      outputFormat: { type: "json_schema" as const, schema: INTERVIEW_SCHEMA as Record<string, unknown> },
    },
  });
  for await (const msg of q) {
    if (msg.type === "result") {
      // A rejected token arrives as subtype "success" with is_error set — the same lie
      // pingFailure exists to catch. Surface it rather than reading structured_output.
      if (msg.subtype !== "success" || msg.is_error) {
        throw new Error(msg.subtype === "success" && "result" in msg && msg.result
          ? String(msg.result).trim()
          : `architect call failed: ${msg.subtype}`);
      }
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
  // Deterministic validation downstream: creativity is allowed upstream of this line only.
  const shaped = proposalShape({ ...(r.proposal as object), source: { kind: "interview" } });
  if (!shaped.ok) throw new Error(shaped.error);
  return { done: true, proposal: shaped.proposal };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/onboarding-architect.test.ts`
Expected: PASS (18 tests)

- [ ] **Step 5: Verify tsc and commit**

Run: `npx tsc --noEmit`
Expected: no output

```bash
git add src/onboarding/architect.ts test/onboarding-architect.test.ts
git commit -m "feat(onboarding): Architect SDK call and one stateless turn

allowedTools must list StructuredOutput or forced JSON comes back
undefined with no error anywhere. Every finished proposal goes through
proposalShape before it can leave this function: LLM creativity upstream,
deterministic validation downstream."
```

---

### Task 3: Interview endpoints

The transcript lives in kv beside the proposal, so a reload mid-interview resumes where it was — failure mode 4 in the spec's table.

**Files:**
- Modify: `src/onboarding/server.ts`
- Test: `test/onboarding-server.test.ts` (append)

**Interfaces:**
- Consumes: `interviewTurn`, `buildArchitectContext`, `sdkArchitect`; `listSkills` from `../web/skills-view.js`; `loadCapabilities` from the registry; `listTemplates`/`loadTemplate`.
- Produces on `SetupDeps`: `architect?: Architect`.
- Endpoints:
  - `GET /api/onboarding/interview` → `{ turns: Turn[] }`
  - `POST /api/onboarding/interview` `{ message }` → `{ done: false, question }` or `{ done: true, step: "review" }`
  - `POST /api/onboarding/interview/restart` → clears the transcript, stays on `interview`

- [ ] **Step 1: Write the failing tests**

Append to `test/onboarding-server.test.ts` (the `boot(ping, over, step)` helper from plan 2a already forwards `over` into `SetupDeps`):

```ts
describe("the interview", () => {
  const proposal = {
    departments: [{ department: "operations", mission: "Front door.", memoDomain: "general", lead: "nova", capabilities: [], playbooks: [] }],
    agents: [{
      name: "nova", department: "operations", kind: "coordinator", title: "Coordinator",
      charter: "Route.", persona: "Brief.", prompt: "You route.", capabilities: [], skills: [],
    }],
    firstJob: "Say hello.",
  };

  it("asks a question and keeps the wizard on the interview step", async () => {
    const { base, store } = await boot(noop, {
      architect: async () => ({ done: false, question: "What do you do?" }),
    }, "interview");
    const r = await postJson(base, "/api/onboarding/interview", { message: "I run a bakery" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ done: false, question: "What do you do?" });
    expect(store.kvGet("onboarding.step")).toBe("interview");
  });

  it("replays the whole transcript on the next turn", async () => {
    const prompts: string[] = [];
    const { base } = await boot(noop, {
      architect: async (_s, p) => { prompts.push(p); return { done: false, question: "and then?" }; },
    }, "interview");
    await postJson(base, "/api/onboarding/interview", { message: "first thing" });
    await postJson(base, "/api/onboarding/interview", { message: "second thing" });
    expect(prompts[1]).toContain("first thing");
    expect(prompts[1]).toContain("and then?");
    expect(prompts[1]).toContain("second thing");
  });

  it("stores the proposal and advances to review when the Architect is done", async () => {
    const { base, store } = await boot(noop, {
      architect: async () => ({ done: true, proposal }),
    }, "interview");
    const r = await postJson(base, "/api/onboarding/interview", { message: "that's everything" });
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("review");
    expect(store.kvGet("onboarding.proposal")).toContain("nova");
    expect(store.kvGet("onboarding.proposal")).toContain("interview");
  });

  it("serves the transcript back so a reload resumes mid-interview", async () => {
    const { base } = await boot(noop, {
      architect: async () => ({ done: false, question: "What do you do?" }),
    }, "interview");
    await postJson(base, "/api/onboarding/interview", { message: "I run a bakery" });
    const r = await fetch(`${base}/api/onboarding/interview`);
    const body = (await r.json()) as { turns: Array<{ role: string; text: string }> };
    expect(body.turns.map((t) => t.role)).toEqual(["user", "architect"]);
    expect(body.turns[0].text).toBe("I run a bakery");
  });

  it("surfaces an Architect failure as 400 without advancing", async () => {
    const { base, store } = await boot(noop, {
      architect: async () => { throw new Error("api_error_status 401"); },
    }, "interview");
    const r = await postJson(base, "/api/onboarding/interview", { message: "hi" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("401");
    expect(store.kvGet("onboarding.step")).toBe("interview");
  });

  it("rejects a proposal that fails the structural gate, and stays put", async () => {
    const twoCoordinators = { ...proposal, agents: [proposal.agents[0], { ...proposal.agents[0], name: "nova2" }] };
    const { base, store } = await boot(noop, {
      architect: async () => ({ done: true, proposal: twoCoordinators }),
    }, "interview");
    const r = await postJson(base, "/api/onboarding/interview", { message: "go" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("exactly one coordinator");
    expect(store.kvGet("onboarding.step")).toBe("interview");
    expect(store.kvGet("onboarding.proposal")).toBeUndefined();
  });

  it("refuses an empty message", async () => {
    const { base } = await boot(noop, { architect: async () => ({ done: false, question: "?" }) }, "interview");
    const r = await postJson(base, "/api/onboarding/interview", { message: "   " });
    expect(r.status).toBe(400);
  });

  it("refuses interview turns from the wrong step", async () => {
    const { base } = await boot(noop, { architect: async () => ({ done: false, question: "?" }) }, "welcome");
    expect((await postJson(base, "/api/onboarding/interview", { message: "hi" })).status).toBe(400);
  });

  it("restart clears the transcript", async () => {
    const { base, store } = await boot(noop, {
      architect: async () => ({ done: false, question: "q" }),
    }, "interview");
    await postJson(base, "/api/onboarding/interview", { message: "hi" });
    expect(store.kvGet("onboarding.transcript")).toContain("hi");
    const r = await postJson(base, "/api/onboarding/interview/restart", {});
    expect(r.status).toBe(200);
    expect(JSON.parse(store.kvGet("onboarding.transcript") ?? "[]")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onboarding-server.test.ts`
Expected: FAIL — the interview endpoints 404

- [ ] **Step 3: Add the endpoints**

In `src/onboarding/server.ts`, extend the imports and `SetupDeps`:

```ts
import { buildArchitectContext, interviewTurn, sdkArchitect, type Architect, type Turn } from "./architect.js";
import { listSkills, skillsPluginRoot } from "../web/skills-view.js";
import { loadCapabilities } from "../agents/registry/capabilities.js";
```

```ts
  /** Injected in tests so the interview never touches the network. */
  architect?: Architect;
```

Inside `startSetupServer`, beside the other constants:

```ts
  const TRANSCRIPT_KEY = "onboarding.transcript";
  const ask = deps.architect ?? sdkArchitect;
  const transcript = (): Turn[] => JSON.parse(deps.store.kvGet(TRANSCRIPT_KEY) ?? "[]") as Turn[];

  /** Rebuilt per turn: the catalogues are files on disk and the user may be editing them. */
  const architectContext = (): string => buildArchitectContext({
    capabilities: [...loadCapabilities(join(deps.agentsDir, "_capabilities.yaml"))]
      .map(([name, def]) => ({ name, labels: def.labels })),
    skills: listSkills(skillsPluginRoot()),
    templates: listTemplates(deps.templatesDir, log)
      .map((t) => loadTemplate(deps.templatesDir, t.name)!)
      .filter(Boolean),
  });
```

Add the routes beside the other onboarding endpoints:

```ts
        if (path === "/api/onboarding/interview" && req.method === "GET") {
          return json(res, 200, { turns: transcript() });
        }

        if (path === "/api/onboarding/interview/restart" && req.method === "POST") {
          if (wizard.current() !== "interview") {
            return json(res, 400, { error: `the interview runs at the interview step, not ${wizard.current()}` });
          }
          deps.store.kvSet(TRANSCRIPT_KEY, "[]");
          return json(res, 200, { turns: [] });
        }

        if (path === "/api/onboarding/interview" && req.method === "POST") {
          if (wizard.current() !== "interview") {
            return json(res, 400, { error: `the interview runs at the interview step, not ${wizard.current()}` });
          }
          const body = await readJson<{ message?: unknown }>(req);
          if (!body) return json(res, 400, { error: "body must be JSON" });
          const message = typeof body.message === "string" ? body.message.trim() : "";
          if (!message) return json(res, 400, { error: "message required" });

          const turns: Turn[] = [...transcript(), { role: "user", text: message }];
          let turn;
          try {
            turn = await interviewTurn(turns, architectContext(), ask);
          } catch (err) {
            // The user's message is NOT committed on failure: replaying a transcript whose last
            // turn got no answer would ask the model to respond to it twice.
            log(`interview turn failed: ${(err as Error).message}`);
            return json(res, 400, { error: (err as Error).message });
          }
          if (!turn.done) {
            deps.store.kvSet(TRANSCRIPT_KEY, JSON.stringify([...turns, { role: "architect", text: turn.question }]));
            return json(res, 200, { done: false, question: turn.question });
          }
          deps.store.kvSet(TRANSCRIPT_KEY, JSON.stringify(turns));
          deps.store.kvSet(PROPOSAL_KEY, JSON.stringify(turn.proposal));
          return transition(res, path, () => wizard.advance("interview"));
        }
```

The `done` branch returns `{ step: "review" }` through the shared `transition` helper, which is what the test asserts.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/onboarding-server.test.ts`
Expected: PASS — 21 pre-existing plus 9 new

- [ ] **Step 5: Full suite, tsc, commit**

Run: `npx vitest run && npx tsc --noEmit`
Expected: no pre-existing failures, no tsc output

```bash
git add src/onboarding/server.ts test/onboarding-server.test.ts
git commit -m "feat(onboarding): interview endpoints

The transcript lives in kv beside the proposal, so a reload mid-interview
resumes where it left off. A failed turn does not commit the user's
message — replaying a transcript whose last turn got no answer would ask
the model to respond to it twice."
```

---

### Task 4: Editing the proposal

The review screen is the trust gate, and a gate you cannot adjust is a gate you either accept whole or abandon. Editing is a `PATCH` against the stored proposal; nothing is validated here beyond shape, because `provision()` already re-validates everything on approve.

**Files:**
- Modify: `src/onboarding/server.ts`
- Test: `test/onboarding-server.test.ts` (append)

**Interfaces:**
- Produces: `PATCH /api/onboarding/proposal` with body `{ agent: string, field: "title"|"charter"|"persona"|"prompt", value: string }` or `{ agent: string, capabilities: string[] }` or `{ agent: string, skills: string[] }` or `{ firstJob: string }` → `{ proposal }`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("editing the proposal", () => {
  async function atReview(over = {}) {
    const b = await boot(noop, over, "interview");
    await postJson(b.base, "/api/onboarding/template", { name: "starter" });
    return b;
  }

  it("edits a prose field on one agent", async () => {
    const { base } = await atReview();
    const r = await fetch(`${base}/api/onboarding/proposal`, {
      method: "PATCH", body: JSON.stringify({ agent: "nova", field: "charter", value: "Rewritten charter." }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { proposal: { agents: Array<{ name: string; charter: string }> } };
    expect(body.proposal.agents.find((a) => a.name === "nova")!.charter).toBe("Rewritten charter.");
  });

  it("persists the edit for the next read", async () => {
    const { base } = await atReview();
    await fetch(`${base}/api/onboarding/proposal`, {
      method: "PATCH", body: JSON.stringify({ agent: "nova", field: "title", value: "Chief of Staff" }),
    });
    const r = await fetch(`${base}/api/onboarding/proposal`);
    const body = (await r.json()) as { proposal: { agents: Array<{ name: string; title: string }> } };
    expect(body.proposal.agents.find((a) => a.name === "nova")!.title).toBe("Chief of Staff");
  });

  it("replaces capability and skill chips", async () => {
    const { base } = await atReview();
    await fetch(`${base}/api/onboarding/proposal`, {
      method: "PATCH", body: JSON.stringify({ agent: "scout", capabilities: ["web"] }),
    });
    const r = await fetch(`${base}/api/onboarding/proposal`);
    const body = (await r.json()) as { proposal: { agents: Array<{ name: string; capabilities: string[] }> } };
    expect(body.proposal.agents.find((a) => a.name === "scout")!.capabilities).toEqual(["web"]);
  });

  it("edits firstJob", async () => {
    const { base } = await atReview();
    const r = await fetch(`${base}/api/onboarding/proposal`, {
      method: "PATCH", body: JSON.stringify({ firstJob: "Do the thing." }),
    });
    expect(((await r.json()) as { proposal: { firstJob: string } }).proposal.firstJob).toBe("Do the thing.");
  });

  it("refuses an unknown agent", async () => {
    const { base } = await atReview();
    const r = await fetch(`${base}/api/onboarding/proposal`, {
      method: "PATCH", body: JSON.stringify({ agent: "ghost", field: "title", value: "x" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("ghost");
  });

  it("refuses a field that is not editable", async () => {
    const { base } = await atReview();
    // Renaming an agent here would orphan the department lead and any playbook role naming it.
    const r = await fetch(`${base}/api/onboarding/proposal`, {
      method: "PATCH", body: JSON.stringify({ agent: "nova", field: "name", value: "hacked" }),
    });
    expect(r.status).toBe(400);
  });

  it("refuses an empty prose value", async () => {
    const { base } = await atReview();
    const r = await fetch(`${base}/api/onboarding/proposal`, {
      method: "PATCH", body: JSON.stringify({ agent: "nova", field: "charter", value: "  " }),
    });
    expect(r.status).toBe(400);
  });

  it("404s when there is no proposal to edit", async () => {
    const { base } = await boot(noop, {}, "interview");
    const r = await fetch(`${base}/api/onboarding/proposal`, {
      method: "PATCH", body: JSON.stringify({ firstJob: "x" }),
    });
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onboarding-server.test.ts`
Expected: FAIL — PATCH falls through to the `/api/` 404

- [ ] **Step 3: Add the route**

```ts
        if (path === "/api/onboarding/proposal" && req.method === "PATCH") {
          const raw = deps.store.kvGet(PROPOSAL_KEY);
          if (!raw) return json(res, 404, { error: "no proposal yet" });
          const body = await readJson<Record<string, unknown>>(req);
          if (!body) return json(res, 400, { error: "body must be JSON" });
          const proposal = JSON.parse(raw) as OrgProposal;

          if (typeof body.firstJob === "string") {
            if (!body.firstJob.trim()) return json(res, 400, { error: "firstJob required" });
            proposal.firstJob = body.firstJob.trim();
            deps.store.kvSet(PROPOSAL_KEY, JSON.stringify(proposal));
            return json(res, 200, { proposal });
          }

          const agent = proposal.agents.find((a) => a.name === body.agent);
          if (!agent) return json(res, 400, { error: `no agent "${String(body.agent)}" in the proposal` });

          // name and department are deliberately NOT editable: a rename here would orphan the
          // department lead and any playbook role naming this agent, which the user cannot see
          // from this screen. Picking a different template is the way to change structure.
          const PROSE = ["title", "charter", "persona", "prompt"] as const;
          if (typeof body.field === "string") {
            if (!(PROSE as readonly string[]).includes(body.field)) {
              return json(res, 400, { error: `field must be one of ${PROSE.join(", ")}` });
            }
            if (typeof body.value !== "string" || !body.value.trim()) {
              return json(res, 400, { error: `${body.field} required` });
            }
            agent[body.field as (typeof PROSE)[number]] = body.value.trim();
          } else if (Array.isArray(body.capabilities)) {
            if (body.capabilities.some((c) => typeof c !== "string")) {
              return json(res, 400, { error: "capabilities must be strings" });
            }
            agent.capabilities = body.capabilities as string[];
          } else if (Array.isArray(body.skills)) {
            if (body.skills.some((s) => typeof s !== "string")) {
              return json(res, 400, { error: "skills must be strings" });
            }
            agent.skills = body.skills as string[];
          } else {
            return json(res, 400, { error: "nothing to patch" });
          }
          // Unknown capability names are NOT rejected here — provision() re-validates every
          // field and reports them as card errors on this same screen.
          deps.store.kvSet(PROPOSAL_KEY, JSON.stringify(proposal));
          return json(res, 200, { proposal });
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/onboarding-server.test.ts`
Expected: PASS — 8 new

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/server.ts test/onboarding-server.test.ts
git commit -m "feat(onboarding): edit the proposal before approving it

A trust gate you cannot adjust is one you accept whole or abandon. Name
and department stay locked: renaming here would orphan the department
lead and any playbook role naming the agent, which is invisible from
this screen. Unknown capabilities are left to provision(), which already
reports them as card errors."
```

---

### Task 5: Redraft one agent

**Files:**
- Modify: `src/onboarding/architect.ts`, `src/onboarding/server.ts`
- Test: `test/onboarding-architect.test.ts`, `test/onboarding-server.test.ts`

**Interfaces:**
- Produces:
  - `redraftAgent(proposal: OrgProposal, name: string, note: string, context: string, ask: Architect): Promise<ProposalAgent>`
  - `POST /api/onboarding/redraft` `{ agent, note }` → `{ proposal }`
  - `POST /api/onboarding/regenerate` → `{ proposal }` — spec §4's Regenerate: re-runs the **last** interview turn against the same answers for a different whole draft. Distinct from redraft (one agent) and from restart (throws the answers away).

- [ ] **Step 1: Write the failing tests**

In `test/onboarding-architect.test.ts`:

```ts
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
```

In `test/onboarding-server.test.ts`:

```ts
describe("redraft endpoint", () => {
  it("replaces one agent in the stored proposal", async () => {
    const { base } = await boot(noop, {
      architect: async () => ({
        done: true,
        proposal: {
          departments: [{ department: "operations", mission: "m", memoDomain: "general", capabilities: [], playbooks: [] }],
          agents: [{
            name: "nova", department: "operations", kind: "coordinator", title: "Coordinator",
            charter: "c", persona: "Warm and unhurried.", prompt: "p", capabilities: [], skills: [],
          }],
          firstJob: "f",
        },
      }),
    }, "interview");
    await postJson(base, "/api/onboarding/template", { name: "starter" });
    const r = await postJson(base, "/api/onboarding/redraft", { agent: "nova", note: "warmer" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { proposal: { agents: Array<{ name: string; persona: string }> } };
    expect(body.proposal.agents.find((a) => a.name === "nova")!.persona).toBe("Warm and unhurried.");
    // The other agents are untouched.
    expect(body.proposal.agents).toHaveLength(3);
  });

  it("surfaces a redraft failure as 400 leaving the proposal alone", async () => {
    const { base } = await boot(noop, { architect: async () => { throw new Error("model unavailable"); } }, "interview");
    await postJson(base, "/api/onboarding/template", { name: "starter" });
    const r = await postJson(base, "/api/onboarding/redraft", { agent: "nova", note: "warmer" });
    expect(r.status).toBe(400);
    const after = await (await fetch(`${base}/api/onboarding/proposal`)).json() as { proposal: { agents: unknown[] } };
    expect(after.proposal.agents).toHaveLength(3);
  });
});

describe("regenerate", () => {
  const drafted = (persona: string) => ({
    done: true,
    proposal: {
      departments: [{ department: "operations", mission: "m", memoDomain: "general", capabilities: [], playbooks: [] }],
      agents: [{
        name: "nova", department: "operations", kind: "coordinator", title: "Coordinator",
        charter: "c", persona, prompt: "p", capabilities: [], skills: [],
      }],
      firstJob: "f",
    },
  });

  it("re-runs the last turn against the same answers and replaces the proposal", async () => {
    let call = 0;
    const { base } = await boot(noop, {
      architect: async () => drafted(++call === 1 ? "First draft." : "Second draft."),
    }, "interview");
    await postJson(base, "/api/onboarding/interview", { message: "that's everything" });
    const r = await postJson(base, "/api/onboarding/regenerate", {});
    expect(r.status).toBe(200);
    const body = (await r.json()) as { proposal: { agents: Array<{ persona: string }> } };
    expect(body.proposal.agents[0].persona).toBe("Second draft.");
  });

  it("keeps the user's answers — that is what separates it from restart", async () => {
    const prompts: string[] = [];
    const { base, store } = await boot(noop, {
      architect: async (_s, p) => { prompts.push(p); return drafted("x"); },
    }, "interview");
    await postJson(base, "/api/onboarding/interview", { message: "I run a bakery" });
    await postJson(base, "/api/onboarding/regenerate", {});
    expect(prompts[1]).toContain("I run a bakery");
    expect(store.kvGet("onboarding.transcript")).toContain("I run a bakery");
  });

  it("400s with no transcript to re-run", async () => {
    const { base } = await boot(noop, { architect: async () => drafted("x") }, "review");
    expect((await postJson(base, "/api/onboarding/regenerate", {})).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/onboarding-architect.test.ts test/onboarding-server.test.ts`
Expected: FAIL — `redraftAgent is not a function`, redraft route 404

- [ ] **Step 3: Implement**

Append to `src/onboarding/architect.ts`:

```ts
import type { ProposalAgent } from "./proposal.js";

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
```

Add the route to `src/onboarding/server.ts`:

```ts
        if (path === "/api/onboarding/redraft" && req.method === "POST") {
          const raw = deps.store.kvGet(PROPOSAL_KEY);
          if (!raw) return json(res, 404, { error: "no proposal yet" });
          const body = await readJson<{ agent?: unknown; note?: unknown }>(req);
          if (!body) return json(res, 400, { error: "body must be JSON" });
          const name = typeof body.agent === "string" ? body.agent : "";
          const note = typeof body.note === "string" ? body.note.trim() : "";
          if (!name) return json(res, 400, { error: "agent required" });
          const proposal = JSON.parse(raw) as OrgProposal;
          let drafted;
          try {
            drafted = await redraftAgent(proposal, name, note || "improve this agent", architectContext(), ask);
          } catch (err) {
            log(`redraft failed: ${(err as Error).message}`);
            return json(res, 400, { error: (err as Error).message });
          }
          proposal.agents = proposal.agents.map((a) => (a.name === name ? drafted : a));
          deps.store.kvSet(PROPOSAL_KEY, JSON.stringify(proposal));
          return json(res, 200, { proposal });
        }
```

Import `redraftAgent` alongside the other architect imports.

Add the regenerate route beside it. It is the spec's Regenerate: same answers, fresh draft —
which is why it replays the stored transcript rather than clearing it like restart does:

```ts
        if (path === "/api/onboarding/regenerate" && req.method === "POST") {
          const turns = transcript();
          if (turns.length === 0) return json(res, 400, { error: "no interview to regenerate from" });
          let turn;
          try {
            turn = await interviewTurn(turns, architectContext(), ask);
          } catch (err) {
            log(`regenerate failed: ${(err as Error).message}`);
            return json(res, 400, { error: (err as Error).message });
          }
          // The Architect already had every answer once, so a question here means it changed its
          // mind about being finished — the user is on the review screen and has nowhere to put
          // a question, so treat it as a failed regenerate rather than reopening the interview.
          if (!turn.done) return json(res, 400, { error: "the Architect asked another question instead of redrafting" });
          deps.store.kvSet(PROPOSAL_KEY, JSON.stringify(turn.proposal));
          return json(res, 200, { proposal: turn.proposal });
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/onboarding-architect.test.ts test/onboarding-server.test.ts`
Expected: PASS

- [ ] **Step 5: Full suite, tsc, commit**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/onboarding/architect.ts src/onboarding/server.ts test/onboarding-architect.test.ts test/onboarding-server.test.ts
git commit -m "feat(onboarding): redraft one agent from a note

Identity is re-imposed rather than trusted: the agent's name anchors its
department lead and any playbook role naming it, so a model that renamed
or moved it mid-redraft would silently break both."
```

---

### Task 6: Interview chat UI

**Files:**
- Modify: `ui2/src/api.ts`, `ui2/src/views/Setup.tsx`

**Interfaces:**
- Produces: `api.interviewTurns()`, `api.interviewSay(message)`, `api.interviewRestart()`.
- The `interview` step renders `<Interview>` with the template gallery reachable at all times.

- [ ] **Step 1: Add the API methods**

In `ui2/src/api.ts`, beside the other onboarding methods:

```ts
  interviewTurns: () =>
    request<{ turns: Array<{ role: "user" | "architect"; text: string }> }>("/api/onboarding/interview"),
  interviewSay: (message: string) =>
    request<{ done?: boolean; question?: string; step?: string }>("/api/onboarding/interview", {
      method: "POST", body: JSON.stringify({ message }),
    }),
  interviewRestart: () =>
    request<{ turns: [] }>("/api/onboarding/interview/restart", { method: "POST", body: JSON.stringify({}) }),
```

- [ ] **Step 2: Replace the `interview` step with the chat**

In `ui2/src/views/Setup.tsx`, change the interview branch:

```tsx
      {step === "interview" && <Interview onNext={onStepChange} />}
```

and add the component. `Gallery` from plan 2a is reused as the escape hatch — the spec requires it visible at all times, so it renders below the chat rather than behind a route:

```tsx
function Interview({ onNext }: { onNext: (s: string) => void }) {
  const [turns, setTurns] = useState<Array<{ role: "user" | "architect"; text: string }>>([]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showGallery, setShowGallery] = useState(false);

  useEffect(() => {
    api.interviewTurns()
      .then((r) => {
        setTurns(r.turns);
        // Nothing said yet: prime the first question so the user is not staring at a blank box.
        if (r.turns.length === 0) void send("Hello — I'd like to set up my org.", true);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function send(message: string, silent = false) {
    setBusy(true); setError("");
    if (!silent) setTurns((t) => [...t, { role: "user", text: message }]);
    try {
      const r = await api.interviewSay(message);
      if (r.step) return onNext(r.step); // the Architect finished — proposal is stored
      const q = r.question ?? "";
      setTurns((t) => (silent ? [{ role: "architect", text: q }] : [...t, { role: "architect", text: q }]));
    } catch (err) {
      setError((err as Error).message);
      // The server did not commit the failed turn, so drop the optimistic echo too.
      if (!silent) setTurns((t) => t.slice(0, -1));
    } finally {
      setBusy(false);
      setValue("");
    }
  }

  return (
    <div className="panel w-full max-w-2xl p-6 flex flex-col gap-4">
      <div className="text-strong text-[15px]">Tell me about your work</div>
      <p className="leading-relaxed">
        A few questions, then I'll draft an org for you. Nothing is created until you approve it.
      </p>

      <div className="flex flex-col gap-3 max-h-[46vh] overflow-y-auto">
        {turns.map((t, i) => (
          <div key={i} className={t.role === "user" ? "self-end max-w-[80%]" : "max-w-[85%]"}>
            <div className={`rounded-md px-3 py-2 leading-relaxed ${
              t.role === "user" ? "bg-bg border border-line" : "text-fg"}`}>
              {t.text}
            </div>
          </div>
        ))}
        {busy && <div className="text-dim text-[12px]">thinking…</div>}
      </div>

      {error && <div className="text-[12px] text-err">{error}</div>}

      <div className="flex items-center gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && value.trim() && void send(value.trim())}
          placeholder="Type your answer"
          className="flex-1 bg-bg border border-line rounded-md px-3 py-2 text-fg outline-none focus:border-dim"
        />
        <Button variant="primary" disabled={busy || !value.trim()} onClick={() => void send(value.trim())}>
          Send
        </Button>
      </div>

      <div className="flex items-center gap-3 text-[11px]">
        <button onClick={() => { void api.interviewRestart().then(() => setTurns([])); }}
          className="text-dim hover:text-fg underline underline-offset-2">Start over</button>
        <button onClick={() => setShowGallery((v) => !v)}
          className="text-dim hover:text-fg underline underline-offset-2 ml-auto">
          {showGallery ? "Back to the interview" : "Skip — pick a template instead"}
        </button>
      </div>

      {showGallery && <Gallery onNext={onNext} />}
    </div>
  );
}
```

- [ ] **Step 3: Build**

Run: `cd ui2 && npm run build`
Expected: `✓ built` with no TypeScript errors

- [ ] **Step 4: Commit**

```bash
git add ui2/src/api.ts ui2/src/views/Setup.tsx
git commit -m "feat(ui2): interview chat with the template gallery always reachable

The gallery stays one click away at every point in the interview — the
spec's escape hatch for an interview that stalls or drafts something
strange. A failed turn rolls back its optimistic echo, because the server
does not commit a message the Architect never answered."
```

---

### Task 7: Review screen editing

**Files:**
- Modify: `ui2/src/api.ts`, `ui2/src/views/Setup.tsx`

**Interfaces:**
- Produces: `api.patchProposal(patch)`, `api.redraftAgent(agent, note)`; `Review` gains editable fields, chips, and a redraft control.

- [ ] **Step 1: Add the API methods**

```ts
  patchProposal: (patch: Record<string, unknown>) =>
    request<{ proposal: OrgProposalView }>("/api/onboarding/proposal", {
      method: "PATCH", body: JSON.stringify(patch),
    }),
  redraftAgent: (agent: string, note: string) =>
    request<{ proposal: OrgProposalView }>("/api/onboarding/redraft", {
      method: "POST", body: JSON.stringify({ agent, note }),
    }),
  capabilityCatalog: () => request<{ capabilities: string[]; skills: string[] }>("/api/onboarding/catalog"),
```

Add the catalog route to `src/onboarding/server.ts` so the chips can only offer valid names:

```ts
        if (path === "/api/onboarding/catalog" && req.method === "GET") {
          return json(res, 200, {
            capabilities: productCapabilities([...loadCapabilities(join(deps.agentsDir, "_capabilities.yaml"))]
              .map(([name, def]) => ({ name, labels: def.labels }))),
            skills: listSkills(skillsPluginRoot()).map((s) => s.name),
          });
        }
```

- [ ] **Step 2: Make the review fields editable**

Replace the read-only detail block inside `Review`'s `<details>` with editable fields. Each field saves on blur — no save button, because a review screen with an unsaved-changes trap is worse than one that just keeps up:

```tsx
function EditableField({
  label, value, onSave,
}: { label: string; value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]); // a redraft replaces this from the server
  return (
    <label className="flex flex-col gap-1">
      <span className="text-dim text-[11px] uppercase tracking-[0.12em]">{label}</span>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() && draft !== value && onSave(draft.trim())}
        rows={Math.min(6, Math.max(2, Math.ceil(draft.length / 70)))}
        className="w-full bg-bg border border-line rounded-md px-2 py-1.5 text-fg text-[12px] leading-relaxed outline-none focus:border-dim resize-y"
      />
    </label>
  );
}

function Chips({
  label, all, selected, onChange,
}: { label: string; all: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-dim text-[11px] uppercase tracking-[0.12em]">{label}</span>
      <div className="flex flex-wrap gap-1">
        {all.map((name) => {
          const on = selected.includes(name);
          return (
            <button key={name}
              onClick={() => onChange(on ? selected.filter((s) => s !== name) : [...selected, name])}
              className={`text-[11px] rounded-full px-2 py-0.5 border ${
                on ? "border-dim text-strong" : "border-line text-dim hover:text-fg"}`}>
              {name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

Wire them inside `Review`, replacing the four read-only `<div>`s:

```tsx
              <div className="text-[12px] leading-relaxed flex flex-col gap-2 mt-2">
                <EditableField label="Title" value={a.title}
                  onSave={(v) => patch({ agent: a.name, field: "title", value: v })} />
                <EditableField label="Charter" value={a.charter}
                  onSave={(v) => patch({ agent: a.name, field: "charter", value: v })} />
                <EditableField label="Persona" value={a.persona}
                  onSave={(v) => patch({ agent: a.name, field: "persona", value: v })} />
                <EditableField label="Prompt" value={a.prompt}
                  onSave={(v) => patch({ agent: a.name, field: "prompt", value: v })} />
                <Chips label="Capabilities" all={catalog.capabilities} selected={a.capabilities}
                  onChange={(next) => patch({ agent: a.name, capabilities: next })} />
                <Chips label="Skills" all={catalog.skills} selected={a.skills}
                  onChange={(next) => patch({ agent: a.name, skills: next })} />
                <div className="flex items-center gap-2">
                  <input placeholder="e.g. make this one warmer"
                    value={notes[a.name] ?? ""}
                    onChange={(e) => setNotes((n) => ({ ...n, [a.name]: e.target.value }))}
                    className="flex-1 bg-bg border border-line rounded-md px-2 py-1 text-[12px] outline-none focus:border-dim" />
                  <Button disabled={busy} onClick={() => void redraft(a.name)}>Redraft</Button>
                </div>
              </div>
```

and add the handlers plus catalog load to `Review`:

```tsx
  const [catalog, setCatalog] = useState<{ capabilities: string[]; skills: string[] }>({ capabilities: [], skills: [] });
  const [notes, setNotes] = useState<Record<string, string>>({});

  useEffect(() => { void api.capabilityCatalog().then(setCatalog).catch(() => {}); }, []);

  const patch = (body: Record<string, unknown>) => {
    api.patchProposal(body)
      .then((r) => setProposal(r.proposal))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const redraft = async (name: string) => {
    setBusy(true); setError("");
    try {
      const r = await api.redraftAgent(name, notes[name] ?? "");
      setProposal(r.proposal);
      setNotes((n) => ({ ...n, [name]: "" }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
```

- [ ] **Step 3: Add the Regenerate button**

In the shipped `Review` component's button row (currently `Pick another` … `Create this org`), insert
Regenerate between them. It only makes sense for an interviewed org — regenerating a template
proposal would just redraw the same template — so it is gated on the proposal's source:

```tsx
        {proposal.source.kind === "interview" && (
          <Button disabled={busy} onClick={() => {
            setBusy(true); setError("");
            api.regenerate()
              .then((r) => setProposal(r.proposal))
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false));
          }}>Regenerate</Button>
        )}
```

and the API method beside the others:

```ts
  regenerate: () =>
    request<{ proposal: OrgProposalView }>("/api/onboarding/regenerate", {
      method: "POST", body: JSON.stringify({}),
    }),
```

- [ ] **Step 4: Build**

Run: `cd ui2 && npm run build`
Expected: `✓ built` with no TypeScript errors

- [ ] **Step 5: Live smoke — the whole path**

The Architect needs real auth, so this smoke makes real model calls. Use a scratch install; never the live daemon.

```bash
rm -rf /tmp/aios-2b && mkdir -p /tmp/aios-2b/agents /tmp/aios-2b/playbooks /tmp/aios-2b/data
AIOS_AGENTS_DIR=/tmp/aios-2b/agents AIOS_PLAYBOOKS_DIR=/tmp/aios-2b/playbooks \
AIOS_DATA_DIR=/tmp/aios-2b/data AIOS_UI_PORT=4291 npm run dev
```

At `http://localhost:4291`: walk to the interview, answer 3-4 questions, let it draft, then on the review screen edit a persona, toggle a capability chip, redraft one agent, and approve.

Expected: manifests under `/tmp/aios-2b/agents/` reflecting the edits, and

```bash
ls -R /tmp/aios-2b/agents
```

showing one coordinator across all departments.

- [ ] **Step 6: Commit**

```bash
git add ui2/src/api.ts ui2/src/views/Setup.tsx src/onboarding/server.ts
git commit -m "feat(ui2): edit, re-chip, and redraft on the review screen

Fields save on blur — a review screen with an unsaved-changes trap is
worse than one that keeps up. Chips offer only catalog names, so the
common way to make an unprovisionable org is simply not reachable."
```

---

### Task 8: Architect eval

Five fixture personas through the real Architect, scored against a rubric. **Never part of `npx vitest run`** — it is LLM-flaky and needs live auth, exactly like `scripts/eval-capture.ts`.

**Files:**
- Create: `scripts/fixtures/architect-personas.json`
- Create: `scripts/eval-architect.ts`

**Interfaces:**
- Consumes: `interviewTurn`, `buildArchitectContext`, `sdkArchitect`, `provision`.
- Produces: a CLI printing per-persona pass/fail and a total.

- [ ] **Step 1: Write the personas**

```json
[
  {
    "name": "bakery",
    "answers": [
      "I run a small bakery. Two staff, lots of wholesale orders.",
      "Chasing invoices and working out what to bake each week from last week's sales.",
      "Nothing should be emailed to a customer without me seeing it first.",
      "That's everything."
    ],
    "expect": { "maxAgents": 5, "minAgents": 2, "maxDepartments": 3 }
  },
  {
    "name": "freelance-dev",
    "answers": [
      "I'm a freelance developer working with three clients.",
      "Context-switching between codebases, and writing status updates nobody reads.",
      "Never push to a client repo without asking me.",
      "That's it."
    ],
    "expect": { "maxAgents": 5, "minAgents": 2, "maxDepartments": 3 }
  },
  {
    "name": "phd-student",
    "answers": [
      "I'm a PhD student in molecular biology, second year.",
      "Reading papers and keeping track of what I already read.",
      "Never cite something you haven't actually read.",
      "Done."
    ],
    "expect": { "maxAgents": 5, "minAgents": 2, "maxDepartments": 3 }
  },
  {
    "name": "parent",
    "answers": [
      "I'm not using this for work. I want help running my household.",
      "Remembering appointments, and where the money goes each month.",
      "Don't spend anything or message anyone as me.",
      "That's all."
    ],
    "expect": { "maxAgents": 5, "minAgents": 2, "maxDepartments": 3 }
  },
  {
    "name": "terse",
    "answers": ["consulting", "reports", "nothing", "done"],
    "expect": { "maxAgents": 5, "minAgents": 2, "maxDepartments": 3 }
  }
]
```

The `terse` persona is the important one: it answers in single words, which is how a real user behaves when they are not sure the thing works yet.

- [ ] **Step 2: Write the eval script**

```ts
// scripts/eval-architect.ts — 5 fixture personas through the real Architect.
// NEVER in vitest: LLM-flaky by design, and it needs live subscription auth.
//   npx tsx scripts/eval-architect.ts
import { readFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArchitectContext, interviewTurn, sdkArchitect, type Turn } from "../src/onboarding/architect.js";
import { listTemplates, loadTemplate } from "../src/onboarding/templates.js";
import { listSkills, skillsPluginRoot } from "../src/web/skills-view.js";
import { loadCapabilities } from "../src/agents/registry/capabilities.js";
import { provision } from "../src/onboarding/provision.js";
import { loadRegistry } from "../src/agents/registry/loader.js";

interface Persona {
  name: string;
  answers: string[];
  expect: { minAgents: number; maxAgents: number; maxDepartments: number };
}

// Top-level await breaks under `npx tsx` run from this repo (it resolves the CJS output),
// so everything goes inside an async main.
async function main(): Promise<void> {
  const templatesDir = join(process.cwd(), "templates");
  const personas = JSON.parse(readFileSync("scripts/fixtures/architect-personas.json", "utf8")) as Persona[];

  const context = buildArchitectContext({
    capabilities: [...loadCapabilities(join(process.cwd(), "agents", "_capabilities.yaml"))]
      .map(([name, def]) => ({ name, labels: def.labels })),
    skills: listSkills(skillsPluginRoot()),
    templates: listTemplates(templatesDir).map((t) => loadTemplate(templatesDir, t.name)!),
  });

  let passed = 0;
  for (const p of personas) {
    const turns: Turn[] = [];
    let verdict = "no proposal after every answer was given";
    try {
      for (const answer of p.answers) {
        turns.push({ role: "user", text: answer });
        const r = await interviewTurn(turns, context, sdkArchitect);
        if (!r.done) { turns.push({ role: "architect", text: r.question }); continue; }

        const { proposal } = r;
        const problems: string[] = [];
        if (proposal.agents.length < p.expect.minAgents) problems.push(`only ${proposal.agents.length} agents`);
        if (proposal.agents.length > p.expect.maxAgents) problems.push(`${proposal.agents.length} agents`);
        if (proposal.departments.length > p.expect.maxDepartments) problems.push(`${proposal.departments.length} departments`);

        // The real bar: does it actually provision? Same provisioner the wizard uses.
        const root = mkdtempSync(join(tmpdir(), `eval-${p.name}-`));
        const agentsDir = join(root, "agents"), playbooksDir = join(root, "playbooks");
        mkdirSync(playbooksDir, { recursive: true });
        const prov = provision(proposal, { agentsDir, playbooksDir, templatesDir, loadRegistry });
        if (!prov.ok) problems.push(...prov.errors.map((e) => `${e.name ?? e.scope}: ${e.error}`));

        verdict = problems.length === 0
          ? `PASS (${proposal.agents.length} agents, ${proposal.departments.length} depts, ${turns.filter((t) => t.role === "architect").length} questions)`
          : `FAIL — ${problems.join("; ")}`;
        break;
      }
    } catch (err) {
      verdict = `FAIL — ${(err as Error).message}`;
    }
    if (verdict.startsWith("PASS")) passed++;
    console.log(`${p.name.padEnd(14)} ${verdict}`);
  }
  console.log(`\n${passed}/${personas.length} personas produced a provisionable org.`);
}

void main();
```

- [ ] **Step 3: Run it once against live auth**

Run: `npx tsx scripts/eval-architect.ts`
Expected: each persona prints PASS or a named FAIL, then a total.

Read the failures as prompt feedback, not as bugs. A persona that fails on wall violations or invented capability names means `ARCHITECT_SYSTEM` needs the rule stated more plainly — the same one-sanctioned-iteration loop that `eval-capture` used. Record the before/after in the commit.

- [ ] **Step 4: Confirm the eval is not in the suite**

Run: `npx vitest run 2>&1 | grep -c architect-personas`
Expected: `0`

- [ ] **Step 5: Commit**

```bash
git add scripts/eval-architect.ts scripts/fixtures/architect-personas.json
git commit -m "test(architect): on-demand eval over five fixture personas

The bar is not a rubric score but whether the draft actually provisions
through the real provisioner. Never in vitest: LLM-flaky by design and
needs live auth, same rule as eval-capture."
```

---

## Done when

- `npx vitest run` passes with the new suites; no pre-existing test was weakened.
- `npx tsc --noEmit` clean for both roots.
- A scratch install walks: auth → workspace → **interview** (3-4 questions) → review → edit a persona, toggle a chip, redraft one agent → approve → manifests on disk reflecting the edits, one coordinator.
- "Skip — pick a template instead" reaches the gallery from any point in the interview, and that path still provisions.
- `npx tsx scripts/eval-architect.ts` runs and reports per-persona results.

## Deliberately not in this plan

- **Skills catalog growth (3 → ~12) and the Skills-tab attach/detach** — that is plan 2c. The Architect reads whatever `listSkills` returns today, so 2c enriches it with no change here.
- **Workspace step, Library view, first-job execution** — plan 3.
- **`agents/` out of version control and the fixture-org re-anchor** — plan 2a-bis, which also deletes the duplicate `agents/_capabilities.yaml` and its drift test.

---

## Execution outcome (2026-07-31)

Executed inline in one session. 8 tasks, 8 commits, merged to `main` as `43182f3` (PR #14).
Suite went 209 files / 1673 passing → **210 files / 1721 passing**, 2 skipped. `npx tsc --noEmit`
clean, `cd ui2 && npm run build` clean, both verified **on the merged result**.

### Four fixes the live smoke forced

None were reachable by unit tests — injected fakes cannot fail the way the real SDK and the real
model do. Each one made the interview completely non-functional, and each was found only by
running the whole path against live auth.

1. **`maxTurns: 1` failed every call** with `error_max_turns`. Forced JSON needs one turn to emit
   the `StructuredOutput` call and another to finish. The plan specified `maxTurns: 1` by analogy
   with `sdkPing`, which has no tools. Removed, matching `runner.ts`, which sets no `maxTurns` on
   its schema calls.
2. **The model refused the tool mid-interview.** It answered in plain text — *"I appreciate the
   nudge, but I can't design a useful org for you yet... The StructuredOutput tool is for when I'm
   ready to deliver a proposal"* — leaving `structured_output` undefined. `ARCHITECT_SYSTEM` never
   said that a *question* also travels through the tool. It now opens with a `HOW YOU SPEAK`
   section stating every turn is a `StructuredOutput` call. Pinned by a test.
3. **Fresh installs drafted tool-less agents.** `seedCapabilities` plants `_capabilities.yaml` in
   the user's agents dir at **provision**, but the interview and the review chips both run
   **before** that, so `loadCapabilities(agentsDir)` returned an empty map and every drafted agent
   got `capabilities: []`. The catalog now falls back to `templates/_capabilities.yaml`, preferring
   the user's copy once it exists. Two regression tests; the first was initially **vacuous**
   (the worked-examples section also contains "web") and had to be sharpened to slice the
   capability section out of the prompt.
4. **Invented playbook names killed finished interviews.** The model fills `playbooks` with prose
   ("triage incoming requests and delegate to chase or otto") and provision rejects the whole org
   with `unknown playbook`. An interviewed org has no playbooks at all — templates ship their own,
   an interview has none to name — so the field is now normalised away in `interviewTurn` rather
   than left to kill a completed interview over something the user never saw and cannot fix from
   the review screen. Stated in the prompt too, but the deterministic strip is what guarantees it.

### Plan defects found while executing

- **Task 1 could not pass as written.** `ARCHITECT_SYSTEM` said `EXACTLY ONE agent has kind
  "coordinator"` while the task's own test asserted the contiguous phrase
  `/exactly one coordinator/i`. The prompt was reworded (the test encodes the intent: the prompt
  must state the rule the validator enforces).
- **Task 2's `as const satisfies` conflicted with its own test.** `INTERVIEW_SCHEMA.required` is a
  readonly tuple, so the test's `as string[]` cast is illegal under `tsc`. Widened to
  `readonly string[]`.
- **Task 4 predicted 8 new failures; 7 failed.** The "404s when there is no proposal" case already
  passed via the generic `/api/` catch-all — right status, wrong reason.

### Deviations from the plan, taken deliberately

- `sdkArchitect` reuses `auth.ts`'s `pingFailure` instead of re-implementing the result check: the
  plan's inline version missed `api_error_status`, which is half of how a rejected call lies about
  succeeding. Subtype is checked **first** because that is what narrows the SDK union to the
  variant carrying `structured_output` — swapping in `pingFailure` alone broke the typecheck, which
  is how the coupling surfaced.
- The interview's priming turn is guarded by a `useRef`, not by `turns` state. StrictMode
  double-invokes mount effects in dev and both passes would read an empty transcript before either
  committed — a duplicate **billed** call and a doubled transcript.
- `listTemplates(...).map(loadTemplate)` uses a type-predicate filter rather than the plan's `!`
  non-null assertion.

### Verified end to end

- Scratch install on a spare port (never the live daemon): auth → workspace → interview
  (3 questions) → review → edit a persona → toggle a capability chip → redraft one agent → approve.
  Manifests on disk reflect the edits; `loadRegistry` loads with coordinator `nova`.
- Escape hatch clicked through in a real browser: "Skip — pick a template instead" renders the
  gallery **below** the live chat without losing the interview, and that path still provisions
  (`starter-brief.yaml` + 5 manifests on disk). The review screen correctly hides Regenerate for a
  template-sourced proposal.
- `npx tsx scripts/eval-architect.ts` → **5/5 personas produced a provisionable org**, `terse`
  included. No prompt iteration was needed after the smoke fixes.

### Still open

- Plan 2c (skills catalog 3 → ~12) and plan 3 (value path / first-job execution) are unchanged by
  this work. The Architect reads whatever `listSkills` returns, so 2c enriches it with no change here.
- `agents/` out of version control and the fixture-org re-anchor remain plan 2a-bis, still deferred
  to the repo owner.
