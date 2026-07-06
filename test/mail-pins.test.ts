// test/mail-pins.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("mail invariant pins", () => {
  it("all three entry paths use withMailOptions/buildMailServer (capability parity)", () => {
    const runner = readFileSync("src/agents/runner.ts", "utf8");
    const direct = readFileSync("src/agents/direct.ts", "utf8");
    const handoff = readFileSync("src/moderator/handoff.ts", "utf8");
    expect(runner).toContain("withMailOptions(merged");           // node runs + hand_off runs
    expect(direct).toContain("buildMailServer(this.deps.mailbox"); // @mention turns
    expect(direct).toContain("MAIL_TOOL, ASK_TOOL");               // @mention widens ask parity too (matches runner)
    expect(handoff).toContain("mailCtx: { origin, goalDepth: 0 }"); // hand_off threads ctx
  });

  it("mail allowlist widening happens BEFORE the denial observer wraps", () => {
    const runner = readFileSync("src/agents/runner.ts", "utf8");
    const mailIdx = runner.indexOf("withMailOptions(merged");
    const observerIdx = runner.indexOf("withDenialObserver(withSchema");
    expect(mailIdx).toBeGreaterThan(-1);
    expect(observerIdx).toBeGreaterThan(mailIdx);
  });

  it("standup digest calls no personal_* or email store methods", () => {
    // Strip comments/docstrings — the module's own docstring promises this exclusion.
    const code = readFileSync("src/heartbeat/standup.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // Actual leak vectors are store-method calls, not bare words.
    expect(code).not.toMatch(/\.(listTasks|listTransactions|readEmail|listInbox)\(|personal_transactions|personal_tasks/);
  });

  it("report/standup kinds are not sendable via the tool schema", () => {
    const server = readFileSync("src/mail/server.ts", "utf8");
    expect(server).toContain('z.enum(["request", "note"])');
    expect(server).not.toContain('"report"');
  });
});
