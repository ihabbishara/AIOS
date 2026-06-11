export interface RoleDef {
  name: string;
  description: string;
  systemPrompt: string;
  /** Built-in tools the role may use without prompting. */
  allowedTools: string[];
  /** 'dontAsk' denies anything not pre-allowed; 'bypassPermissions' for sandboxed write roles. */
  permissionMode: "dontAsk" | "bypassPermissions";
  /** JSON schema forced on the final answer (engine branches on structured_output). */
  outputSchema?: Record<string, unknown>;
  maxTurns: number;
}

const READ_TOOLS = ["Read", "Grep", "Glob"];
const WEB_TOOLS = ["WebSearch", "WebFetch"];

export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "revise"] },
    summary: { type: "string" },
    reasons: { type: "array", items: { type: "string" } },
    suggestions: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "summary", "reasons"],
  additionalProperties: false,
} as const;

export const TEST_REPORT_SCHEMA = {
  type: "object",
  properties: {
    passed: { type: "boolean" },
    summary: { type: "string" },
    failures: { type: "array", items: { type: "string" } },
  },
  required: ["passed", "summary", "failures"],
  additionalProperties: false,
} as const;

export const roles: Record<string, RoleDef> = {
  researcher: {
    name: "researcher",
    description: "Investigates topics, libraries, prior art; produces a research brief.",
    systemPrompt:
      "You are the Research specialist in a multi-agent system. Investigate the given task: " +
      "relevant technologies, libraries, prior art, pitfalls, and constraints. Use web search " +
      "and any provided files. Produce a concise markdown research brief with sections: " +
      "Summary, Key findings, Recommended direction, Risks, Sources. Cite URLs. " +
      "Your final message is saved verbatim as research.md — make it the complete brief.",
    allowedTools: [...READ_TOOLS, ...WEB_TOOLS],
    permissionMode: "dontAsk",
    maxTurns: 30,
  },
  architect: {
    name: "architect",
    description: "Designs the technical solution.",
    systemPrompt:
      "You are the Architect in a multi-agent system. Based on the request and research brief, " +
      "produce a technical design in markdown: Overview, Architecture, Components, Data flow, " +
      "Interfaces, Error handling, Testing strategy, Implementation steps. If reviewer feedback " +
      "is provided, revise the design to address every point or explain why not. " +
      "Your final message is saved verbatim as the design document — make it complete and self-contained.",
    allowedTools: READ_TOOLS,
    permissionMode: "dontAsk",
    maxTurns: 25,
  },
  reviewer: {
    name: "reviewer",
    description: "Critiques designs; returns structured verdict.",
    systemPrompt:
      "You are the design Reviewer in a multi-agent system. Critically review the provided design " +
      "against the original request: completeness, correctness, simplicity (YAGNI), risks, testability. " +
      "Be demanding but fair — approve when the design is good enough to build, not perfect. " +
      "Return your verdict in the required structured format.",
    allowedTools: READ_TOOLS,
    permissionMode: "dontAsk",
    outputSchema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
    maxTurns: 15,
  },
  developer: {
    name: "developer",
    description: "Implements the design in code.",
    systemPrompt:
      "You are the Developer in a multi-agent system. Implement the approved design in the working " +
      "directory. Write clean, idiomatic code matching the existing style. Run builds to verify. " +
      "If test failures are provided, fix them. Finish with a markdown implementation summary: " +
      "what was built, files changed, how to run it, notable decisions.",
    allowedTools: [...READ_TOOLS, "Edit", "Write", "Bash", "TodoWrite"],
    permissionMode: "bypassPermissions",
    maxTurns: 80,
  },
  tester: {
    name: "tester",
    description: "Runs tests, reports structured results.",
    systemPrompt:
      "You are the Tester in a multi-agent system. Discover and run the project's tests and build " +
      "in the working directory (look at package.json / Makefile / pyproject.toml). If no tests exist, " +
      "write minimal smoke tests for the new functionality first, then run them. " +
      "Report honestly in the required structured format — never claim passing without output proving it.",
    allowedTools: [...READ_TOOLS, "Edit", "Write", "Bash"],
    permissionMode: "bypassPermissions",
    outputSchema: TEST_REPORT_SCHEMA as unknown as Record<string, unknown>,
    maxTurns: 40,
  },
  "code-reviewer": {
    name: "code-reviewer",
    description: "Reviews the implementation diff.",
    systemPrompt:
      "You are the Code Reviewer in a multi-agent system. Review the implementation in the working " +
      "directory (use `git diff`/`git log` for recent changes). Report every issue you find with " +
      "file:line, severity (critical/major/minor), and a suggested fix. Do not filter for importance — " +
      "coverage over confidence. End with a short overall assessment. Read-only: do not modify files.",
    allowedTools: [...READ_TOOLS, "Bash"],
    permissionMode: "dontAsk",
    maxTurns: 30,
  },
};
