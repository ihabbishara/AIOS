// ui2/test/standup.test.ts — the tolerant standup parser and the day/exchange grouping.
// The awkward bodies here are copied VERBATIM out of data/aios.sqlite, not invented:
// a strict newline-anchored matcher scored 14 of 45 real standups as malformed, so
// idealised fixtures would have hidden exactly the bug this parser exists to avoid.
import { describe, it, expect } from "vitest";
import type { MailView } from "../src/api.js";
import { parseStandup, groupByDay, exchangesOf, stateOf, dayKey, windowStartIso } from "../src/lib/standup.js";

const CANONICAL = `Done: No research items completed; one outbound mail sent, no replies yet.
Today: Idle capacity — ready to pick up export-project or Middle East briefing research on request.
Blockers: None; no queued requests, awaiting tasking.`;

// real row — markdown bold, a "Here is the standup:" preamble, and an --- rule
const BOLDED_WITH_PREAMBLE = `Here is the standup:

---

**Done:** Completed USD outlook and near-term forecast report ($2.69 cost).
**Today:** No active tasks in flight — available for new assignments or follow-on analysis.
**Blockers:** None. Inbox clear, no queued requests pending.`;

// real row — all three fields inline on one line, with a trailing word count
const INLINE = `Done: nothing shipped in last 24h. Today: recall existing research index, then investigate top open question and persist a cited note under knowledge/. Blockers: none.

(29 words)`;

// real row — the agent echoed its own instructions before answering
const INSTRUCTION_ECHO = `Standup, 3 lines, plain text, ≤60 words. No tools needed.

**Done:** Marseille Airport→Aix transfer options (Jul 29 PM), La Belle export footprint + EU couscous/semolina sizing, Algeria export market research.
**Today:** File findings under knowledge/, verify sources for the Algeria-Europe export project.
**Blockers:** None.`;

const API_ERROR = "API Error: Unable to connect to API (ConnectionRefused)";

const mail = (o: Partial<MailView> & { id: string; createdAt: string }): MailView => ({
  from: "clio", to: "neo", kind: "standup", status: "read", body: CANONICAL,
  goalId: null, chainDepth: 1, readAt: null, error: null, ...o,
}) as MailView;

describe("parseStandup", () => {
  it("reads the canonical three-field body", () => {
    const r = parseStandup(CANONICAL);
    expect(r.kind).toBe("checkin");
    if (r.kind !== "checkin") return;
    expect(r.fields.done).toBe("No research items completed; one outbound mail sent, no replies yet.");
    expect(r.fields.today).toContain("Idle capacity");
    expect(r.fields.blockers).toBe("None; no queued requests, awaiting tasking.");
  });

  it("strips markdown bold, the --- rule and a narrated preamble", () => {
    const r = parseStandup(BOLDED_WITH_PREAMBLE);
    expect(r.kind).toBe("checkin");
    if (r.kind !== "checkin") return;
    expect(r.fields.done).toBe("Completed USD outlook and near-term forecast report ($2.69 cost).");
    expect(r.fields.done).not.toContain("*");
    expect(r.fields.done).not.toContain("Here is the standup");
    expect(r.fields.blockers).toBe("None. Inbox clear, no queued requests pending.");
  });

  it("splits the single-line inline form", () => {
    const r = parseStandup(INLINE);
    expect(r.kind).toBe("checkin");
    if (r.kind !== "checkin") return;
    expect(r.fields.done).toBe("nothing shipped in last 24h.");
    expect(r.fields.today).toBe("recall existing research index, then investigate top open question and persist a cited note under knowledge/.");
  });

  it("drops an echoed instruction preamble", () => {
    const r = parseStandup(INSTRUCTION_ECHO);
    expect(r.kind).toBe("checkin");
    if (r.kind !== "checkin") return;
    expect(r.fields.done).toContain("Marseille Airport");
    expect(r.fields.done).not.toContain("≤60 words");
  });

  it("classifies an API error as failed, not as an empty check-in", () => {
    const r = parseStandup(API_ERROR);
    expect(r.kind).toBe("failed");
    if (r.kind !== "failed") return;
    expect(r.reason).toBe("Unable to connect to API (ConnectionRefused)");
  });

  it("falls back to raw rather than inventing empty fields", () => {
    const r = parseStandup("Done: shipped it. Today: more of the same.");   // no Blockers
    expect(r.kind).toBe("raw");
    if (r.kind !== "raw") return;
    expect(r.body).toBe("Done: shipped it. Today: more of the same.");
  });

  it("keeps the first occurrence of a label when prose repeats it", () => {
    const r = parseStandup("Done: shipped. Today: rest. Blockers: none. Today: ignored.");
    expect(r.kind).toBe("checkin");
    if (r.kind !== "checkin") return;
    expect(r.fields.today).toBe("rest.");
    expect(r.fields.blockers).toBe("none. Today: ignored.");
  });
});

describe("groupByDay", () => {
  const now = new Date("2026-08-03T12:00:00.000Z");

  it("returns a contiguous window with silent days present as empty cells", () => {
    const cells = groupByDay([mail({ id: "a", createdAt: "2026-08-03T05:00:00.000Z" })], now, 5);
    expect(cells).toHaveLength(5);
    expect(cells.map((c) => c.date)).toEqual([
      "2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02", "2026-08-03",
    ]);
    expect(cells.filter((c) => c.state === "silent")).toHaveLength(4);
    expect(cells[4].state).toBe("checked");
  });

  it("marks a morning failed when any agent's standup errored", () => {
    const cells = groupByDay([
      mail({ id: "a", from: "clio", createdAt: "2026-08-01T05:00:00.000Z", body: API_ERROR }),
      mail({ id: "b", from: "athena", createdAt: "2026-08-01T04:00:00.000Z", body: CANONICAL }),
    ], now, 5);
    const aug1 = cells.find((c) => c.date === "2026-08-01");
    expect(aug1?.state).toBe("failed");
    expect(aug1?.entries).toHaveLength(2);
    expect(aug1?.entries[0].agent).toBe("athena");  // ordered by time within the day
  });

  it("ignores non-standup mail", () => {
    const cells = groupByDay([
      mail({ id: "r", kind: "report", createdAt: "2026-08-03T05:00:00.000Z", body: "Done: x" }),
    ], now, 3);
    expect(cells.every((c) => c.state === "silent")).toBe(true);
  });

  it("buckets by the UTC date the store groups on", () => {
    expect(dayKey("2026-08-03T05:15:15.901Z")).toBe("2026-08-03");
  });

  it("windowStartIso is midnight UTC of the oldest cell groupByDay renders", () => {
    const cells = groupByDay([], now, 30);
    expect(windowStartIso(now, 30)).toBe("2026-07-05T00:00:00.000Z");
    // The fetch bound and the drawn bound must be the same day, or the strip claims days
    // it was never sent rows for.
    expect(windowStartIso(now, 30).slice(0, 10)).toBe(cells[0].date);
    expect(windowStartIso(now, 5).slice(0, 10)).toBe(groupByDay([], now, 5)[0].date);
  });

  it("stateOf distinguishes all three states", () => {
    expect(stateOf([])).toBe("silent");
    expect(stateOf([{ agent: "a", at: "", parsed: { kind: "checkin", fields: { done: "", today: "", blockers: "" } } }])).toBe("checked");
    expect(stateOf([{ agent: "a", at: "", parsed: { kind: "failed", reason: "x" } }])).toBe("failed");
  });
});

describe("exchangesOf", () => {
  it("groups a request with its reports under the goal, newest exchange first", () => {
    const rows = [
      mail({ id: "1", kind: "request", goalId: "g1", from: "vulcan", to: "atlas", createdAt: "2026-07-28T10:00:00.000Z" }),
      mail({ id: "2", kind: "report", goalId: "g1", from: "atlas", to: "vulcan", createdAt: "2026-07-28T11:00:00.000Z" }),
      mail({ id: "3", kind: "report", goalId: "g1", from: "atlas", to: "vulcan", createdAt: "2026-07-28T12:00:00.000Z" }),
      mail({ id: "4", kind: "request", goalId: "g2", from: "neo", to: "odin", createdAt: "2026-07-30T09:00:00.000Z" }),
    ];
    const ex = exchangesOf(rows);
    expect(ex).toHaveLength(2);
    expect(ex[0].goalId).toBe("g2");                     // newest first
    expect(ex[1].goalId).toBe("g1");
    expect(ex[1].request?.id).toBe("1");
    expect(ex[1].reports.map((r) => r.id)).toEqual(["2", "3"]);
  });

  it("lets goal-less mail stand alone instead of dropping it", () => {
    const ex = exchangesOf([mail({ id: "n1", kind: "note", goalId: null, createdAt: "2026-07-30T09:00:00.000Z" })]);
    expect(ex).toHaveLength(1);
    expect(ex[0].goalId).toBeNull();
    expect(ex[0].key).toBe("n1");
    expect(ex[0].reports.map((r) => r.id)).toEqual(["n1"]);   // no request, so it lands in reports
  });

  it("excludes standups from the work band", () => {
    expect(exchangesOf([mail({ id: "s", createdAt: "2026-08-03T05:00:00.000Z" })])).toHaveLength(0);
  });
});
