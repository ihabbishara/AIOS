import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type JobStatus = "queued" | "running" | "done" | "failed";
export type StageStatus = "running" | "done" | "failed";

export interface JobRow {
  id: string;
  slug: string;
  title: string;
  playbook: string;
  request: string;
  project_dir: string | null;
  channel: string;
  chat_id: string;
  status: JobStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface StageRow {
  job_id: string;
  stage_id: string;
  status: StageStatus;
  started_at: string;
  finished_at: string | null;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        playbook TEXT NOT NULL,
        request TEXT NOT NULL,
        project_dir TEXT,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stages (
        job_id TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY (job_id, stage_id)
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ledger TEXT NOT NULL,
        payer TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'EUR',
        description TEXT NOT NULL,
        date TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    // Migration: receipt evidence path (added after initial release).
    try {
      this.db.exec("ALTER TABLE expenses ADD COLUMN receipt_path TEXT");
    } catch {
      /* column already exists */
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
  }

  insertJob(job: Omit<JobRow, "created_at" | "updated_at">): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs (id, slug, title, playbook, request, project_dir, channel, chat_id, status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id, job.slug, job.title, job.playbook, job.request,
        job.project_dir, job.channel, job.chat_id, job.status, job.error,
        now, now,
      );
  }

  updateJobStatus(id: string, status: JobStatus, error?: string): void {
    this.db
      .prepare("UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, error ?? null, new Date().toISOString(), id);
  }

  getJob(id: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  }

  listJobs(limit = 20): JobRow[] {
    return this.db
      .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as JobRow[];
  }

  unfinishedJobs(): JobRow[] {
    return this.db
      .prepare("SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at ASC")
      .all() as unknown as JobRow[];
  }

  stageStart(jobId: string, stageId: string): void {
    this.db
      .prepare(
        `INSERT INTO stages (job_id, stage_id, status, started_at, finished_at)
         VALUES (?, ?, 'running', ?, NULL)
         ON CONFLICT(job_id, stage_id) DO UPDATE SET status='running', started_at=excluded.started_at, finished_at=NULL`,
      )
      .run(jobId, stageId, new Date().toISOString());
  }

  stageFinish(jobId: string, stageId: string, status: StageStatus): void {
    this.db
      .prepare("UPDATE stages SET status = ?, finished_at = ? WHERE job_id = ? AND stage_id = ?")
      .run(status, new Date().toISOString(), jobId, stageId);
  }

  completedStages(jobId: string): Set<string> {
    const rows = this.db
      .prepare("SELECT stage_id FROM stages WHERE job_id = ? AND status = 'done'")
      .all(jobId) as unknown as Array<{ stage_id: string }>;
    return new Set(rows.map((r) => r.stage_id));
  }

  addExpense(e: {
    ledger: string;
    payer: string;
    amountCents: number;
    currency: string;
    description: string;
    date: string;
    receiptPath?: string;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO expenses (ledger, payer, amount_cents, currency, description, date, created_at, receipt_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.ledger, e.payer, e.amountCents, e.currency, e.description, e.date,
        new Date().toISOString(), e.receiptPath ?? null,
      );
    return Number(res.lastInsertRowid);
  }

  deleteExpense(ledger: string, id: number): boolean {
    const res = this.db.prepare("DELETE FROM expenses WHERE ledger = ? AND id = ?").run(ledger, id);
    return res.changes > 0;
  }

  listExpenses(ledger: string, monthPrefix?: string): Array<{
    id: number;
    payer: string;
    amount_cents: number;
    currency: string;
    description: string;
    date: string;
    receipt_path: string | null;
  }> {
    const rows = monthPrefix
      ? this.db
          .prepare("SELECT * FROM expenses WHERE ledger = ? AND date LIKE ? ORDER BY date, id")
          .all(ledger, `${monthPrefix}%`)
      : this.db.prepare("SELECT * FROM expenses WHERE ledger = ? ORDER BY date, id").all(ledger);
    return rows as never;
  }

  addEvent(payload: string): number {
    const res = this.db
      .prepare("INSERT INTO events (ts, payload) VALUES (?, ?)")
      .run(new Date().toISOString(), payload);
    return Number(res.lastInsertRowid);
  }

  listEvents(sinceId = 0, limit = 500): Array<{ id: number; ts: string; payload: string }> {
    return this.db
      .prepare("SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?")
      .all(sinceId, limit)
      .reverse() as unknown as Array<{ id: number; ts: string; payload: string }>;
  }

  listStages(jobId: string): Array<{ stage_id: string; status: string; started_at: string; finished_at: string | null }> {
    return this.db
      .prepare("SELECT stage_id, status, started_at, finished_at FROM stages WHERE job_id = ? ORDER BY started_at")
      .all(jobId) as never;
  }

  kvGet(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  kvSet(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
