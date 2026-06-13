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

export interface ReminderRow {
  id: number;
  text: string;
  due_at: string;
  origin_channel: string;
  origin_chat_id: string;
  status: "pending" | "fired" | "cancelled";
  created_at: string;
}

export interface TriageRuleRow {
  id: number;
  /** Exact event type ("reminder.due") or glob prefix ("action.*"). */
  event_type: string;
  verdict: "ignore" | "batch" | "notify_now";
  source: "manual" | "correction";
  created_at: string;
}

export interface TeachingRow {
  id: number;
  text: string;
  domain: string | null;
  kind: string;
  created_at: string;
  consolidated_at: string | null;
}

export interface DecisionRow {
  id: string;
  type: string;
  preview: string;
  verdict: "approved" | "auto" | "rejected" | "failed";
  reason: string | null;
  ts: string;
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        due_at TEXT NOT NULL,
        origin_channel TEXT NOT NULL,
        origin_chat_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);
      CREATE TABLE IF NOT EXISTS triage_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL UNIQUE,
        verdict TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_doc (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        ref TEXT NOT NULL,
        domain TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        ts TEXT NOT NULL,
        len INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE(source, ref)
      );
      CREATE TABLE IF NOT EXISTS memory_token (
        token TEXT NOT NULL,
        doc_id INTEGER NOT NULL,
        tf INTEGER NOT NULL,
        PRIMARY KEY (token, doc_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_token_token ON memory_token(token);
      CREATE INDEX IF NOT EXISTS idx_memory_token_doc ON memory_token(doc_id);
      CREATE TABLE IF NOT EXISTS teachings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        domain TEXT,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consolidated_at TEXT
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

  /** Atomically claim a proposed action for execution. Returns true iff this call won the claim. */
  claimAction(id: string): boolean {
    const res = this.db
      .prepare("UPDATE actions SET status = 'executing' WHERE id = ? AND status = 'proposed'")
      .run(id);
    return res.changes === 1;
  }

  /** Mark actions stuck in 'executing' (daemon died mid-execution) as failed. Returns affected ids. */
  failStaleExecuting(nowIso: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM actions WHERE status = 'executing'")
      .all() as unknown as Array<{ id: string }>;
    const fail = this.db.prepare(
      "UPDATE actions SET status = 'failed', result = 'daemon restarted mid-execution — effect unknown', resolved_at = ? WHERE id = ? AND status = 'executing'",
    );
    for (const r of rows) fail.run(nowIso, r.id);
    return rows.map((r) => r.id);
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

  // ---- reminders ----

  addReminder(r: { text: string; dueAt: string; originChannel: string; originChatId: string }): number {
    const res = this.db
      .prepare(
        `INSERT INTO reminders (text, due_at, origin_channel, origin_chat_id, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(r.text, r.dueAt, r.originChannel, r.originChatId, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  listReminders(status?: string): ReminderRow[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM reminders WHERE status = ? ORDER BY due_at").all(status)
      : this.db.prepare("SELECT * FROM reminders ORDER BY due_at").all();
    return rows as unknown as ReminderRow[];
  }

  cancelReminder(id: number): boolean {
    const res = this.db
      .prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'")
      .run(id);
    return res.changes > 0;
  }

  /** Atomically flip due pending reminders to fired; returns the claimed rows (at-most-once). */
  claimDueReminders(nowIso: string): ReminderRow[] {
    const rows = this.db
      .prepare("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at")
      .all(nowIso) as unknown as ReminderRow[];
    const fire = this.db.prepare("UPDATE reminders SET status = 'fired' WHERE id = ? AND status = 'pending'");
    return rows.filter((r) => fire.run(r.id).changes === 1);
  }

  // ---- triage rules ----

  addTriageRule(r: { eventType: string; verdict: TriageRuleRow["verdict"]; source: TriageRuleRow["source"] }): number {
    const res = this.db
      .prepare(
        `INSERT INTO triage_rules (event_type, verdict, source, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(event_type) DO UPDATE SET verdict=excluded.verdict, source=excluded.source, created_at=excluded.created_at`,
      )
      .run(r.eventType, r.verdict, r.source, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  listTriageRules(): TriageRuleRow[] {
    return this.db
      .prepare("SELECT * FROM triage_rules ORDER BY id")
      .all() as unknown as TriageRuleRow[];
  }

  // ---- events window (brief assembly) ----

  listEventsSince(tsIso: string, limit = 1000): Array<{ id: number; ts: string; payload: string }> {
    return this.db
      .prepare("SELECT * FROM events WHERE ts > ? ORDER BY id LIMIT ?")
      .all(tsIso, limit) as unknown as Array<{ id: number; ts: string; payload: string }>;
  }

  /** All kv entries whose key starts with the prefix (used by brief assembly for calendar snapshots). */
  kvByPrefix(prefix: string): Array<{ key: string; value: string }> {
    return this.db
      .prepare("SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key")
      .all(`${prefix}%`) as unknown as Array<{ key: string; value: string }>;
  }

  // ---- memory index ----

  memoryFingerprint(source: string, ref: string): string | undefined {
    const r = this.db
      .prepare("SELECT fingerprint FROM memory_doc WHERE source = ? AND ref = ?")
      .get(source, ref) as { fingerprint: string } | undefined;
    return r?.fingerprint;
  }

  upsertMemoryDoc(
    doc: { source: string; ref: string; domain: string; title: string; body: string; ts: string; len: number; fingerprint: string },
    postings: Array<[string, number]>,
  ): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      const existing = this.db.prepare("SELECT id FROM memory_doc WHERE source = ? AND ref = ?").get(doc.source, doc.ref) as { id: number } | undefined;
      if (existing) {
        this.db.prepare("DELETE FROM memory_token WHERE doc_id = ?").run(existing.id);
        this.db.prepare("DELETE FROM memory_doc WHERE id = ?").run(existing.id);
      }
      const res = this.db
        .prepare(`INSERT INTO memory_doc (source, ref, domain, title, body, ts, len, fingerprint, indexed_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(doc.source, doc.ref, doc.domain, doc.title, doc.body, doc.ts, doc.len, doc.fingerprint, now);
      const docId = Number(res.lastInsertRowid);
      const ins = this.db.prepare("INSERT INTO memory_token (token, doc_id, tf) VALUES (?, ?, ?)");
      for (const [token, tf] of postings) ins.run(token, docId, tf);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  deleteMemoryDoc(source: string, ref: string): void {
    const row = this.db.prepare("SELECT id FROM memory_doc WHERE source = ? AND ref = ?").get(source, ref) as { id: number } | undefined;
    if (!row) return;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM memory_token WHERE doc_id = ?").run(row.id);
      this.db.prepare("DELETE FROM memory_doc WHERE id = ?").run(row.id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  listMemoryRefs(source: string): string[] {
    return (this.db.prepare("SELECT ref FROM memory_doc WHERE source = ?").all(source) as Array<{ ref: string }>).map((r) => r.ref);
  }

  memoryStats(domain?: string): { count: number; avgLen: number } {
    const r = (domain
      ? this.db.prepare("SELECT COUNT(*) c, COALESCE(AVG(len), 0) a FROM memory_doc WHERE domain = ?").get(domain)
      : this.db.prepare("SELECT COUNT(*) c, COALESCE(AVG(len), 0) a FROM memory_doc").get()) as { c: number; a: number };
    return { count: Number(r.c), avgLen: Number(r.a) };
  }

  memoryPostings(tokens: string[], domain?: string): Array<{ token: string; doc_id: number; tf: number; len: number; domain: string; source: string; ref: string; ts: string }> {
    if (!tokens.length) return [];
    const ph = tokens.map(() => "?").join(", ");
    const sql = `SELECT t.token, t.doc_id, t.tf, d.len, d.domain, d.source, d.ref, d.ts
                 FROM memory_token t JOIN memory_doc d ON d.id = t.doc_id
                 WHERE t.token IN (${ph})${domain ? " AND d.domain = ?" : ""}`;
    const args = domain ? [...tokens, domain] : tokens;
    return this.db.prepare(sql).all(...args) as never;
  }

  memoryDocsByIds(ids: number[]): Array<{ id: number; title: string; body: string }> {
    if (!ids.length) return [];
    const ph = ids.map(() => "?").join(", ");
    return this.db.prepare(`SELECT id, title, body FROM memory_doc WHERE id IN (${ph})`).all(...ids) as never;
  }

  // ---- teachings ----

  addTeaching(t: { text: string; domain: string | null; kind: string }): number {
    const res = this.db
      .prepare("INSERT INTO teachings (text, domain, kind, created_at) VALUES (?, ?, ?, ?)")
      .run(t.text, t.domain, t.kind, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  listUnconsolidatedTeachings(domain?: string | null): TeachingRow[] {
    let sql = "SELECT * FROM teachings WHERE consolidated_at IS NULL";
    const args: string[] = [];
    if (domain === null) {
      sql += " AND domain IS NULL";
    } else if (domain !== undefined) {
      sql += " AND domain = ?";
      args.push(domain);
    }
    sql += " ORDER BY id";
    return this.db.prepare(sql).all(...args) as unknown as TeachingRow[];
  }

  markTeachingsConsolidated(ids: number[]): void {
    if (!ids.length) return;
    const stmt = this.db.prepare("UPDATE teachings SET consolidated_at = ? WHERE id = ?");
    const now = new Date().toISOString();
    for (const id of ids) stmt.run(now, id);
  }

  // ---- decision journal (read model over actions) ----

  listDecisions(since?: string): DecisionRow[] {
    // Only resolved verdicts carry preference signal; proposed/executing/expired are
    // excluded — expired means the user never decided, so it teaches nothing.
    let sql = "SELECT id, type, preview, status, verdict_by, reject_reason, created_at, resolved_at FROM actions WHERE status IN ('executed','failed','rejected')";
    const args: string[] = [];
    if (since) { sql += " AND COALESCE(resolved_at, created_at) > ?"; args.push(since); }
    sql += " ORDER BY COALESCE(resolved_at, created_at)";
    const rows = this.db.prepare(sql).all(...args) as Array<{ id: string; type: string; preview: string; status: string; verdict_by: string | null; reject_reason: string | null; created_at: string; resolved_at: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      preview: r.preview,
      verdict: r.status === "rejected" ? "rejected" : r.status === "failed" ? "failed" : r.verdict_by ? "approved" : "auto",
      reason: r.reject_reason,
      ts: r.resolved_at ?? r.created_at,
    }));
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
