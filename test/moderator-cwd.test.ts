// test/moderator-cwd.test.ts — pins the load-bearing invariant that the moderator seam resolves
// the coordinator with the DAEMON cwd (process.cwd()), NOT projectsRoot. Getting this wrong once
// broke SDK session resume ("No conversation found") and EPIPE-crashed the daemon (org-model
// deploy). A "consistency" refactor that normalizes this to projectsRoot must fail here.
import { describe, it, expect } from "vitest";
import { Moderator, type ModeratorDeps } from "../src/moderator/session.js";
import { Store } from "../src/store/db.js";

describe("moderator coordinator cwd", () => {
  it("resolves the coordinator with process.cwd(), never projectsRoot", async () => {
    let capturedCwd: string | undefined;
    const registry = {
      agents: new Map([["hermes", { manifest: { name: "hermes", title: "CoS", charter: "" }, department: "exec" }]]),
      coordinator: "hermes",
      departments: new Map(),
      agentOf: new Map(),
    };
    const deps = {
      store: new Store(":memory:"),
      bus: { emit() {}, on: () => () => {}, history: () => [] },
      goals: {},
      vault: {},
      handOff: async () => ({ text: "" }),
      registry,
      projectsRoot: "/some/other/projects/root",
      // Capture the cwd the coordinator is resolved with, then throw to short-circuit before the
      // SDK query (everything after this call is irrelevant to the invariant under test).
      resolveAgent: (_name: string, _origin: unknown, opts?: { cwd?: string }) => {
        capturedCwd = opts?.cwd;
        throw new Error("stop-after-capture");
      },
      gate: {}, actionTypes: [], google: {}, memory: {},
    } as unknown as ModeratorDeps;

    await new Moderator(deps).handle("cli", "local", "hi").catch(() => { /* expected short-circuit */ });

    expect(capturedCwd).toBe(process.cwd());
    expect(capturedCwd).not.toBe((deps as unknown as { projectsRoot: string }).projectsRoot);
  });
});
