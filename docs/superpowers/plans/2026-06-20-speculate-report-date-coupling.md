# Speculate Report Date-Coupling Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist each job's real run-time vault directory on the job row so the morning brief links to the actual speculate-research report instead of reconstructing the path from a date that can drift across the UTC/local day boundary.

**Architecture:** Add a `job_dir` column to the `jobs` table; `runJob` stamps it the moment the directory name is chosen (`vault.jobDirName(slug)`); the brief reads `job.job_dir` instead of rebuilding `jobs/<local-date>-<slug>`.

**Tech Stack:** TypeScript, Node 23 `node:sqlite` (`DatabaseSync`), vitest.

## Global Constraints

- Node built-in `node:sqlite` only — never better-sqlite3. Schema migrations on existing DBs use `ALTER TABLE … ADD COLUMN` wrapped in try/catch (column-already-exists swallowed), mirroring the `expenses ADD COLUMN receipt_path` migration at `src/store/db.ts:150-154`.
- Subscription auth via `CLAUDE_CODE_OAUTH_TOKEN` — never `ANTHROPIC_API_KEY`.
- Commit EXPLICIT paths only — NEVER `git add -A`/`-am`. An uncommitted pdf-attachments WIP lives in the working tree (it overlaps `src/heartbeat/briefs.ts` and `src/index.ts`); never stage it. The worktree builds off clean committed HEAD, so it will NOT contain that WIP.
- `today()` (`src/vault/writer.ts`) is UTC (`new Date().toISOString().slice(0,10)`); `jobDirName(slug) = \`${today()}-${slug}\``. The brief currently uses the LOCAL date (`localParts`). This fix removes the brief's date reconstruction entirely.
- Affects speculate-RESEARCH report links only. The speculate-email-drafts pass writes no job/report.

---

## File Structure

| File | Responsibility | New/Modify |
| --- | --- | --- |
| `src/store/db.ts` | `job_dir` column + `JobRow.job_dir` + `setJobDir` | Modify |
| `src/engine/jobs.ts` | stamp `job_dir` at run time | Modify |
| `src/heartbeat/briefs.ts` | read `job_dir` for the report ref (WIP-overlap) | Modify |
| `test/job-dir.test.ts` | persist + job-run integration | **New** |
| `test/speculate-brief.test.ts` | brief reads `job_dir`, no dead link | Modify |

---

## Task 1: Persist `job_dir` on the job row

**Files:**
- Modify: `src/store/db.ts` (`JobRow` ~line 10; migration cluster ~line 154; new `setJobDir` near `updateJobStatus` ~line 307)
- Modify: `src/engine/jobs.ts` (`runJob`, after line 106)
- Test: `test/job-dir.test.ts` (new)

**Interfaces:**
- Produces: `JobRow.job_dir: string | null`; `Store.setJobDir(id: string, dir: string): void`.
- Consumes: `Store.insertJob`, `Store.getJob` (already `SELECT *`), `vault.jobDirName(slug)`.

- [ ] **Step 1: Write the failing tests** — create `test/job-dir.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { JobManager } from "../src/engine/jobs.js";
import type { Playbook } from "../src/engine/playbook.js";

function seedJob(s: Store, id: string) {
  s.insertJob({
    id, slug: "alpha", title: "Alpha", playbook: "research-report", request: "q",
    project_dir: null, channel: "system", chat_id: "x", status: "queued", error: null,
  });
}

describe("job_dir persistence", () => {
  it("setJobDir stores the dir and getJob returns it; null until set", () => {
    const s = new Store(":memory:");
    seedJob(s, "j1");
    expect(s.getJob("j1")!.job_dir).toBeNull();
    s.setJobDir("j1", "2026-06-20-alpha");
    expect(s.getJob("j1")!.job_dir).toBe("2026-06-20-alpha");
  });

  it("migration is idempotent — reopening a file-backed DB does not throw and keeps data", () => {
    const dir = mkdtempSync(join(tmpdir(), "aios-db-"));
    const path = join(dir, "t.sqlite");
    const a = new Store(path);
    seedJob(a, "j1");
    a.setJobDir("j1", "2026-06-20-alpha");
    const b = new Store(path); // re-runs the ALTER (caught) on an existing table
    expect(b.getJob("j1")!.job_dir).toBe("2026-06-20-alpha");
    rmSync(dir, { recursive: true, force: true });
  });

  it("runJob stamps job_dir = vault.jobDirName(slug) when a job completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "aios-vault-"));
    const store = new Store(":memory:");
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    const pb: Playbook = {
      name: "research-report", description: "d", needsProjectDir: false,
      stages: [{ type: "single", id: "report", role: "researcher" }],
    };
    let done!: () => void;
    const finished = new Promise<void>((r) => { done = r; });
    const jm = new JobManager({
      store, vault,
      run: (async () => ({ text: "the report", costUsd: 0, numTurns: 1 })) as never,
      playbooks: new Map([["research-report", pb]]),
      wallTimeMs: 60_000, maxConcurrent: 1,
      onComplete: async () => { done(); },
    });
    const job = jm.createJob({ playbook: "research-report", title: "Alpha", request: "q", channel: "system", chatId: "x" });
    await finished;
    const row = store.getJob(job.id)!;
    expect(row.status).toBe("done");
    expect(row.job_dir).toBe(vault.jobDirName("alpha")); // `${UTC-today}-alpha`
    rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/job-dir.test.ts`
Expected: FAIL — `setJobDir` is not a function / `job_dir` undefined.

- [ ] **Step 3: Add `job_dir` to `JobRow`** — in `src/store/db.ts`, in the `JobRow` interface, after `project_dir: string | null;` (line 16):

```ts
  /** The vault directory `<UTC-date>-<slug>` where this job's artifacts live; stamped at run time. */
  job_dir: string | null;
```

- [ ] **Step 4: Add the migration** — in `src/store/db.ts`, immediately after the existing `expenses ADD COLUMN receipt_path` try/catch (the block ending at line 154):

```ts
    // Migration: persist the run-time job directory so links don't reconstruct from a date.
    try {
      this.db.exec("ALTER TABLE jobs ADD COLUMN job_dir TEXT");
    } catch {
      /* column already exists */
    }
```

- [ ] **Step 5: Add `setJobDir`** — in `src/store/db.ts`, right after `updateJobStatus` (ends at line 311):

```ts
  setJobDir(id: string, dir: string): void {
    this.db
      .prepare("UPDATE jobs SET job_dir = ?, updated_at = ? WHERE id = ?")
      .run(dir, new Date().toISOString(), id);
  }
```

(`getJob` and `listJobs` use `SELECT *`, so they return `job_dir` automatically. `insertJob` lists columns explicitly and does not set `job_dir`, so it inserts NULL — leave it.)

- [ ] **Step 6: Stamp `job_dir` in `runJob`** — in `src/engine/jobs.ts`, in `runJob`, immediately after `const jobDirName = vault.jobDirName(job.slug);` (line 106):

```ts
    store.setJobDir(job.id, jobDirName);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/job-dir.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/store/db.ts src/engine/jobs.ts test/job-dir.test.ts
git commit -m "feat(jobs): persist run-time job_dir on the job row"
```

---

## Task 2: Brief reads `job_dir` for the report ref

**Files:**
- Modify: `src/heartbeat/briefs.ts` (the `speculateResults` block ~lines 129-148; `renderBriefNote` "Speculate — researched overnight" section ~lines 216-218)
- Test: `test/speculate-brief.test.ts` (modify)

**Interfaces:**
- Consumes: `JobRow.job_dir` (Task 1), `Store.setJobDir` (Task 1), `store.getJob`.

- [ ] **Step 1: Update + extend the tests** — in `test/speculate-brief.test.ts`:

First, update the `insertJob` helper to accept an optional `jobDir` and stamp it:

```ts
function insertJob(s: Store, id: string, slug: string, status: JobRow["status"], jobDir?: string) {
  s.insertJob({
    id, slug, title: slug[0].toUpperCase() + slug.slice(1), playbook: "research-report",
    request: "q", project_dir: null, channel: "system", chat_id: "speculate", status, error: null,
  });
  if (jobDir) s.setJobDir(id, jobDir);
}
```

(Match the existing helper's exact `insertJob({...})` field set — only add the trailing `if (jobDir) s.setJobDir(...)` and the `jobDir?` param. Keep the title derivation the helper already uses.)

In the existing "done/failed/running" test, give the done job a `job_dir` so its ref still resolves — change its insert to:

```ts
    insertJob(s, "id-done", "alpha", "done", `${TODAY}-alpha`);
```

(The existing assertions `ref: jobs/${TODAY}-alpha/report.md` and the rendered-note regex then still hold — now sourced from `job_dir`.)

Then add two new tests:

```ts
  it("builds the report ref from job_dir, not the brief's local date (decoupled)", () => {
    const s = new Store(":memory:");
    insertJob(s, "id-done", "alpha", "done", "2099-01-01-alpha"); // job_dir date != TODAY
    s.kvSet("speculate:latest", JSON.stringify({ date: TODAY, tasks: [{ title: "Alpha", slug: "alpha", id: "id-done" }] }));
    const data = assembleBrief(s, "morning", new Date(`${TODAY}T07:30:00.000Z`).toISOString(), null);
    expect(data.speculateResults![0].ref).toBe("jobs/2099-01-01-alpha/report.md");
  });

  it("a done job with no job_dir renders title-only — no dead link", () => {
    const s = new Store(":memory:");
    insertJob(s, "id-done", "alpha", "done"); // no job_dir stamped
    s.kvSet("speculate:latest", JSON.stringify({ date: TODAY, tasks: [{ title: "Alpha", slug: "alpha", id: "id-done" }] }));
    const data = assembleBrief(s, "morning", new Date(`${TODAY}T07:30:00.000Z`).toISOString(), null);
    expect(data.speculateResults![0].ref).toBeNull();
    const note = renderBriefNote(data, "n");
    expect(note).toContain("Alpha");
    expect(note).not.toContain("report.md");
    expect(note).not.toContain("Alpha — null");
  });
```

(If `renderBriefNote` / `JobRow` are not already imported in this test file, add them: `import { assembleBrief, renderBriefNote } from "../src/heartbeat/briefs.js";` and `import type { JobRow } from "../src/store/db.js";`. `TODAY` is already defined in the file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/speculate-brief.test.ts`
Expected: FAIL — the decoupled test expects `jobs/2099-01-01-alpha/report.md` but the current code builds `jobs/${TODAY}-alpha/...`; the no-job_dir test expects `ref` null but current code returns a date-based path.

- [ ] **Step 3: Read `job_dir` in the brief block** — in `src/heartbeat/briefs.ts`, in the `speculateResults` map (lines ~136-144), remove the `reportDate` line and change the `ref` line. Replace:

```ts
          const reportDate = parsed.date; // string (checked above) — narrows for use inside the map closure
          speculateResults = parsed.tasks.map((t) => {
            const job = store.getJob(t.id);
            // queued, running, or job not yet written → "running" (brief shows in-progress)
            const status: "done" | "failed" | "running" =
              job?.status === "done" ? "done" : job?.status === "failed" ? "failed" : "running";
            const ref = status === "done" ? `jobs/${reportDate}-${t.slug}/report.md` : null;
            return { title: t.title, status, ref };
          });
```

with:

```ts
          speculateResults = parsed.tasks.map((t) => {
            const job = store.getJob(t.id);
            // queued, running, or job not yet written → "running" (brief shows in-progress)
            const status: "done" | "failed" | "running" =
              job?.status === "done" ? "done" : job?.status === "failed" ? "failed" : "running";
            // Use the job's real persisted dir — never reconstruct from a date (UTC vs local drift).
            const ref = status === "done" && job?.job_dir ? `jobs/${job.job_dir}/report.md` : null;
            return { title: t.title, status, ref };
          });
```

- [ ] **Step 4: Render a done-without-ref result safely** — in `src/heartbeat/briefs.ts`, in `renderBriefNote`, the "Speculate — researched overnight" section (lines ~216-218). Replace:

```ts
  section("Speculate — researched overnight", (d.speculateResults ?? []).map((r) =>
    r.status === "done" ? `${r.title} — ${r.ref}` : r.status === "failed" ? `${r.title} — failed` : `${r.title} — still running`,
  ));
```

with:

```ts
  section("Speculate — researched overnight", (d.speculateResults ?? []).map((r) =>
    r.status === "done" ? (r.ref ? `${r.title} — ${r.ref}` : r.title)
      : r.status === "failed" ? `${r.title} — failed` : `${r.title} — still running`,
  ));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/speculate-brief.test.ts`
Expected: PASS (existing tests + 2 new).

- [ ] **Step 6: Type-check + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all green (baseline + the new job_dir/brief tests).

- [ ] **Step 7: Commit**

```bash
git add src/heartbeat/briefs.ts test/speculate-brief.test.ts
git commit -m "fix(speculate): brief links report via persisted job_dir, not a reconstructed date"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- `job_dir` column + migration (try/catch, mirrors expenses) → Task 1 Steps 3-4. ✓
- `JobRow.job_dir` + `getJob` returns it (`SELECT *`) → Task 1 Step 3 (+ note). ✓
- `setJobDir` (mirrors `updateJobStatus`) → Task 1 Step 5. ✓
- `runJob` stamps it after line 106 → Task 1 Step 6 + integration test. ✓
- brief reads `job_dir`, drops `reportDate` → Task 2 Step 3. ✓
- done-without-`job_dir` → title-only, no dead link → Task 2 Step 4 + test. ✓
- Tests: setJobDir persist, migration idempotent, run stamps dir, brief decoupled from date, no dead link → Tasks 1-2. ✓

**Placeholder scan:** none — every code step shows complete code. ✓

**Type consistency:** `job_dir: string | null` identical across `JobRow`, `setJobDir`, the brief read, and all tests; `setJobDir(id, dir)` signature identical in db.ts + jobs.ts call + tests. The job-run stub returns `{text, costUsd, numTurns}` (matches what `executor.runAgent` reads: `res.text`, `res.costUsd`, `res.numTurns`); cast `as never` follows the existing `pack-loader.test.ts` stub idiom. ✓

**Deploy note (post-merge, not a task):** `briefs.ts` is the WIP-overlap file — the deploy `stash → merge → pop` 3-way resolves it as in prior cycles. `db.ts`/`jobs.ts` are not in the WIP, so no new overlap.
