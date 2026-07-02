import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { recall } from "../src/memory/recall.js";
import { roles } from "../src/agents/roles/index.js";
import { isPrivateOrigin, DirectChats } from "../src/agents/direct.js";
import { loadPacks } from "../src/packs/loader.js";
import { testRegistry } from "./fixtures/registry.js";

const PB = join(process.cwd(), "playbooks");

// ---------------------------------------------------------------------------
// Invariant 1: personal_tasks rows NEVER enter the recall index.
//   The indexer only reads vault, event, decision, and memo documents via
//   indexDoc(). It never calls indexDoc() for personal_* tables. Therefore a
//   string that appears ONLY in a personal_tasks title/notes yields no hit.
// ---------------------------------------------------------------------------
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
    expect(roles.jasmine).toBeDefined();
    expect(roles.jasmine.privateOnly).toBe(true);
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
    const dc = new DirectChats({
      store: {} as never,
      bus: { emit() {} } as never,
      projectsRoot: "/tmp",
      registry: testRegistry(),
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
describe("lifeops privacy: pack tools contain no outward/gated tools", () => {
  it("lifeops pack tools are exactly the 5 mcp__lifeops__* tools plus vault_read", () => {
    const reg = loadPacks(PB);
    const lifeops = reg.packs.get("lifeops");
    expect(lifeops).toBeDefined();
    const tools = lifeops!.tools;
    // Must have exactly 6 tools
    expect(tools).toHaveLength(6);
    // All mcp__lifeops__* tools present
    expect(tools).toContain("mcp__lifeops__add_task");
    expect(tools).toContain("mcp__lifeops__list_tasks");
    expect(tools).toContain("mcp__lifeops__update_task");
    expect(tools).toContain("mcp__lifeops__complete_task");
    expect(tools).toContain("mcp__lifeops__dismiss_task");
    // vault_read present
    expect(tools).toContain("vault_read");
    // Gated/outward tools must NOT appear
    expect(tools).not.toContain("vault_write");
    expect(tools).not.toContain("propose_action");
    for (const t of tools) {
      expect(t).not.toMatch(/propose|gate|email|git|calendar/i);
    }
  });
});
