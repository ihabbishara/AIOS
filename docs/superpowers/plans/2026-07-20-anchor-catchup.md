# Cross-Midnight Anchor Catch-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An anchor missed across midnight (daemon down at fire time, back the next day) catches up exactly once after 08:00 local, without swallowing that day's normal fire.

**Architecture:** `anchorDue` becomes occurrence-based — it returns the occurrence date the fire covers (today, or yesterday for a cross-midnight catch-up) instead of a boolean. `Clock.tick` stamps `anchor:<name>:last` with that returned occurrence rather than today's date; this is the load-bearing change that lets a morning catch-up coexist with the same evening's normal fire. A quiet-hours gate (`catchupAfter`, default "08:00", env `AIOS_CATCHUP_AFTER`) holds yesterday-occurrence fires until daytime so briefs never ping at 03:00.

**Tech Stack:** TypeScript (existing daemon), vitest, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-20-anchor-catchup-design.md`

## Global Constraints

- No new npm dependencies.
- Trunk-based: commit on main, explicit file paths only in `git add` (parallel session shares this checkout).
- Route wiring stays thin/untested; logic carries tests in root `test/` (vitest).
- Do not trust piped vitest exit codes — read the "Tests" summary line.
- Deploy: `npm run build && launchctl kickstart -k gui/501/com.ihab.aios`, then poll `/api/state`.
- Do NOT force-fire anchors off-hours to "verify live" — tests carry the proof.

---

### Task 1: Occurrence-based `anchorDue` + `yesterdayOf` helper

**Files:**
- Modify: `src/heartbeat/clock.ts:34-41` (replace `anchorDue`, add `yesterdayOf`)
- Test: `test/clock.test.ts` (update `anchorDue` describe block, add cross-midnight cases)

**Interfaces:**
- Consumes: `localParts` (already in clock.ts).
- Produces: `anchorDue(now: {date,hhmm}, anchorHHMM: string, lastFiredDate: string | undefined, catchupAfter?: string): string | null` — returns the covered occurrence date (`"YYYY-MM-DD"`) or `null`. `yesterdayOf(date: string): string` exported. Task 2 relies on both exact signatures.

- [ ] **Step 1: Update existing tests + write failing cross-midnight tests**

Replace the `describe("anchorDue", ...)` block in `test/clock.test.ts` (lines 14-29) with:

```ts
describe("yesterdayOf", () => {
  it("handles plain, month-rollover, and year-rollover dates", () => {
    expect(yesterdayOf("2026-06-12")).toBe("2026-06-11");
    expect(yesterdayOf("2026-07-01")).toBe("2026-06-30");
    expect(yesterdayOf("2026-01-01")).toBe("2025-12-31");
  });
});

describe("anchorDue", () => {
  const now = { date: "2026-06-12", hhmm: "07:30" };
  it("due when time reached and not yet fired today — returns today's occurrence", () => {
    expect(anchorDue(now, "07:30", undefined)).toBe("2026-06-12");
    expect(anchorDue(now, "07:30", "2026-06-11")).toBe("2026-06-12");
  });
  it("not due before the anchor time (last fired yesterday — that occurrence is covered)", () => {
    expect(anchorDue({ ...now, hhmm: "07:29" }, "07:30", "2026-06-11")).toBeNull();
  });
  it("not due when already fired today (fire-once)", () => {
    expect(anchorDue(now, "07:30", "2026-06-12")).toBeNull();
  });
  it("same-day catch-up: hours past the anchor still fires once", () => {
    expect(anchorDue({ ...now, hhmm: "23:59" }, "07:30", undefined)).toBe("2026-06-12");
  });
  it("cross-midnight catch-up: missed yesterday's occurrence fires after the gate", () => {
    // evening 21:00 missed on 06-12; daemon back 06-13 09:00
    expect(anchorDue({ date: "2026-06-13", hhmm: "09:00" }, "21:00", "2026-06-11")).toBe("2026-06-12");
  });
  it("cross-midnight catch-up is gated before catchupAfter", () => {
    expect(anchorDue({ date: "2026-06-13", hhmm: "03:00" }, "21:00", "2026-06-11")).toBeNull();
    expect(anchorDue({ date: "2026-06-13", hhmm: "08:00" }, "21:00", "2026-06-11")).toBe("2026-06-12"); // boundary: >= fires
  });
  it("the gate never blocks a today-occurrence fire", () => {
    // dream 02:00, daemon restarts 03:00 — occurrence is today, fires despite hhmm < 08:00
    expect(anchorDue({ date: "2026-06-13", hhmm: "03:00" }, "02:00", "2026-06-12")).toBe("2026-06-13");
  });
  it("multi-day outage catches up a single occurrence (yesterday), never stacks", () => {
    expect(anchorDue({ date: "2026-06-13", hhmm: "09:00" }, "21:00", "2026-06-01")).toBe("2026-06-12");
  });
  it("undefined lastFiredDate before anchor time still catches up yesterday after the gate", () => {
    expect(anchorDue({ date: "2026-06-13", hhmm: "09:00" }, "21:00", undefined)).toBe("2026-06-12");
  });
  it("custom catchupAfter is honored", () => {
    expect(anchorDue({ date: "2026-06-13", hhmm: "09:00" }, "21:00", "2026-06-11", "10:00")).toBeNull();
    expect(anchorDue({ date: "2026-06-13", hhmm: "10:00" }, "21:00", "2026-06-11", "10:00")).toBe("2026-06-12");
  });
});
```

Update the import at `test/clock.test.ts:4`:

```ts
import { localParts, anchorDue, yesterdayOf, Clock } from "../src/heartbeat/clock.js";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/clock.test.ts`
Expected: FAIL — `yesterdayOf` not exported; `anchorDue` returns booleans, assertions on strings/null fail. (Read the "Tests" summary line, not the exit code.)

- [ ] **Step 3: Implement occurrence-based `anchorDue` + `yesterdayOf`**

Replace `src/heartbeat/clock.ts` lines 34-41 (the doc comment + `anchorDue`) with:

```ts
/** Local date one day before `date` ("YYYY-MM-DD"), month/year rollover included. */
export function yesterdayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return localParts(new Date(y, m - 1, d - 1)).date;
}

/**
 * Returns the occurrence date this fire covers, or null when not due.
 * Occurrence is today once the anchor time has passed, else yesterday —
 * so an outage spanning midnight catches up exactly once. Yesterday
 * occurrences (catch-ups) are additionally held until `catchupAfter`
 * local time so brief anchors never ping in the small hours.
 */
export function anchorDue(
  now: { date: string; hhmm: string },
  anchorHHMM: string,
  lastFiredDate: string | undefined,
  catchupAfter = "08:00",
): string | null {
  const occurrence = now.hhmm >= anchorHHMM ? now.date : yesterdayOf(now.date);
  if ((lastFiredDate ?? "") >= occurrence) return null;
  if (occurrence < now.date && now.hhmm < catchupAfter) return null;
  return occurrence;
}
```

Note: `Clock.tick` at clock.ts:69 (`if (!anchorDue(...)) continue;`) keeps compiling — `string | null` truthiness — and normal same-day stamping behavior is unchanged. Occurrence stamping lands in Task 2.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/clock.test.ts`
Expected: PASS — all clock tests green, including untouched `Clock.tick` describes (normal fires stamp today, same as before).

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/clock.ts test/clock.test.ts
git commit -m "feat(heartbeat): occurrence-based anchorDue — cross-midnight catch-up with 08:00 gate"
```

---

### Task 2: `Clock.tick` stamps the covered occurrence; `catchupAfter` dep

**Files:**
- Modify: `src/heartbeat/clock.ts` (ClockDeps + tick anchor loop, lines ~11-24 and ~66-76)
- Test: `test/clock.test.ts` (new integration describe)

**Interfaces:**
- Consumes: `anchorDue(now, anchorHHMM, lastFiredDate, catchupAfter): string | null` from Task 1.
- Produces: `ClockDeps.catchupAfter?: string` (optional; `anchorDue`'s own default applies when omitted). Task 3 wires config into it.

- [ ] **Step 1: Write the failing integration test**

Append to the `describe("Clock.tick", ...)` block in `test/clock.test.ts` (after the kv-override describe is fine too — keep it a new top-level describe for clarity):

```ts
describe("Clock.tick — cross-midnight catch-up", () => {
  it("missed evening catches up after 08:00 next day with yesterday's stamp, then fires normally that night", async () => {
    const store = new Store(":memory:");
    const fired: string[] = [];
    let nowLocal = new Date(2026, 5, 13, 3, 0); // Jun 13 03:00 — daemon back after midnight
    const clock = new Clock({
      store,
      anchors: [
        { name: "morning", hhmm: "07:30" },
        { name: "evening", hhmm: "21:00" },
      ],
      onAnchor: async (name) => { fired.push(name); },
      onReminderDue: () => {},
      nowFn: () => nowLocal,
    });
    // Both fired normally Jun 11; daemon down before Jun 12 21:00 through midnight.
    store.kvSet("anchor:morning:last", "2026-06-12"); // morning DID fire Jun 12
    store.kvSet("anchor:evening:last", "2026-06-11"); // evening missed Jun 12

    await clock.tick(); // 03:00 — catch-up gated, nothing fires
    expect(fired).toEqual([]);

    nowLocal = new Date(2026, 5, 13, 8, 30); // 08:30 — gate open
    await clock.tick();
    expect(fired).toEqual(["morning", "evening"]); // morning = today's normal fire; evening = catch-up
    expect(store.kvGet("anchor:morning:last")).toBe("2026-06-13");
    expect(store.kvGet("anchor:evening:last")).toBe("2026-06-12"); // stamped occurrence, NOT today

    nowLocal = new Date(2026, 5, 13, 21, 5); // tonight's normal evening
    await clock.tick();
    expect(fired).toEqual(["morning", "evening", "evening"]); // catch-up did not swallow it
    expect(store.kvGet("anchor:evening:last")).toBe("2026-06-13");
  });

  it("deps.catchupAfter overrides the default gate", async () => {
    const store = new Store(":memory:");
    const fired: string[] = [];
    const clock = new Clock({
      store,
      anchors: [{ name: "evening", hhmm: "21:00" }],
      catchupAfter: "06:00",
      onAnchor: async (name) => { fired.push(name); },
      onReminderDue: () => {},
      nowFn: () => new Date(2026, 5, 13, 6, 30), // 06:30 — open under 06:00 gate, shut under default 08:00
    });
    store.kvSet("anchor:evening:last", "2026-06-11");
    await clock.tick();
    expect(fired).toEqual(["evening"]);
    expect(store.kvGet("anchor:evening:last")).toBe("2026-06-12");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/clock.test.ts`
Expected: FAIL — first test's evening stamp is `"2026-06-13"` (tick still stamps `parts.date`); second test fails on `catchupAfter` not being a ClockDeps property (TS error) / gate not applied.

- [ ] **Step 3: Implement occurrence stamping + dep**

In `src/heartbeat/clock.ts`, add to `ClockDeps` (after the `anchors` field):

```ts
  /** Local "HH:MM" before which cross-midnight catch-ups hold (default 08:00). */
  catchupAfter?: string;
```

Replace the anchor loop body in `tick()` (currently lines 66-76):

```ts
      for (const anchor of this.deps.anchors) {
        const key = `anchor:${anchor.name}:last`;
        const hhmm = this.deps.store.kvGet(`anchor:${anchor.name}:hhmm`) ?? anchor.hhmm;
        const occurrence = anchorDue(parts, hhmm, this.deps.store.kvGet(key), this.deps.catchupAfter);
        if (!occurrence) continue;
        // Stamp the covered occurrence, not today — a morning catch-up of yesterday's
        // evening must not swallow tonight's fire. Stamp first: never retry a crashed brief.
        this.deps.store.kvSet(key, occurrence);
        try {
          await this.deps.onAnchor(anchor.name);
        } catch (err) {
          this.deps.log?.(`anchor ${anchor.name} failed: ${(err as Error).message}`);
        }
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/clock.test.ts`
Expected: PASS — all describes green (normal fires still stamp today because occurrence == today for them).

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/clock.ts test/clock.test.ts
git commit -m "feat(heartbeat): Clock stamps covered occurrence + catchupAfter dep"
```

---

### Task 3: Config wiring + full-suite gate + deploy

**Files:**
- Modify: `src/config.ts` (interface near line 77, defaults near line 252)
- Modify: `src/index.ts:631-639` (Clock construction)

**Interfaces:**
- Consumes: `ClockDeps.catchupAfter?: string` from Task 2.
- Produces: `config.catchupAfter: string` (env `AIOS_CATCHUP_AFTER`, default `"08:00"`).

- [ ] **Step 1: Add config field**

In `src/config.ts`, after the `anchorStandup: string;` interface line (~line 77):

```ts
  /** Local "HH:MM" before which cross-midnight anchor catch-ups hold (AIOS_CATCHUP_AFTER). */
  catchupAfter: string;
```

After the `anchorStandup:` default (~line 252):

```ts
    catchupAfter: process.env.AIOS_CATCHUP_AFTER ?? "08:00",
```

- [ ] **Step 2: Wire into Clock construction**

In `src/index.ts`, inside the `new Clock({...})` at line 631, after the `anchors: [...]` array:

```ts
    catchupAfter: config.catchupAfter,
```

- [ ] **Step 3: Typecheck both roots + full suite**

Run: `npx tsc --noEmit && (cd ui2 && npx tsc --noEmit); cd /Users/ihabbishara/projects/AIOS`
Expected: clean, no output. (cd persists in this harness — return to repo root.)

Run: `npx vitest run`
Expected: "Tests" summary line shows all passing (baseline was 1357+ across 185 files; count grows by the new clock tests). Read the summary line, not the exit code.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/index.ts
git commit -m "feat(config): AIOS_CATCHUP_AFTER — cross-midnight catch-up gate wired into Clock"
```

- [ ] **Step 5: Deploy + verify daemon healthy**

```bash
npm run build && launchctl kickstart -k gui/501/com.ihab.aios
```

Poll until ready (~3s):

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 10 -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/state | head -c 200
```

Expected: JSON state response. Then check `tail -20 data/aios.err.log` for startup errors and confirm anchor stamps untouched:

```bash
sqlite3 data/aios.sqlite "SELECT key,value FROM kv WHERE key LIKE 'anchor:%:last';"
```

Expected: same values as pre-deploy (morning/dream/speculate/standup = 2026-07-20, evening = 2026-07-19). Evening due tonight 21:00 as normal (occurrence = today > 2026-07-19; restart must NOT have fired it early — 14:xx < 21:00 means occurrence for evening is yesterday 2026-07-19 == stamp → correctly not due; the gate case is already stamped-covered). Do NOT force-fire.

- [ ] **Step 6: Push**

```bash
git push origin main
```
