import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { runSpeculate, type ResearchTask, type SpeculateJobs } from "../src/heartbeat/speculate.js";
import { localParts } from "../src/heartbeat/clock.js";

const NOW = new Date("2026-06-17T03:00:00.000Z");
const TODAY = localParts(NOW).date;

function seedDream(s: Store, date: string, n = 3) {
  const initiatives = Array.from({ length: n }, (_, i) => ({ title: `init ${i}`, why: "w", suggestion: "s" }));
  s.kvSet("dream:latest", JSON.stringify({ date, initiatives }));
}

/** Records every createJob call; returns deterministic id/slug per call. */
function stubJobs(): SpeculateJobs & { calls: Array<{ playbook: string; title: string; request: string; channel: string; chatId: string }> } {
  const calls: Array<{ playbook: string; title: string; request: string; channel: string; chatId: string }> = [];
  return {
    calls,
    createJob(params) {
      calls.push(params);
      return { id: `id-${calls.length}`, slug: `slug-${calls.length}` };
    },
  };
}

const THREE_TASKS: ResearchTask[] = [
  { title: "T0", question: "Q0?" },
  { title: "T1", question: "Q1?" },
  { title: "T2", question: "Q2?" },
];

describe("runSpeculate", () => {
  it("enqueues at most maxJobs research-report jobs with system origin and stamps speculate:latest", async () => {
    const s = new Store(":memory:");
    seedDream(s, TODAY);
    const jobs = stubJobs();
    await runSpeculate({ store: s, jobs, plan: async () => THREE_TASKS, maxJobs: 2, nowFn: () => NOW });

    expect(jobs.calls).toHaveLength(2); // cap enforced
    expect(jobs.calls[0]).toEqual({ playbook: "research-report", title: "T0", request: "Q0?", channel: "system", chatId: "speculate" });
    expect(jobs.calls[1].title).toBe("T1");

    const saved = JSON.parse(s.kvGet("speculate:latest")!);
    expect(saved.date).toBe(TODAY);
    expect(saved.tasks).toEqual([
      { title: "T0", slug: "slug-1", id: "id-1" },
      { title: "T1", slug: "slug-2", id: "id-2" },
    ]);
  });

  it("does nothing when there is no dream:latest (no jobs, no kv)", async () => {
    const s = new Store(":memory:");
    const jobs = stubJobs();
    await runSpeculate({ store: s, jobs, plan: async () => THREE_TASKS, maxJobs: 2, nowFn: () => NOW });
    expect(jobs.calls).toHaveLength(0);
    expect(s.kvGet("speculate:latest")).toBeUndefined();
  });

  it("ignores a stale-dated dream:latest", async () => {
    const s = new Store(":memory:");
    seedDream(s, "2020-01-01");
    const jobs = stubJobs();
    await runSpeculate({ store: s, jobs, plan: async () => THREE_TASKS, maxJobs: 2, nowFn: () => NOW });
    expect(jobs.calls).toHaveLength(0);
    expect(s.kvGet("speculate:latest")).toBeUndefined();
  });

  it("does nothing when initiatives are empty", async () => {
    const s = new Store(":memory:");
    s.kvSet("dream:latest", JSON.stringify({ date: TODAY, initiatives: [] }));
    const jobs = stubJobs();
    await runSpeculate({ store: s, jobs, plan: async () => THREE_TASKS, maxJobs: 2, nowFn: () => NOW });
    expect(jobs.calls).toHaveLength(0);
    expect(s.kvGet("speculate:latest")).toBeUndefined();
  });

  it("writes nothing when the planner returns an empty list", async () => {
    const s = new Store(":memory:");
    seedDream(s, TODAY);
    const jobs = stubJobs();
    await runSpeculate({ store: s, jobs, plan: async () => [], maxJobs: 2, nowFn: () => NOW });
    expect(jobs.calls).toHaveLength(0);
    expect(s.kvGet("speculate:latest")).toBeUndefined();
  });

  it("is fail-silent: a throwing planner enqueues nothing and writes nothing", async () => {
    const s = new Store(":memory:");
    seedDream(s, TODAY);
    const jobs = stubJobs();
    await runSpeculate({ store: s, jobs, plan: async () => { throw new Error("llm down"); }, maxJobs: 2, nowFn: () => NOW });
    expect(jobs.calls).toHaveLength(0);
    expect(s.kvGet("speculate:latest")).toBeUndefined();
  });

  it("ignores a malformed dream:latest (no throw, no work)", async () => {
    const s = new Store(":memory:");
    s.kvSet("dream:latest", "not json {");
    const jobs = stubJobs();
    await expect(
      runSpeculate({ store: s, jobs, plan: async () => THREE_TASKS, maxJobs: 2, nowFn: () => NOW }),
    ).resolves.toBeUndefined();
    expect(jobs.calls).toHaveLength(0);
    expect(s.kvGet("speculate:latest")).toBeUndefined();
  });

  it("passes the prior night's task titles to the planner as anti-repeat context", async () => {
    const s = new Store(":memory:");
    seedDream(s, TODAY);
    s.kvSet("speculate:latest", JSON.stringify({ date: "2026-06-16", tasks: [{ title: "yesterday", slug: "y", id: "yid" }] }));
    let seen: string[] = [];
    await runSpeculate({
      store: s, jobs: stubJobs(), maxJobs: 2, nowFn: () => NOW,
      plan: async (_inits, recent) => { seen = recent; return THREE_TASKS; },
    });
    expect(seen).toEqual(["yesterday"]);
  });

  it("isolates a failing createJob: remaining tasks still enqueue and only successes are stamped", async () => {
    const s = new Store(":memory:");
    seedDream(s, TODAY);
    let n = 0;
    const jobs: SpeculateJobs = {
      createJob() { // params intentionally unused here — fewer params still satisfies the interface
        n++;
        if (n === 1) throw new Error("boom"); // first task fails
        return { id: `id-${n}`, slug: `slug-${n}` };
      },
    };
    await runSpeculate({ store: s, jobs, plan: async () => THREE_TASKS, maxJobs: 2, nowFn: () => NOW });
    const saved = JSON.parse(s.kvGet("speculate:latest")!);
    expect(saved.tasks).toEqual([{ title: "T1", slug: "slug-2", id: "id-2" }]); // T0 dropped, T1 kept
  });
});
