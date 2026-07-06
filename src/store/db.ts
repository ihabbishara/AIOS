import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TrustRecord } from "../kernel/trust.js";
import type { ActionRow, ActionStatus } from "../kernel/actions.js";

export type GoalStatus = "planning" | "running" | "paused-budget" | "paused-user" | "replanning" | "done" | "failed" | "abandoned" | "awaiting-mail";
export type NodeStatus = "pending" | "ready" | "running" | "done" | "failed" | "skipped";

export interface GoalRow {
  id: string;
  slug: string;
  title: string;
  request: string;
  department: string;
  lead: string;
  origin_channel: string;
  origin_chat_id: string;
  status: GoalStatus;
  project_dir: string | null;
  /** The vault directory `<date>-<slug>` under goals/ where artifacts live; stamped at start. */
  goal_dir: string | null;
  plan_summary: string;
  replans_used: number;
  /** Mail chain depth: 0 for user/hermes/facade goals; a mail-spawned goal inherits its mail's depth. */
  chain_depth: number;
  /** Source mail id when this goal was spawned by mail (single-node or graph); null otherwise. */
  spawned_by_mail: string | null;
  /** When parked (status 'awaiting-mail'), the request id whose answer un-parks this goal. */
  awaiting_mail?: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export type MailKind = "request" | "note" | "report" | "standup";
export type MailStatus = "queued" | "planning" | "spawned" | "refused" | "unread" | "read";
export interface MailRow {
  id: string;
  from_agent: string;
  to_agent: string;
  kind: MailKind;
  body: string;
  /** The spawned goal (requests) or the source goal (reports); null otherwise. */
  goal_id: string | null;
  origin_channel: string;
  origin_chat_id: string;
  chain_depth: number;
  status: MailStatus;
  error: string | null;
  created_at: string;
  read_at: string | null;
  /** Conversation grouping key; defaults to the mail's own id (a fresh thread). */
  thread_id?: string;
  /** The request id this report/reply answers; null for fresh requests/notes. */
  in_reply_to?: string | null;
}

export interface TaskNodeRow {
  goal_id: string;
  node_key: string;
  type: "run" | "loop" | "verify";
  agent: string;
  critic: string | null;
  brief: string;
  /** JSON array of node_keys. */
  depends_on: string;
  max_rounds: number;
  status: NodeStatus;
  artifact: string | null;
  cost_cents: number;
  rounds_used: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface NewTaskNode {
  node_key: string;
  type: "run" | "loop" | "verify";
  agent: string;
  critic: string | null;
  brief: string;
  depends_on: string[];
  max_rounds: number;
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

export interface RolePermissionRow {
  id: number;
  role: string;
  tool: string;
  /** 1 = grant (add to allowlist), 0 = revoke (remove a code default). */
  allow: number;
  /** Gate verdict_by — the human who approved the grant/revoke. */
  granted_by: string;
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

export interface PersonalTransactionRow {
  id: number;
  account_id: string;
  account_label: string;
  bunq_id: number;
  amount_cents: number;
  currency: string;
  description: string;
  counterparty: string | null;
  counterparty_iban: string | null;
  type: string | null;
  bunq_created: string;
  synced_at: string;
}

export interface CategoryRuleRow { id: number; pattern: string; category: string; source: "user" | "llm"; created_at: string; }
export interface TxCategoryRow { account_id: string; bunq_id: number; category: string; source: "rule" | "default" | "llm"; created_at: string; }
export interface SubscriptionRow {
  id: number; name: string; counterparty: string | null; amount_cents: number; currency: string;
  cadence: "monthly" | "yearly" | "weekly"; next_renewal: string | null;
  status: "detected" | "confirmed" | "dismissed"; source: "auto" | "manual"; created_at: string;
}
export interface BudgetRow { category: string; limit_cents: number; currency: string; created_at: string; }
export interface ResearchSourceRow { id: number; url: string; title: string; topic: string | null; note: string | null; created_at: string; }

export interface PersonalTaskRow {
  id: number;
  title: string;
  status: "open" | "waiting" | "done" | "dismissed";
  project: string | null;
  due_date: string | null;
  next_action: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        request TEXT NOT NULL,
        department TEXT NOT NULL,
        lead TEXT NOT NULL,
        origin_channel TEXT NOT NULL,
        origin_chat_id TEXT NOT NULL,
        status TEXT NOT NULL,
        project_dir TEXT,
        goal_dir TEXT,
        plan_summary TEXT NOT NULL DEFAULT '',
        replans_used INTEGER NOT NULL DEFAULT 0,
        chain_depth INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        awaiting_mail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_nodes (
        goal_id TEXT NOT NULL,
        node_key TEXT NOT NULL,
        type TEXT NOT NULL,
        agent TEXT NOT NULL,
        critic TEXT,
        brief TEXT NOT NULL,
        depends_on TEXT NOT NULL,
        max_rounds INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        artifact TEXT,
        cost_cents INTEGER NOT NULL DEFAULT 0,
        rounds_used INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE (goal_id, node_key)
      );
      CREATE TABLE IF NOT EXISTS budget_ledger (
        date TEXT PRIMARY KEY,
        spent_cents INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS mail (
        id TEXT PRIMARY KEY,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        goal_id TEXT,
        origin_channel TEXT NOT NULL,
        origin_chat_id TEXT NOT NULL,
        chain_depth INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        read_at TEXT,
        thread_id TEXT,
        in_reply_to TEXT
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
    // Migration (Phase 4a): mail chain depth on existing goal rows.
    try {
      this.db.exec("ALTER TABLE goals ADD COLUMN chain_depth INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* column already exists */
    }
    // Migration (mail-graphs): link a goal back to the mail that spawned it.
    try {
      this.db.exec("ALTER TABLE goals ADD COLUMN spawned_by_mail TEXT");
    } catch {
      /* column already exists */
    }
    // Backfill: pre-branch single-node mail goals encoded the mail id in plan_summary ("mail:<id>").
    // Report-back and the workspace gate now key on the column, so historical rows need it populated.
    this.db.exec("UPDATE goals SET spawned_by_mail = substr(plan_summary, 6) WHERE plan_summary LIKE 'mail:%' AND spawned_by_mail IS NULL");
    // Migration (mail-threads): conversation id + reply pointer on existing mail rows.
    try { this.db.exec("ALTER TABLE mail ADD COLUMN thread_id TEXT"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE mail ADD COLUMN in_reply_to TEXT"); } catch { /* exists */ }
    // Backfill: pre-thread mail each becomes its own singleton thread.
    this.db.exec("UPDATE mail SET thread_id = id WHERE thread_id IS NULL");
    // Migration (mail-clarification): the request a parked goal is blocked on.
    try { this.db.exec("ALTER TABLE goals ADD COLUMN awaiting_mail TEXT"); } catch { /* exists */ }
    // Migration (Phase 3a): the linear job engine is gone — goals/task_nodes replace jobs/stages.
    this.db.exec("DROP TABLE IF EXISTS jobs; DROP TABLE IF EXISTS stages;");
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personal_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        account_label TEXT NOT NULL,
        bunq_id INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        description TEXT NOT NULL,
        counterparty TEXT,
        counterparty_iban TEXT,
        type TEXT,
        bunq_created TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        UNIQUE(account_id, bunq_id)
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_personal_tx_account ON personal_transactions(account_id, bunq_created DESC);`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personal_category_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern TEXT NOT NULL, category TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(pattern)
      );
      CREATE TABLE IF NOT EXISTS personal_tx_category (
        account_id TEXT NOT NULL, bunq_id INTEGER NOT NULL, category TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(account_id, bunq_id)
      );
      CREATE TABLE IF NOT EXISTS personal_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, counterparty TEXT, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL,
        cadence TEXT NOT NULL, next_renewal TEXT, status TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS personal_budgets (
        category TEXT NOT NULL, limit_cents INTEGER NOT NULL, currency TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(category)
      );
      CREATE TABLE IF NOT EXISTS research_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        topic TEXT,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS personal_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        project TEXT,
        due_date TEXT,
        next_action TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_personal_tasks_status_due ON personal_tasks(status, due_date);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        tool TEXT NOT NULL,
        allow INTEGER NOT NULL,
        granted_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(role, tool)
      );
    `);
    // Migration: rename legacy role/alias keys to their canonical registry agent names, so
    // permission grants/revokes recorded under an old alias keep applying after the staff
    // rename. UPDATE OR REPLACE: if BOTH a legacy row and a conflicting canonical row exist
    // for the same tool, the legacy (more specific, human-authored) row wins and the
    // pre-existing canonical row is dropped — a plain UPDATE would throw on UNIQUE(role,tool).
    // Each runs in its own try/catch so one failure can't abort the rest.
    const LEGACY_ROLE_RENAMES: Array<[string, string]> = [
      ["moderator", "rami"],
      ["developer", "maya"],
      ["architect", "kai"],
      ["tester", "tarek"],
      ["code-reviewer", "nadia"],
      ["devops", "omar"],
      ["researcher", "ziad"],
      ["analyst", "lina"],
      ["market-researcher", "sami"],
      ["ui-ux-designer", "dalia"],
      ["reviewer", "yara"],
      ["cfo", "faris"],
      ["finance", "salim"],
    ];
    for (const [legacy, canonical] of LEGACY_ROLE_RENAMES) {
      try {
        this.db
          .prepare("UPDATE OR REPLACE role_permissions SET role = ? WHERE role = ?")
          .run(canonical, legacy);
      } catch {
        /* noop — a single rename failing must not block startup */
      }
    }
    // Migration wave 2: Arabic staff names → mythological names (mythic-names branch).
    // Runs after wave 1 so double-hop aliases (e.g. moderator→rami→hermes) chain correctly.
    const MYTHIC_RENAMES: Array<[string, string]> = [
      ["rami", "hermes"],
      ["maya", "vulcan"],
      ["kai", "athena"],
      ["tarek", "argus"],
      ["nadia", "themis"],
      ["omar", "atlas"],
      ["ziad", "odin"],
      ["lina", "clio"],
      ["sami", "janus"],
      ["dalia", "venus"],
      ["yara", "minos"],
      ["faris", "midas"],
      ["salim", "juno"],
    ];
    for (const [arabic, mythic] of MYTHIC_RENAMES) {
      try {
        this.db
          .prepare("UPDATE OR REPLACE role_permissions SET role = ? WHERE role = ?")
          .run(mythic, arabic);
      } catch {
        /* noop — a single rename failing must not block startup */
      }
    }
  }

  insertGoal(g: Omit<GoalRow, "created_at" | "updated_at" | "spawned_by_mail"> & { spawned_by_mail?: string | null }): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO goals (id, slug, title, request, department, lead, origin_channel, origin_chat_id,
                          status, project_dir, goal_dir, plan_summary, replans_used, chain_depth, spawned_by_mail, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(g.id, g.slug, g.title, g.request, g.department, g.lead, g.origin_channel, g.origin_chat_id,
          g.status, g.project_dir, g.goal_dir, g.plan_summary, g.replans_used, g.chain_depth,
          g.spawned_by_mail ?? null, g.error, now, now);
  }

  getGoal(id: string): GoalRow | undefined {
    return this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as GoalRow | undefined;
  }

  getGoalBySlug(slug: string): GoalRow | undefined {
    return this.db.prepare("SELECT * FROM goals WHERE slug = ? ORDER BY created_at DESC LIMIT 1")
      .get(slug) as GoalRow | undefined;
  }

  listGoals(limit = 20): GoalRow[] {
    return this.db.prepare("SELECT * FROM goals ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as GoalRow[];
  }

  /** Goals touched since `sinceIso` — selected by updated_at in SQL, not a created_at-ordered
   *  LIMIT window (a weeks-old goal resumed yesterday must still count as recent activity). */
  goalsUpdatedSince(sinceIso: string): GoalRow[] {
    return this.db.prepare("SELECT * FROM goals WHERE updated_at >= ? ORDER BY updated_at DESC")
      .all(sinceIso) as unknown as GoalRow[];
  }

  unfinishedGoals(): GoalRow[] {
    return this.db.prepare(
      "SELECT * FROM goals WHERE status IN ('planning','running','replanning') ORDER BY created_at ASC",
    ).all() as unknown as GoalRow[];
  }

  pausedBudgetGoals(): GoalRow[] {
    return this.db.prepare("SELECT * FROM goals WHERE status = 'paused-budget' ORDER BY created_at ASC")
      .all() as unknown as GoalRow[];
  }

  updateGoalStatus(id: string, status: GoalStatus, error?: string): void {
    this.db.prepare("UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, error ?? null, new Date().toISOString(), id);
  }

  setGoalProjectDir(id: string, dir: string): void {
    this.db.prepare("UPDATE goals SET project_dir = ?, updated_at = ? WHERE id = ?")
      .run(dir, new Date().toISOString(), id);
  }

  setGoalDir(id: string, dir: string): void {
    this.db.prepare("UPDATE goals SET goal_dir = ?, updated_at = ? WHERE id = ?")
      .run(dir, new Date().toISOString(), id);
  }

  setGoalPlanSummary(id: string, summary: string): void {
    this.db.prepare("UPDATE goals SET plan_summary = ?, updated_at = ? WHERE id = ?")
      .run(summary, new Date().toISOString(), id);
  }

  bumpReplans(id: string): void {
    this.db.prepare("UPDATE goals SET replans_used = replans_used + 1, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  insertNodes(goalId: string, nodes: NewTaskNode[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO task_nodes (goal_id, node_key, type, agent, critic, brief, depends_on, max_rounds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const n of nodes) {
      stmt.run(goalId, n.node_key, n.type, n.agent, n.critic, n.brief, JSON.stringify(n.depends_on), n.max_rounds);
    }
  }

  replaceNode(goalId: string, key: string, node: NewTaskNode): void {
    this.db.prepare("DELETE FROM task_nodes WHERE goal_id = ? AND node_key = ?").run(goalId, key);
    this.insertNodes(goalId, [node]);
  }

  listNodes(goalId: string): TaskNodeRow[] {
    return this.db.prepare("SELECT * FROM task_nodes WHERE goal_id = ? ORDER BY rowid ASC")
      .all(goalId) as unknown as TaskNodeRow[];
  }

  updateNodeStatus(goalId: string, key: string, status: NodeStatus, error?: string): void {
    const now = new Date().toISOString();
    const stamps =
      status === "running" ? ", started_at = ?" :
      status === "done" || status === "failed" || status === "skipped" ? ", finished_at = ?" : "";
    const sql = `UPDATE task_nodes SET status = ?, error = ?${stamps} WHERE goal_id = ? AND node_key = ?`;
    const args: SQLInputValue[] = stamps ? [status, error ?? null, now, goalId, key] : [status, error ?? null, goalId, key];
    this.db.prepare(sql).run(...args);
  }

  addNodeCost(goalId: string, key: string, cents: number): void {
    this.db.prepare("UPDATE task_nodes SET cost_cents = cost_cents + ? WHERE goal_id = ? AND node_key = ?")
      .run(cents, goalId, key);
  }

  setNodeArtifact(goalId: string, key: string, file: string): void {
    this.db.prepare("UPDATE task_nodes SET artifact = ? WHERE goal_id = ? AND node_key = ?").run(file, goalId, key);
  }

  setNodeRounds(goalId: string, key: string, rounds: number): void {
    this.db.prepare("UPDATE task_nodes SET rounds_used = ? WHERE goal_id = ? AND node_key = ?").run(rounds, goalId, key);
  }

  skipUnfinishedNodes(goalId: string): void {
    this.db.prepare(
      "UPDATE task_nodes SET status = 'skipped', finished_at = ? WHERE goal_id = ? AND status IN ('pending','ready')",
    ).run(new Date().toISOString(), goalId);
  }

  /** Startup-only sweep: re-run nodes orphaned mid-flight by a daemon restart. */
  resetRunningNodes(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT goal_id FROM task_nodes WHERE status = 'running'")
      .all() as unknown as Array<{ goal_id: string }>;
    this.db.prepare("UPDATE task_nodes SET status = 'pending', started_at = NULL WHERE status = 'running'").run();
    return rows.map((r) => r.goal_id);
  }

  budgetAdd(date: string, cents: number): void {
    this.db.prepare(
      `INSERT INTO budget_ledger (date, spent_cents) VALUES (?, ?)
       ON CONFLICT(date) DO UPDATE SET spent_cents = spent_cents + excluded.spent_cents`,
    ).run(date, cents);
  }

  budgetSpentCents(date: string): number {
    const r = this.db.prepare("SELECT spent_cents FROM budget_ledger WHERE date = ?").get(date) as
      | { spent_cents: number } | undefined;
    return r?.spent_cents ?? 0;
  }

  // --- Agent mailbox (Phase 4a) ---

  insertMail(m: Omit<MailRow, "created_at" | "read_at">): void {
    this.db.prepare(
      `INSERT INTO mail (id, from_agent, to_agent, kind, body, goal_id, origin_channel, origin_chat_id,
                         chain_depth, status, error, thread_id, in_reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.id, m.from_agent, m.to_agent, m.kind, m.body, m.goal_id, m.origin_channel, m.origin_chat_id,
          m.chain_depth, m.status, m.error, m.thread_id ?? m.id, m.in_reply_to ?? null, new Date().toISOString());
  }

  getMail(id: string): MailRow | undefined {
    return this.db.prepare("SELECT * FROM mail WHERE id = ?").get(id) as MailRow | undefined;
  }

  listMail(agent?: string, limit = 50): MailRow[] {
    if (agent) {
      return this.db.prepare(
        "SELECT * FROM mail WHERE from_agent = ? OR to_agent = ? ORDER BY created_at DESC LIMIT ?",
      ).all(agent, agent, limit) as unknown as MailRow[];
    }
    return this.db.prepare("SELECT * FROM mail ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as MailRow[];
  }

  unreadMailFor(agent: string): MailRow[] {
    return this.db.prepare(
      "SELECT * FROM mail WHERE to_agent = ? AND status = 'unread' ORDER BY created_at ASC",
    ).all(agent) as unknown as MailRow[];
  }

  /** Unread inbound count per recipient (status='unread' — same set injectionFor drains).
   *  Excludes queued/spawned requests (work, not messages) and already-read mail. */
  unreadCountsByAgent(): Record<string, number> {
    const rows = this.db.prepare(
      "SELECT to_agent, COUNT(*) AS c FROM mail WHERE status = 'unread' GROUP BY to_agent",
    ).all() as unknown as Array<{ to_agent: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.to_agent] = r.c;
    return out;
  }

  refusedMailFrom(agent: string): MailRow[] {
    return this.db.prepare(
      "SELECT * FROM mail WHERE from_agent = ? AND status = 'refused' AND read_at IS NULL ORDER BY created_at ASC",
    ).all(agent) as unknown as MailRow[];
  }

  /** Stamps read_at (unread → read; refused keeps its status — read_at doubles as the ack). */
  markMailRead(ids: string[]): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "UPDATE mail SET read_at = ?, status = CASE WHEN status = 'unread' THEN 'read' ELSE status END WHERE id = ?",
    );
    for (const id of ids) stmt.run(now, id);
  }

  queuedRequests(): MailRow[] {
    return this.db.prepare(
      "SELECT * FROM mail WHERE kind = 'request' AND status = 'queued' ORDER BY created_at ASC",
    ).all() as unknown as MailRow[];
  }

  markMailSpawned(id: string, goalId: string): void {
    this.db.prepare("UPDATE mail SET status = 'spawned', goal_id = ? WHERE id = ?").run(goalId, id);
  }

  /** Atomically claim a queued request for async planning. Returns false if it was not queued. */
  claimMailPlanning(id: string): boolean {
    const info = this.db.prepare("UPDATE mail SET status = 'planning' WHERE id = ? AND status = 'queued'").run(id);
    return info.changes > 0;
  }

  /** Boot recovery for the async graph path: a 'planning' mail whose goal already committed is
   *  marked spawned; otherwise it is requeued to be re-planned. */
  reconcilePlanningMail(): void {
    const rows = this.db.prepare("SELECT id FROM mail WHERE status = 'planning'").all() as Array<{ id: string }>;
    for (const { id } of rows) {
      const g = this.db.prepare("SELECT id FROM goals WHERE spawned_by_mail = ? LIMIT 1").get(id) as { id: string } | undefined;
      if (g) this.db.prepare("UPDATE mail SET status = 'spawned', goal_id = ? WHERE id = ?").run(g.id, id);
      else this.db.prepare("UPDATE mail SET status = 'queued' WHERE id = ?").run(id);
    }
  }

  refuseMail(id: string, error: string): void {
    this.db.prepare("UPDATE mail SET status = 'refused', error = ? WHERE id = ?").run(error, id);
  }

  /** Depth-exceeded requests deliver as ordinary notes — fail-soft, nothing runs. */
  downgradeMailToNote(id: string, reason: string): void {
    this.db.prepare("UPDATE mail SET kind = 'note', status = 'unread', error = ? WHERE id = ?").run(reason, id);
  }

  // --- Mail threads + mid-goal clarification ---

  mailThread(threadId: string): MailRow[] {
    return this.db.prepare("SELECT * FROM mail WHERE thread_id = ? ORDER BY created_at ASC")
      .all(threadId) as unknown as MailRow[];
  }

  /** Newest mail answering a given request (report/refusal-note carrying in_reply_to). */
  mailAnsweringRequest(requestId: string): MailRow | undefined {
    return this.db.prepare("SELECT * FROM mail WHERE in_reply_to = ? ORDER BY created_at DESC LIMIT 1")
      .get(requestId) as MailRow | undefined;
  }

  parkGoalAwaiting(goalId: string, mailId: string): void {
    this.db.prepare("UPDATE goals SET status = 'awaiting-mail', awaiting_mail = ?, updated_at = ? WHERE id = ?")
      .run(mailId, new Date().toISOString(), goalId);
  }

  clearAwaiting(goalId: string): void {
    this.db.prepare("UPDATE goals SET awaiting_mail = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), goalId);
  }

  /** The goal parked on a given request (if any). */
  goalAwaiting(mailId: string): GoalRow | undefined {
    return this.db.prepare("SELECT * FROM goals WHERE awaiting_mail = ? AND status = 'awaiting-mail' LIMIT 1")
      .get(mailId) as GoalRow | undefined;
  }

  awaitingMailGoals(): GoalRow[] {
    return this.db.prepare("SELECT * FROM goals WHERE status = 'awaiting-mail' ORDER BY created_at ASC")
      .all() as unknown as GoalRow[];
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
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

  // ---- role permissions ----

  /** Upsert a per-role tool override. allow=1 grants, allow=0 revokes a default. Keyed on (role, tool). */
  setRolePermission(role: string, tool: string, allow: 0 | 1, grantedBy: string): void {
    this.db
      .prepare(
        `INSERT INTO role_permissions (role, tool, allow, granted_by, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(role, tool) DO UPDATE SET
           allow=excluded.allow, granted_by=excluded.granted_by, created_at=excluded.created_at`,
      )
      .run(role, tool, allow, grantedBy, new Date().toISOString());
  }

  /** All overrides, or just one role's. Ordered for stable output. */
  listRolePermissions(role?: string): RolePermissionRow[] {
    const rows = role
      ? this.db.prepare("SELECT * FROM role_permissions WHERE role = ? ORDER BY tool").all(role)
      : this.db.prepare("SELECT * FROM role_permissions ORDER BY role, tool").all();
    return rows as unknown as RolePermissionRow[];
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

  // ---- personal transactions (bunq bank sense — read-only feed) ----

  /** Insert a bank transaction. Returns true iff a new row was inserted (false = already present). */
  upsertPersonalTransaction(t: {
    account_id: string; account_label: string; bunq_id: number; amount_cents: number;
    currency: string; description: string; counterparty: string | null;
    counterparty_iban: string | null; type: string | null; bunq_created: string;
  }): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO personal_transactions
           (account_id, account_label, bunq_id, amount_cents, currency, description,
            counterparty, counterparty_iban, type, bunq_created, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.account_id, t.account_label, t.bunq_id, t.amount_cents, t.currency, t.description,
        t.counterparty, t.counterparty_iban, t.type, t.bunq_created, new Date().toISOString(),
      );
    return res.changes > 0;
  }

  listPersonalTransactions(accountId?: string): PersonalTransactionRow[] {
    const rows = accountId
      ? this.db.prepare("SELECT * FROM personal_transactions WHERE account_id = ? ORDER BY bunq_created DESC, id DESC").all(accountId)
      : this.db.prepare("SELECT * FROM personal_transactions ORDER BY bunq_created DESC, id DESC").all();
    return rows as unknown as PersonalTransactionRow[];
  }

  // ---- money pack (personal CFO) ----
  upsertCategoryRule(pattern: string, category: string, source: "user" | "llm"): void {
    this.db.prepare(
      `INSERT INTO personal_category_rules (pattern, category, source, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(pattern) DO UPDATE SET category=excluded.category, source=excluded.source, created_at=excluded.created_at`,
    ).run(pattern, category, source, new Date().toISOString());
  }
  listCategoryRules(): CategoryRuleRow[] {
    return this.db.prepare("SELECT * FROM personal_category_rules ORDER BY id").all() as unknown as CategoryRuleRow[];
  }
  setTxCategory(accountId: string, bunqId: number, category: string, source: "rule" | "default" | "llm"): void {
    this.db.prepare(
      `INSERT INTO personal_tx_category (account_id, bunq_id, category, source, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, bunq_id) DO UPDATE SET category=excluded.category, source=excluded.source, created_at=excluded.created_at`,
    ).run(accountId, bunqId, category, source, new Date().toISOString());
  }
  getTxCategory(accountId: string, bunqId: number): TxCategoryRow | undefined {
    return this.db.prepare("SELECT * FROM personal_tx_category WHERE account_id = ? AND bunq_id = ?").get(accountId, bunqId) as TxCategoryRow | undefined;
  }
  addSubscription(s: { name: string; counterparty: string | null; amount_cents: number; currency: string; cadence: SubscriptionRow["cadence"]; next_renewal: string | null; status: SubscriptionRow["status"]; source: SubscriptionRow["source"] }): number {
    const res = this.db.prepare(
      `INSERT INTO personal_subscriptions (name, counterparty, amount_cents, currency, cadence, next_renewal, status, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.name, s.counterparty, s.amount_cents, s.currency, s.cadence, s.next_renewal, s.status, s.source, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }
  listSubscriptions(status?: SubscriptionRow["status"]): SubscriptionRow[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM personal_subscriptions WHERE status = ? ORDER BY id").all(status)
      : this.db.prepare("SELECT * FROM personal_subscriptions ORDER BY id").all();
    return rows as unknown as SubscriptionRow[];
  }
  setSubscriptionStatus(id: number, status: SubscriptionRow["status"]): void {
    this.db.prepare("UPDATE personal_subscriptions SET status = ? WHERE id = ?").run(status, id);
  }
  setBudget(category: string, limitCents: number, currency: string): void {
    this.db.prepare(
      `INSERT INTO personal_budgets (category, limit_cents, currency, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(category) DO UPDATE SET limit_cents=excluded.limit_cents, currency=excluded.currency, created_at=excluded.created_at`,
    ).run(category, limitCents, currency, new Date().toISOString());
  }
  listBudgets(): BudgetRow[] {
    return this.db.prepare("SELECT * FROM personal_budgets ORDER BY category").all() as unknown as BudgetRow[];
  }

  addResearchSource(s: { url: string; title: string; topic?: string | null; note?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO research_sources (url, title, topic, note, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET title=excluded.title, topic=excluded.topic, note=excluded.note`,
      )
      .run(s.url, s.title, s.topic ?? null, s.note ?? null, new Date().toISOString());
  }

  listResearchSources(topic?: string): ResearchSourceRow[] {
    return (
      topic
        ? this.db.prepare("SELECT * FROM research_sources WHERE topic = ? ORDER BY created_at DESC, id DESC").all(topic)
        : this.db.prepare("SELECT * FROM research_sources ORDER BY created_at DESC, id DESC").all()
    ) as unknown as ResearchSourceRow[];
  }

  searchResearchSources(query: string): ResearchSourceRow[] {
    const q = `%${query.toLowerCase()}%`;
    return this.db
      .prepare(
        `SELECT * FROM research_sources
         WHERE lower(title) LIKE ? OR lower(url) LIKE ? OR lower(coalesce(topic,'')) LIKE ? OR lower(coalesce(note,'')) LIKE ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(q, q, q, q) as unknown as ResearchSourceRow[];
  }

  addTask(t: {
    title: string; status?: PersonalTaskRow["status"]; project?: string | null;
    due_date?: string | null; next_action?: string | null; notes?: string | null;
  }): number {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO personal_tasks (title, status, project, due_date, next_action, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.title, t.status ?? "open", t.project ?? null, t.due_date ?? null,
           t.next_action ?? null, t.notes ?? null, now, now);
    return Number(info.lastInsertRowid);
  }

  listTasks(status?: PersonalTaskRow["status"], project?: string): PersonalTaskRow[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (status) { where.push("status = ?"); args.push(status); }
    if (project) { where.push("project = ?"); args.push(project); }
    const sql = `SELECT * FROM personal_tasks${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY (due_date IS NULL), due_date ASC, id ASC`;
    return this.db.prepare(sql).all(...args) as unknown as PersonalTaskRow[];
  }

  getTask(id: number): PersonalTaskRow | undefined {
    return this.db.prepare("SELECT * FROM personal_tasks WHERE id = ?").get(id) as unknown as PersonalTaskRow | undefined;
  }

  updateTask(id: number, fields: Partial<Pick<PersonalTaskRow,
    "title" | "status" | "project" | "due_date" | "next_action" | "notes">>): void {
    const ALLOWED = new Set(["title", "status", "project", "due_date", "next_action", "notes"]);
    const cols = Object.keys(fields).filter((c) => ALLOWED.has(c));
    if (!cols.length) return;
    const set = cols.map((c) => `${c} = ?`).join(", ");
    const args = cols.map((c) => (fields as Record<string, unknown>)[c]) as SQLInputValue[];
    this.db.prepare(`UPDATE personal_tasks SET ${set}, updated_at = ? WHERE id = ?`)
      .run(...args, new Date().toISOString(), id);
  }

  completeTask(id: number): void { this.updateTask(id, { status: "done" }); }
  dismissTask(id: number): void { this.updateTask(id, { status: "dismissed" }); }

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
