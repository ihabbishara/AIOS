import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { recall } from "../src/memory/recall.js";
import { roleOf } from "./fixtures/registry.js";
import { isPrivateOrigin, DirectChats } from "../src/agents/direct.js";
import { testRegistry } from "./fixtures/registry.js";
import { capabilityTools } from "../src/agents/registry/loader.js";

// ---------------------------------------------------------------------------
// Invariant 1: personal_tasks rows NEVER enter the recall index.
//   The indexer only reads vault, event, decision, and memo documents via
//   indexDoc(). It never calls indexDoc() for personal_* tables. Therefore a
//   string that appears ONLY in a personal_tasks title/notes yields no hit.
// ---------------------------------------------------------------------------
const stubResolve = (registry: ReturnType<typeof testRegistry>) =>
  ((name, _origin, _ctx) => {
    const canonical = registry.agentOf.get(name.toLowerCase());
    const def = canonical ? registry.agents.get(canonical) : undefined;
    if (!canonical || !def) return undefined;
    return { canonical, kind: def.kind, def, options: { systemPrompt: "", allowedTools: [] }, ceiling: [], labels: [] };
  }) as import("../src/agents/resolve.js").ResolveAgentFn;

describe("lifeops privacy: tasks never enter recall", () => {
  it("a task title is not retrievable via recall", () => {
    const store = new Store(":memory:");
    store.addTask({ title: "Schedule colonoscopy", notes: "private medical errand" });
    // Nothing was indexed (indexDoc was never called for personal_tasks rows).
    const hits = recall(store, "colonoscopy");
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Invariant 2: jasmine (privateOnly) is refused from a non-private origin.
//   Mirrors cfo-role.test.ts's isPrivateOrigin assertions, then goes one step
//   further and exercises the DirectChats.handle() gate directly so the full
//   runtime refusal path is pinned.
// ---------------------------------------------------------------------------
describe("lifeops privacy: jasmine refused from non-private origin", () => {
  it("jasmine is registered as privateOnly", () => {
    expect(roleOf("jasmine")).toBeDefined();
    expect(roleOf("jasmine").privateOnly).toBe(true);
  });

  it("isPrivateOrigin returns false for a non-primary origin", () => {
    const primary = { channel: "telegram", chatId: "123" };
    // same chat — allowed
    expect(isPrivateOrigin(primary, "telegram", "123")).toBe(true);
    // different chatId — refused
    expect(isPrivateOrigin(primary, "telegram", "999")).toBe(false);
    // no primaryChat configured — refused
    expect(isPrivateOrigin(undefined, "telegram", "123")).toBe(false);
  });

  it("DirectChats.handle returns the private-refusal text for a non-primary origin", async () => {
    // Construct DirectChats with a primaryChat. The refusal fires before any
    // async work (lock, resumableTurn), so a stub store/bus is sufficient.
    const reg = testRegistry();
    const dc = new DirectChats({
      store: {} as never,
      bus: { emit() {} } as never,
      projectsRoot: "/tmp",
      registry: reg,
      resolveAgent: stubResolve(reg),
      primaryChat: { channel: "telegram", chatId: "123" },
    });
    // Send from a different chatId — jasmine must refuse.
    const result = await dc.handle("jasmine", "telegram", "999", "list my tasks");
    expect(result.text).toMatch(/private/i);
    expect(result.attachments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Invariant 2 (outward-tool pin): the lifeops pack manifest must contain ONLY
//   the 5 mcp__lifeops__* tools and vault_read. No gated/outward tools such as
//   vault_write, propose_action, or anything matching /propose|gate|email|git|calendar/i.
// ---------------------------------------------------------------------------
describe("lifeops privacy: life department tools contain no outward/gated tools", () => {
  it("life department agents have only mcp__lifeops__* tools plus vault_read", () => {
    const reg = testRegistry();
    expect(reg.departments.get("life")).toBeDefined();
    const tools = [...reg.agents.values()]
      .filter((a) => a.department === "life")
      .flatMap((a) => capabilityTools(reg, a.manifest.name));
    expect(tools).toContain("mcp__lifeops__add_task");
    expect(tools).toContain("mcp__aios-pack__vault_read");
    expect(tools).not.toContain("mcp__aios-pack__vault_write");
    expect(tools).not.toContain("mcp__aios-pack__propose_action");
    for (const t of tools) {
      expect(t).not.toMatch(/propose|gate|email|git|calendar/i);
    }
  });
});
