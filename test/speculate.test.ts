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
});
