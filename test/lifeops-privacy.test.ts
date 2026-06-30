import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { recall } from "../src/memory/recall.js";
import { roles } from "../src/agents/roles/index.js";
import { isPrivateOrigin, DirectChats } from "../src/agents/direct.js";

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
      primaryChat: { channel: "telegram", chatId: "123" },
    });
    // Send from a different chatId — jasmine must refuse.
    const result = await dc.handle("jasmine", "telegram", "999", "list my tasks");
    expect(result.text).toMatch(/private/i);
    expect(result.attachments).toEqual([]);
  });
});
