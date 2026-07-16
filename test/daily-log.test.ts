// test/daily-log.test.ts — bus-subscriber daily logger + one-time backfill builder.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VaultWriter, localDate } from "../src/vault/writer.js";
import { makeDailyLogger, buildBackfillDays } from "../src/vault/daily-log.js";
import type { GoalRow } from "../src/store/db.js";

function vault(): VaultWriter {
  const w = new VaultWriter(mkdtempSync(join(tmpdir(), "vault-")), "AIOS");
  w.init();
  return w;
}
function todayBody(w: VaultWriter): string {
  const f = join(w.root, "daily", `${localDate()}.md`);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}
/** Minimal Store stub: getGoal returns whatever we seed. */
function store(goals: Record<string, Partial<GoalRow>>) {
  return { getGoal: (id: string) => goals[id] } as unknown as import("../src/store/db.js").Store;
}

describe("makeDailyLogger", () => {
  it("goal.created with a stamped goal_dir → started line with wiki-link", () => {
    const w = vault();
    const log = makeDailyLogger({ vault: w, store: store({ g1: { title: "Ship X", goal_dir: "2026-07-16-ship-x" } }) });
    log({ type: "goal.created", goalId: "g1", title: "Ship X", department: "eng" } as never);
    expect(todayBody(w)).toContain("goal started: [[goals/2026-07-16-ship-x/goal|Ship X]]");
  });

  it("goal.created before goal_dir stamped → plain title, no link", () => {
    const w = vault();
    const log = makeDailyLogger({ vault: w, store: store({ g1: { title: "Ship X", goal_dir: null } }) });
    log({ type: "goal.created", goalId: "g1", title: "Ship X", department: "eng" } as never);
    expect(todayBody(w)).toContain("goal started: Ship X");
    expect(todayBody(w)).not.toContain("[[");
  });

  it("done / failed / abandoned → terminal lines; failed carries a truncated error", () => {
    const w = vault();
    const g = { title: "T", goal_dir: "2026-07-16-t" };
    const log = makeDailyLogger({ vault: w, store: store({ g1: g, g2: g, g3: g }) });
    log({ type: "goal.status", goalId: "g1", status: "done" } as never);
    log({ type: "goal.status", goalId: "g2", status: "failed", error: "x".repeat(200) } as never);
    log({ type: "goal.status", goalId: "g3", status: "abandoned" } as never);
    const body = todayBody(w);
    expect(body).toContain("goal done: [[goals/2026-07-16-t/goal|T]]");
    expect(body).toMatch(/goal failed: \[\[goals\/2026-07-16-t\/goal\|T\]\] — x{80}(?!x)/); // 80-char cap
    expect(body).toContain("goal abandoned: [[goals/2026-07-16-t/goal|T]]");
  });

  it("non-goal events and running/awaiting-mail write nothing", () => {
    const w = vault();
    const log = makeDailyLogger({ vault: w, store: store({}) });
    log({ type: "goal.status", goalId: "g1", status: "running" } as never);
    log({ type: "routine.due", id: 1, name: "x", prompt: "y", channel: "", chatId: "" } as never);
    expect(todayBody(w)).toBe("");
  });

  it("unknown goalId → id-prefix fallback, still writes a line (never silently drops)", () => {
    const w = vault();
    const log = makeDailyLogger({ vault: w, store: store({}) });
    log({ type: "goal.status", goalId: "abcdef1234", status: "done" } as never);
    expect(todayBody(w)).toContain("goal done: abcdef12");
  });

  it("swallows a write/store error and logs it — never breaks the bus", () => {
    const logs: string[] = [];
    const badStore = { getGoal: () => { throw new Error("db gone"); } } as unknown as import("../src/store/db.js").Store;
    const log = makeDailyLogger({ vault: vault(), store: badStore, log: (m) => logs.push(m) });
    expect(() => log({ type: "goal.created", goalId: "g1", title: "T", department: "e" } as never)).not.toThrow();
    expect(logs[0]).toContain("daily-log:");
  });
});

describe("buildBackfillDays", () => {
  const row = (o: Partial<GoalRow>): GoalRow => ({
    id: "g", slug: "s", title: "T", request: "", department: "eng", lead: "", origin_channel: "",
    origin_chat_id: "", status: "done", project_dir: null, goal_dir: "2026-07-14-t", plan_summary: "",
    replans_used: 0, chain_depth: 0, spawned_by_mail: 0, error: "", created_at: "", updated_at: "", ...o,
  } as unknown as GoalRow);

  it("groups by LOCAL date, emits started+terminal for a done goal, skips existing dates", () => {
    const goals = [
      row({ id: "a", title: "A", status: "done", created_at: "2026-07-14T08:00:00", updated_at: "2026-07-14T09:30:00", goal_dir: "2026-07-14-a" }),
      row({ id: "b", title: "B", status: "running", created_at: "2026-07-15T10:00:00", updated_at: "2026-07-15T10:00:00", goal_dir: "2026-07-15-b" }),
    ];
    const days = buildBackfillDays(goals, new Set(["2026-07-15"])); // 07-15 already has a file
    expect([...days.keys()]).toEqual(["2026-07-14"]);               // 07-15 skipped
    const lines = days.get("2026-07-14")!;
    expect(lines[0]).toBe("- 08:00 goal started: [[goals/2026-07-14-a/goal|A]]");
    expect(lines[1]).toBe("- 09:30 goal done: [[goals/2026-07-14-a/goal|A]]");
  });

  it("a running goal contributes only a started line; lines within a day sort by time", () => {
    const goals = [
      row({ id: "b", title: "B", status: "running", created_at: "2026-07-14T11:00:00", updated_at: "2026-07-14T11:00:00", goal_dir: "2026-07-14-b" }),
      row({ id: "a", title: "A", status: "done", created_at: "2026-07-14T07:00:00", updated_at: "2026-07-14T12:00:00", goal_dir: "2026-07-14-a" }),
    ];
    const lines = buildBackfillDays(goals, new Set()).get("2026-07-14")!;
    expect(lines.map((l) => l.slice(2, 7))).toEqual(["07:00", "11:00", "12:00"]); // sorted
    expect(lines.filter((l) => l.includes("started")).length).toBe(2);
    expect(lines.filter((l) => l.includes("done")).length).toBe(1);
  });
});
