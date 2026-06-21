import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

describe("Store.setProjectDir", () => {
  it("updates project_dir on a job row", () => {
    const store = new Store(":memory:");
    store.insertJob({
      id: "j1", slug: "s", title: "t", playbook: "code-build", request: "r",
      project_dir: null, channel: "c", chat_id: "ch", status: "queued", error: null,
    } as any);
    store.setProjectDir("j1", "/ws/task");
    expect(store.getJob("j1")!.project_dir).toBe("/ws/task");
  });
});
