import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TrustRecord } from "../kernel/trust.js";
import type { ActionRow, ActionStatus } from "../kernel/actions.js";

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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trust (
        action_type TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        approvals INTEGER NOT NULL DEFAULT 0,
        rejections INTEGER NOT NULL DEFAULT 0,
        streak INTEGER NOT NULL DEFAULT 0,
        first_seen TEXT NOT NULL,
        last_rejection TEXT,
        graduated_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        preview TEXT NOT NULL,
        status TEXT NOT NULL,
        origin_channel TEXT NOT NULL,
        origin_chat_id TEXT NOT NULL,
        trust_state TEXT NOT NULL,
        verdict_by TEXT,
        reject_reason TEXT,
        result TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
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

  // ---- trust ledger ----

  getTrust(actionType: string): TrustRecord | undefined {
    const r = this.db.prepare("SELECT * FROM trust WHERE action_type = ?").get(actionType) as
      | Record<string, unknown>
      | undefined;
    return r ? toTrustRecord(r) : undefined;
  }

  listTrust(): TrustRecord[] {
    return (this.db.prepare("SELECT * FROM trust ORDER BY action_type").all() as unknown as
      Array<Record<string, unknown>>).map(toTrustRecord);
  }

  upsertTrust(t: TrustRecord): void {
    this.db
      .prepare(
        `INSERT INTO trust (action_type, state, approvals, rejections, streak, first_seen, last_rejection, graduated_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(action_type) DO UPDATE SET
           state=excluded.state, approvals=excluded.approvals, rejections=excluded.rejections,
           streak=excluded.streak, last_rejection=excluded.last_rejection,
           graduated_at=excluded.graduated_at, updated_at=excluded.updated_at`,
      )
      .run(
        t.actionType, t.state, t.approvals, t.rejections, t.streak,
        t.firstSeen, t.lastRejection, t.graduatedAt, new Date().toISOString(),
      );
  }

  // ---- actions (approval queue + audit log) ----

  insertAction(a: ActionRow): void {
    this.db
      .prepare(
        `INSERT INTO actions (id, type, payload, preview, status, origin_channel, origin_chat_id,
                              trust_state, verdict_by, reject_reason, result, created_at, resolved_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id, a.type, a.payload, a.preview, a.status, a.origin_channel, a.origin_chat_id,
        a.trust_state, a.verdict_by, a.reject_reason, a.result, a.created_at, a.resolved_at, a.expires_at,
      );
  }

  getAction(id: string): ActionRow | undefined {
    return this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as ActionRow | undefined;
  }

  listActions(status?: string, limit = 100): ActionRow[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM actions WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit)
      : this.db.prepare("SELECT * FROM actions ORDER BY created_at DESC LIMIT ?").all(limit);
    return rows as unknown as ActionRow[];
  }

  resolveAction(
    id: string,
    f: { status: ActionStatus; verdict_by: string | null; reject_reason: string | null; result: string | null; resolved_at: string },
  ): void {
    this.db
      .prepare("UPDATE actions SET status = ?, verdict_by = ?, reject_reason = ?, result = ?, resolved_at = ? WHERE id = ?")
      .run(f.status, f.verdict_by, f.reject_reason, f.result, f.resolved_at, id);
  }

  expireActions(nowIso: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM actions WHERE status = 'proposed' AND expires_at < ? ORDER BY created_at")
      .all(nowIso) as unknown as Array<{ id: string }>;
    const expire = this.db.prepare(
      "UPDATE actions SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'proposed'",
    );
    for (const r of rows) expire.run(nowIso, r.id);
    return rows.map((r) => r.id);
  }

  close(): void {
    this.db.close();
  }
}

function toTrustRecord(r: Record<string, unknown>): TrustRecord {
  return {
    actionType: r.action_type as string,
    state: r.state as TrustRecord["state"],
    approvals: r.approvals as number,
    rejections: r.rejections as number,
    streak: r.streak as number,
    firstSeen: r.first_seen as string,
    lastRejection: (r.last_rejection as string) ?? null,
    graduatedAt: (r.graduated_at as string) ?? null,
  };
}
