// test/guard-deny.test.ts — guardOptions onDeny: every guard denial reaches the collector,
// once per tool per wiring, from BOTH the canUseTool path and the PreToolUse hook path.
import { describe, it, expect } from "vitest";
import { guardOptions, type ToolCheck } from "../src/agents/guards/index.js";

const denyAll: Record<string, ToolCheck> = {
  Bash: () => ({ ok: false, reason: "advisory context: filesystem/exec disabled — use recall/vault_read" }),
};

// The PreToolUse hook is stored as [{ hooks: [fn] }]
const hookFn = (opts: ReturnType<typeof guardOptions>) =>
  (opts.hooks!.PreToolUse![0] as unknown as { hooks: Array<(raw: unknown) => Promise<unknown>> }).hooks[0];

const sig = () => ({ signal: new AbortController().signal, toolUseID: "t1" });

describe("guardOptions onDeny", () => {
  it("fires on a canUseTool deny with the guard's verbatim reason", async () => {
    const seen: Array<[string, string]> = [];
    const opts = guardOptions(denyAll, "allow", (tool, reason) => seen.push([tool, reason]));
    const v = await opts.canUseTool!("Bash", {}, sig());
    expect(v).toMatchObject({ behavior: "deny" });
    expect(seen).toEqual([["Bash", "advisory context: filesystem/exec disabled — use recall/vault_read"]]);
  });

  it("fires on the PreToolUse-hook deny path, and dedupes per tool across both paths", async () => {
    const seen: string[] = [];
    const opts = guardOptions(denyAll, "allow", (tool) => seen.push(tool));
    await hookFn(opts)({ tool_name: "Bash", tool_input: {} });
    await opts.canUseTool!("Bash", {}, sig());
    await hookFn(opts)({ tool_name: "Bash", tool_input: {} });
    expect(seen).toEqual(["Bash"]); // one report per tool, however many times it is hit
  });

  it("fires on a fallback-deny for an unlisted tool", async () => {
    const seen: Array<[string, string]> = [];
    const opts = guardOptions({}, "deny", (tool, reason) => seen.push([tool, reason]));
    await opts.canUseTool!("WebSearch", {}, sig());
    expect(seen).toEqual([["WebSearch", "tool WebSearch is not permitted for this agent"]]);
  });

  it("never fires on allows, and a throwing onDeny never breaks the guard", async () => {
    const opts = guardOptions(denyAll, "allow", () => { throw new Error("collector broke"); });
    const allow = await opts.canUseTool!("Read", {}, sig());
    expect(allow).toMatchObject({ behavior: "allow" });
    const deny = await opts.canUseTool!("Bash", {}, sig());
    expect(deny).toMatchObject({ behavior: "deny" }); // deny still returned despite the throw
  });
});
