# Speculate report date-coupling fix (design)

Date: 2026-06-20
Status: approved, pre-implementation
Origin: deferred follow-up from the speculate-research cycle (PR #10), noted in
the project memory as a latent dead-link bug.

## Problem

The morning brief renders the speculate-research report link by reconstructing
the path from a date and a slug:

```
ref = `jobs/${reportDate}-${t.slug}/report.md`   // briefs.ts speculate block
```

`reportDate` is the LOCAL date stamped into `speculate:latest`
(`localParts(now).date` in `speculate.ts`). But the executor writes the job's
artifacts to a directory named with the UTC date:

```
jobDirName(slug) = `${today()}-${slug}`           // vault/writer.ts
today() = new Date().toISOString().slice(0, 10)   // UTC
```

`jobDirName` is computed at job RUN time (`jobs.ts` `runJob`, line 106) and is
never persisted. When the local date and the UTC date differ — the speculate
anchor reconfigured near local-midnight, or the job write crossing
UTC-midnight — the brief's reconstructed link points at a directory that does
not exist, while the real report sits under the UTC-dated directory. The link
404s even though the report is fine.

This affects speculate-**research** only. The speculate-email-drafts pass writes
no job/report (it queues `email.draft` actions), so it is unaffected.

## Approach

Persist the real run-time `jobDirName` on the job row, and have the brief read
it instead of reconstructing the path from a date. This removes the
date-reconstruction entirely, so there is no coupling left to drift.

**Rejected alternatives:**
- Predict the directory name at `createJob` time and stamp it into
  `speculate:latest`. The directory is chosen at RUN time from `today()`, so
  predicting it at create time re-introduces the same date coupling (and would
  drift if the job runs on a different calendar day than it was created).
- Switch the executor's `today()` to a local date so it matches the brief.
  That changes the vault directory layout for EVERY job, not just speculate —
  a broad, unnecessary blast radius.

## Changes

### 1. `src/store/db.ts`

- **Migration:** `ALTER TABLE jobs ADD COLUMN job_dir TEXT` wrapped in
  try/catch (column-already-exists is swallowed), mirroring the existing
  `expenses ADD COLUMN receipt_path` migration at db.ts:150-154. Idempotent on
  re-open.
- **`JobRow`:** add `job_dir: string | null`.
- **`getJob`:** ensure the new column is mapped onto the returned `JobRow`
  (if `getJob` selects/maps explicit columns rather than `SELECT *`, add
  `job_dir`).
- **New `setJobDir(id: string, dir: string): void`:**
  `UPDATE jobs SET job_dir = ?, updated_at = ? WHERE id = ?` — mirrors
  `updateJobStatus` (db.ts:307).
- `insertJob` is unchanged; `job_dir` is NULL until the job runs.

### 2. `src/engine/jobs.ts` — `runJob`

Immediately after `const jobDirName = vault.jobDirName(job.slug)` (line 106):

```ts
store.setJobDir(job.id, jobDirName);
```

The directory is recorded the moment it is chosen, before any artifact is
written.

### 3. `src/heartbeat/briefs.ts` — speculate block

The block already fetches `const job = store.getJob(t.id)` for status. Replace
the date-reconstruction with:

```ts
const ref = job?.status === "done" && job.job_dir
  ? `jobs/${job.job_dir}/report.md`
  : null;
```

Drop the `reportDate` variable. A `done` job with no `job_dir` (a legacy job
that completed before this migration, or any edge where the dir wasn't stamped)
renders as title-only — never a dead `— null` link. The render line for a done
result must therefore tolerate a null `ref` (show the title alone).

### 4. Tests

- `setJobDir` persists and `getJob` returns it.
- Migration is idempotent: open a Store, then open another over the same DB —
  no error, column present.
- Brief builds the report ref from `job_dir`, NOT the date: persist a `job_dir`
  whose date component differs from what the old local-date reconstruction
  would produce, and assert the brief's ref uses `job_dir`.
- A `done` job with `job_dir = null` produces no dead link (title-only, no
  `report.md` path).
- Existing speculate-brief tests still pass (the happy path where `job_dir`
  matches the date).

## Scope

~2 tasks (persist the dir; consume it in the brief), ~6-8 tests, no new
dependencies. Touches `briefs.ts` (the recurring WIP-overlap file — resolved by
the stash→merge→pop 3-way at deploy, as in prior cycles).

## Out of scope

- Backfilling `job_dir` for historical jobs (legacy done-jobs simply render
  title-only — acceptable; their reports predate this surface).
- The daily-note job links (`appendDaily`) already use the live `jobDirName` at
  write time and are correct — untouched.
