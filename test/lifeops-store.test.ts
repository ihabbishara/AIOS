import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/db.js";

function freshStore(): Store {
  return new Store(":memory:"); // mirror money-store.test.ts construction
}

describe("personal_tasks store", () => {
  let store: Store;
  beforeEach(() => { store = freshStore(); });

  it("adds a task with defaults and lists it", () => {
    const id = store.addTask({ title: "Renew passport" });
    const rows = store.listTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].title).toBe("Renew passport");
    expect(rows[0].status).toBe("open");
    expect(rows[0].due_date).toBeNull();
  });

  it("filters by status and project", () => {
    store.addTask({ title: "a", project: "home" });
    const w = store.addTask({ title: "b", status: "waiting", project: "work" });
    expect(store.listTasks("waiting").map((t) => t.id)).toEqual([w]);
    expect(store.listTasks(undefined, "home").map((t) => t.title)).toEqual(["a"]);
  });

  it("updateTask changes fields and bumps updated_at", async () => {
    const id = store.addTask({ title: "x" });
    const before = store.getTask(id)!.updated_at;
    await new Promise((r) => setTimeout(r, 5));
    store.updateTask(id, { next_action: "call office", due_date: "2026-07-01" });
    const after = store.getTask(id)!;
    expect(after.next_action).toBe("call office");
    expect(after.due_date).toBe("2026-07-01");
    expect(after.updated_at >= before).toBe(true);
  });

  it("complete/dismiss set terminal status", () => {
    const a = store.addTask({ title: "a" });
    const b = store.addTask({ title: "b" });
    store.completeTask(a);
    store.dismissTask(b);
    expect(store.getTask(a)!.status).toBe("done");
    expect(store.getTask(b)!.status).toBe("dismissed");
    expect(store.listTasks("open")).toHaveLength(0);
  });
});
