import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/db.js";
import { buildLifeopsServer } from "../src/lifeops/server.js";

// Mirror research-server.test.ts: pull handlers off the built server's _registeredTools.
function handlers(store: Store) {
  const server = buildLifeopsServer({ store }) as unknown as {
    instance: { _registeredTools: Record<string, { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }> };
  };
  return server.instance._registeredTools;
}
const callText = async (h: { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }, a: unknown) =>
  (await h.handler(a)).content[0].text;

describe("lifeops MCP server", () => {
  let store: Store;
  let t: ReturnType<typeof handlers>;
  beforeEach(() => { store = new Store(":memory:"); t = handlers(store); });

  it("add_task → list_tasks round-trip", async () => {
    await callText(t.add_task, { title: "Book MOT", due_date: "2026-07-02" });
    const out = await callText(t.list_tasks, {});
    expect(out).toContain("Book MOT");
    expect(store.listTasks()).toHaveLength(1);
  });

  it("update_task edits fields", async () => {
    await callText(t.add_task, { title: "x" });
    const id = store.listTasks()[0].id;
    await callText(t.update_task, { id, next_action: "ring garage" });
    expect(store.getTask(id)!.next_action).toBe("ring garage");
  });

  it("complete_task / dismiss_task set status", async () => {
    await callText(t.add_task, { title: "a" });
    await callText(t.add_task, { title: "b" });
    const [a, b] = store.listTasks().map((r) => r.id);
    await callText(t.complete_task, { id: a });
    await callText(t.dismiss_task, { id: b });
    expect(store.listTasks("open")).toHaveLength(0);
  });
});
