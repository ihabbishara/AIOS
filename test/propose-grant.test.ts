// test/propose-grant.test.ts — the grant proposer queues exactly once per (role, tool):
// an identical already-queued proposal is never duplicated.
import { describe, it, expect } from "vitest";
import { makeGrantProposer } from "../src/kernel/propose-grant.js";

const fakeStore = (queued: Array<{ role: string; tool: string }>) => ({
  listActions: () => queued.map((q, i) => ({
    id: `a${i}`, type: "permission.grant", payload: JSON.stringify(q),
  })),
}) as never;

describe("makeGrantProposer", () => {
  it("proposes a permission.grant with the role and tool", async () => {
    const proposals: unknown[] = [];
    const gate = { propose: async (input: unknown) => { proposals.push(input); return {} as never; } } as never;
    await makeGrantProposer(fakeStore([]), gate)("clio", "Bash");
    expect(proposals[0]).toMatchObject({ type: "permission.grant", payload: { role: "clio", tool: "Bash" } });
  });

  it("dedupes against an identical queued proposal, but not a different tool", async () => {
    const proposals: unknown[] = [];
    const gate = { propose: async (input: unknown) => { proposals.push(input); return {} as never; } } as never;
    const propose = makeGrantProposer(fakeStore([{ role: "clio", tool: "Bash" }]), gate);
    await propose("clio", "Bash");      // identical → skipped
    await propose("clio", "WebSearch"); // different tool → proposed
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ payload: { role: "clio", tool: "WebSearch" } });
  });
});
