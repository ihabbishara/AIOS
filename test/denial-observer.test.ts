import { describe, it, expect } from "vitest";
import { withDenialObserver } from "../src/agents/permissions.js";

/** Invoke the (single) PreToolUse hook the observer attached, with a tool name. */
async function fire(options: any, toolName: string) {
  const hook = options.hooks.PreToolUse[0].hooks[0];
  return hook({ tool_name: toolName, tool_input: {} });
}

describe("withDenialObserver", () => {
  it("emits tool.denied for a tool outside the allowlist and returns a deny decision", async () => {
    const emitted: Array<{ role: string; tool: string }> = [];
    const opts = withDenialObserver(
      { allowedTools: ["Read"], permissionMode: "dontAsk" },
      "finance",
      (e) => emitted.push(e),
    );
    const res = await fire(opts, "Bash");
    expect(emitted).toEqual([{ role: "finance", tool: "Bash" }]);
    expect(res.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("does NOT emit for an allowed tool, and lets it continue", async () => {
    const emitted: unknown[] = [];
    const opts = withDenialObserver({ allowedTools: ["Read"], permissionMode: "dontAsk" }, "finance", (e) => emitted.push(e));
    const res = await fire(opts, "Read");
    expect(emitted).toEqual([]);
    expect(res).toEqual({ continue: true });
  });

  it("does NOT emit for mcp__ tools (governed by allowedTools, not denials)", async () => {
    const emitted: unknown[] = [];
    const opts = withDenialObserver({ allowedTools: [], permissionMode: "dontAsk" }, "finance", (e) => emitted.push(e));
    await fire(opts, "mcp__finance__add_expense");
    expect(emitted).toEqual([]);
  });

  it("dedupes within a run — the same (role,tool) fires the event only once", async () => {
    const emitted: unknown[] = [];
    const opts = withDenialObserver({ allowedTools: [], permissionMode: "dontAsk" }, "finance", (e) => emitted.push(e));
    await fire(opts, "Bash");
    await fire(opts, "Bash");
    expect(emitted).toHaveLength(1);
  });

  it("bypassPermissions roles get NO observer (nothing is denied in a sandbox) — options returned unchanged", () => {
    const input = { allowedTools: ["Read"], permissionMode: "bypassPermissions" as const };
    expect(withDenialObserver(input, "developer", () => {})).toBe(input);
  });

  it("an emit callback that throws never propagates out of the hook", async () => {
    const opts = withDenialObserver({ allowedTools: [], permissionMode: "dontAsk" }, "finance", () => {
      throw new Error("bus exploded");
    });
    await expect(fire(opts, "Bash")).resolves.toBeTruthy(); // does not reject
  });

  it("preserves an existing PreToolUse hook (appends, does not clobber)", async () => {
    let guardRan = false;
    const input = {
      allowedTools: ["Read"],
      permissionMode: "default" as const,
      hooks: { PreToolUse: [{ hooks: [async () => { guardRan = true; return { continue: true }; }] }] },
    };
    const opts = withDenialObserver(input, "halalo", () => {});
    expect(opts.hooks.PreToolUse).toHaveLength(2); // guard + observer
    await (opts.hooks.PreToolUse[0].hooks[0] as any)({ tool_name: "Read", tool_input: {} });
    expect(guardRan).toBe(true);
  });
});
