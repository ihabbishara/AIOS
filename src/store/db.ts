import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TrustRecord } from "../kernel/trust.js";
import type { ActionRow, ActionStatus } from "../kernel/actions.js";

export type GoalStatus = "planning" | "running" | "paused-budget" | "paused-user" | "paused-api" | "paused-session" | "replanning" | "done" | "failed" | "abandoned" | "awaiting-mail";
export type NodeStatus = "pending" | "ready" | "running" | "done" | "failed" | "skipped" | "needs-review";

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
  /** Mail chain depth: 0 for user/neo/facade goals; a mail-spawned goal inherits its mail's depth. */
  chain_depth: number;
  /** Source mail id when this goal was spawned by mail (single-node or graph); null otherwise. */
  spawned_by_mail: string | null;
  /** When parked (status 'awaiting-mail'), the request id whose answer un-parks this goal. */
  awaiting_mail?: string | null;
  /** 1 = frozen pre-journal goal (readable, never scheduled); 0 = journal-backed projection. */
  legacy?: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export type MailKind = "request" | "note" | "report" | "standup";
export type MailStatus = "queued" | "planning" | "spawned" | "refused" | "unread" | "read" | "awaiting-human";
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
  /** node_key of the asking node when this request came from ask_mail (nullable; drives
   *  M4 resume wiring). Stamped from the baked MailSendCtx.nodeKey — never model-supplied. */
  from_node?: string | null;
}

export interface UserThreadRow {
  thread_id: string; last_ts: string; last_from: string; last_body: string;
  unread: number; pending_ask: number; refused: number;
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

export interface JournalRow {
  seq: number;
  goal_id: string;
  gseq: number;
  type: string;
  payload: string;
  v: number;
  ts: number;
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

export interface RoutineRow {
  id: number;
  name: string;
  prompt: string;
  /** JSON — parse with parseRecurrence (heartbeat/routines.ts). */
  recurrence: string;
  enabled: number;
  last_fired_at: string | null;
  last_fired_date: string | null;
  origin_channel: string | null;
  origin_chat_id: string | null;
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
  /** Provenance (memory-v2 §4/§5): user-stated (remember tool) vs agent-inferred (capture). */
  origin: string;
  created_at: string;
  consolidated_at: string | null;
}

/** A single durable memory fact (memory-v2 §4). Facts are the truth; memo markdown is a projection. */
export interface MemoFactRow {
  id: number;
  domain: string;
  subject: string;
  fact: string;
  ts: string;
  source_ref: string | null;
  status: "active" | "superseded";
  origin: "user-stated" | "agent-inferred" | "untrusted";
  superseded_by: number | null;
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
    // Ops floor: WAL for concurrent readers, busy_timeout instead of instant
    // SQLITE_BUSY, FK enforcement on. WAL is a harmless no-op on :memory:.
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA foreign_keys=ON");
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
      CREATE TABLE IF NOT EXISTS cost_daily (
        agent TEXT NOT NULL,
        date TEXT NOT NULL,
        usd_cents INTEGER NOT NULL DEFAULT 0,
        runs INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent, date)
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
    // Migration (M4a): the asking node's key on ask_mail requests (NULL for legacy/no-node).
    try { this.db.exec("ALTER TABLE mail ADD COLUMN from_node TEXT"); } catch { /* exists */ }
    // Backfill: pre-thread mail each becomes its own singleton thread.
    this.db.exec("UPDATE mail SET thread_id = id WHERE thread_id IS NULL");
    // mailThread()/recall re-indexing look mail up by thread on every mail event — index it.
    // Must run AFTER the thread_id migration above (the column may not exist in the base DDL path).
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_mail_thread ON mail(thread_id)");
    // Migration (mail-clarification): the request a parked goal is blocked on.
    try { this.db.exec("ALTER TABLE goals ADD COLUMN awaiting_mail TEXT"); } catch { /* exists */ }
    // Migration (journaled engine): freeze pre-journal goals. Runs exactly once — the
    // ALTER succeeds only the first time; rows existing at that moment are the legacy set.
    try {
      this.db.exec("ALTER TABLE goals ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0");
      this.db.exec("UPDATE goals SET legacy = 1");
    } catch { /* column exists — migration already ran */ }
    // Migration (info-flow policy): memory docs carry confidentiality labels (JSON array).
    try { this.db.exec("ALTER TABLE memory_doc ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'"); } catch { /* exists */ }
    // Migration (memory-v2 §6/§7): usage feedback + provenance.
    try { this.db.exec("ALTER TABLE memory_doc ADD COLUMN last_retrieved_at TEXT"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE memory_doc ADD COLUMN origin TEXT NOT NULL DEFAULT 'trusted'"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE teachings ADD COLUMN origin TEXT NOT NULL DEFAULT 'user-stated'"); } catch { /* exists */ }
    // Migration (Phase 3a): the linear job engine is gone — goals/task_nodes replace jobs/stages.
    this.db.exec("DROP TABLE IF EXISTS jobs; DROP TABLE IF EXISTS stages;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    // Journaled engine: the goal journal is the source of truth for goal execution;
    // goals/task_nodes are projections of it. APPEND-ONLY — never UPDATE/DELETE,
    // never pruned by retention (same rule as budget_ledger). The UNIQUE(goal_id, gseq)
    // constraint is the optimistic-concurrency claim: a losing INSERT throws.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goal_journal (
        seq     INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT NOT NULL,
        gseq    INTEGER NOT NULL,
        type    TEXT NOT NULL,
        payload TEXT NOT NULL,
        v       INTEGER NOT NULL DEFAULT 1,
        ts      INTEGER NOT NULL,
        UNIQUE (goal_id, gseq)
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
    // Migration (journaled engine): idempotent gate proposals. A retried goal attempt
    // carries idempotencyKey = goalId:node:attempt# — the unique index makes a duplicate
    // proposal return the original row instead of double-executing an effect. SQLite
    // unique indexes treat NULLs as distinct, so keyless actions are unaffected.
    try { this.db.exec("ALTER TABLE actions ADD COLUMN idempotency_key TEXT"); } catch { /* exists */ }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_idem ON actions(idempotency_key)");
    // Migration (verification-hardening §6): shadow-mode graduation. shadow_decision is
    // stamped on graduating-type actions at propose time ("execute" = what autonomy would
    // have done); trust.shadow_matches counts consecutive human-verdict matches.
    try { this.db.exec("ALTER TABLE actions ADD COLUMN shadow_decision TEXT"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE trust ADD COLUMN shadow_matches INTEGER NOT NULL DEFAULT 0"); } catch { /* exists */ }
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
      CREATE TABLE IF NOT EXISTS routines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        recurrence TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_fired_at TEXT,
        last_fired_date TEXT,
        origin_channel TEXT,
        origin_chat_id TEXT,
        created_at TEXT NOT NULL
      );
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
        labels TEXT NOT NULL DEFAULT '[]',
        origin TEXT NOT NULL DEFAULT 'trusted',
        last_retrieved_at TEXT,
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
        origin TEXT NOT NULL DEFAULT 'user-stated',
        created_at TEXT NOT NULL,
        consolidated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS memory_use (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        doc_ids TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '[]',
        UNIQUE(name, kind)
      );
      CREATE TABLE IF NOT EXISTS entity_link (
        doc_id INTEGER NOT NULL,
        entity_id INTEGER NOT NULL,
        PRIMARY KEY (doc_id, entity_id)
      );
      CREATE TABLE IF NOT EXISTS memory_vec (
        doc_id INTEGER PRIMARY KEY,
        vec BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memo_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT NOT NULL,
        subject TEXT NOT NULL,
        fact TEXT NOT NULL,
        ts TEXT NOT NULL,
        source_ref TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        origin TEXT NOT NULL DEFAULT 'user-stated',
        superseded_by INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_memo_facts_active ON memo_facts(domain, status);
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
    // Migration wave 3: hermes → neo (2026-07-20 coordinator rename). Runs after wave 2 so
    // moderator→rami→hermes→neo chains. Unlike earlier waves, the coordinator's mail identity
    // and goal-lead rows move too: briefs read unreadMailFor(coordinator) and must keep seeing
    // pre-rename unread mail; goal cards keep a live lead to chat with.
    const WAVE3: Array<[string, string]> = [
      ["role_permissions", "role"], ["mail", "from_agent"], ["mail", "to_agent"], ["goals", "lead"],
    ];
    for (const [table, col] of WAVE3) {
      try {
        this.db.prepare(`UPDATE OR REPLACE ${table} SET ${col} = 'neo' WHERE ${col} = 'hermes'`).run();
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
      "SELECT * FROM goals WHERE status IN ('planning','running','replanning') AND legacy = 0 ORDER BY created_at ASC",
    ).all() as unknown as GoalRow[];
  }

  pausedBudgetGoals(): GoalRow[] {
    return this.db.prepare("SELECT * FROM goals WHERE status = 'paused-budget' AND legacy = 0 ORDER BY created_at ASC")
      .all() as unknown as GoalRow[];
  }

  pausedSessionGoals(): GoalRow[] {
    return this.db.prepare("SELECT * FROM goals WHERE status = 'paused-session' AND legacy = 0 ORDER BY created_at ASC")
      .all() as unknown as GoalRow[];
  }

  pausedApiGoals(): GoalRow[] {
    return this.db.prepare("SELECT * FROM goals WHERE status = 'paused-api' AND legacy = 0 ORDER BY created_at ASC")
      .all() as unknown as GoalRow[];
  }

  /** Test/ops helper mirroring the freeze migration: mark all current rows legacy. */
  freezeLegacyGoals(): void {
    this.db.exec("UPDATE goals SET legacy = 1");
  }

  updateGoalStatus(id: string, status: GoalStatus, error?: string): void {
    this.db.prepare("UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, error ?? null, new Date().toISOString(), id);
  }

  setGoalProjectDir(id: string, dir: string | null): void {
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

  /** Nodes parked for human review on still-live goals (verification-hardening §4). */
  needsReviewNodes(): Array<{
    goal_id: string; node_key: string; agent: string; artifact: string | null;
    error: string | null; finished_at: string | null; goal_title: string; goal_slug: string;
  }> {
    return this.db.prepare(
      `SELECT tn.goal_id, tn.node_key, tn.agent, tn.artifact, tn.error, tn.finished_at,
              g.title AS goal_title, g.slug AS goal_slug
       FROM task_nodes tn JOIN goals g ON g.id = tn.goal_id
       WHERE tn.status = 'needs-review' AND g.status NOT IN ('done', 'failed', 'abandoned')
       ORDER BY tn.finished_at DESC`,
    ).all() as unknown as Array<{
      goal_id: string; node_key: string; agent: string; artifact: string | null;
      error: string | null; finished_at: string | null; goal_title: string; goal_slug: string;
    }>;
  }

  updateNodeStatus(goalId: string, key: string, status: NodeStatus, error?: string): void {
    const now = new Date().toISOString();
    const stamps =
      status === "running" ? ", started_at = ?" :
      status === "done" || status === "failed" || status === "skipped" || status === "needs-review" ? ", finished_at = ?" : "";
    const sql = `UPDATE task_nodes SET status = ?, error = ?${stamps} WHERE goal_id = ? AND node_key = ?`;
    const args: SQLInputValue[] = stamps ? [status, error ?? null, now, goalId, key] : [status, error ?? null, goalId, key];
    this.db.prepare(sql).run(...args);
  }

  /** Rewrite one node's dependency list (M4 resume re-wiring). */
  updateNodeDeps(goalId: string, nodeKey: string, deps: string[]): void {
    this.db.prepare("UPDATE task_nodes SET depends_on = ? WHERE goal_id = ? AND node_key = ?")
      .run(JSON.stringify(deps), goalId, nodeKey);
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

  /** Raw journal insert. Throws on a (goal_id, gseq) UNIQUE conflict — that throw IS
   *  the optimistic-claim-loss signal; journal.ts interprets it. */
  journalInsert(goalId: string, gseq: number, type: string, payloadJson: string, ts: number): number {
    const r = this.db.prepare(
      "INSERT INTO goal_journal (goal_id, gseq, type, payload, ts) VALUES (?, ?, ?, ?, ?)",
    ).run(goalId, gseq, type, payloadJson, ts);
    return Number(r.lastInsertRowid);
  }

  journalRead(goalId: string): JournalRow[] {
    return this.db.prepare("SELECT * FROM goal_journal WHERE goal_id = ? ORDER BY gseq ASC")
      .all(goalId) as unknown as JournalRow[];
  }

  budgetAdd(date: string, cents: number): void {
    this.db.prepare(
      `INSERT INTO budget_ledger (date, spent_cents) VALUES (?, ?)
       ON CONFLICT(date) DO UPDATE SET spent_cents = spent_cents + excluded.spent_cents`,
    ).run(date, cents);
  }

  costAdd(agent: string, date: string, cents: number): void {
    this.db.prepare(
      `INSERT INTO cost_daily (agent, date, usd_cents, runs) VALUES (?, ?, ?, 1)
       ON CONFLICT(agent, date) DO UPDATE SET
         usd_cents = usd_cents + excluded.usd_cents, runs = runs + 1`,
    ).run(agent, date, cents);
  }

  costsByAgent(sinceDate?: string): Array<{ agent: string; usd_cents: number; runs: number }> {
    return this.db.prepare(
      `SELECT agent, SUM(usd_cents) AS usd_cents, SUM(runs) AS runs FROM cost_daily
       WHERE date >= ? GROUP BY agent ORDER BY usd_cents DESC, agent`,
    ).all(sinceDate ?? "0000-00-00") as never;
  }

  costsByDay(days: number): Array<{ date: string; usd_cents: number }> {
    return (this.db.prepare(
      `SELECT date, SUM(usd_cents) AS usd_cents FROM cost_daily
       GROUP BY date ORDER BY date DESC LIMIT ?`,
    ).all(days) as Array<{ date: string; usd_cents: number }>).reverse();
  }

  /** Raw per-agent-per-day rows — callers canonicalize alias names themselves
   *  (the router emits alias names on mention paths, so cost_daily can hold both). */
  costRows(sinceDate: string): Array<{ agent: string; date: string; usd_cents: number }> {
    return this.db.prepare(
      `SELECT agent, date, usd_cents FROM cost_daily WHERE date >= ? ORDER BY date, agent`,
    ).all(sinceDate) as never;
  }

  pruneEvents(beforeIso: string): number {
    const r = this.db.prepare(`DELETE FROM events WHERE ts < ?`).run(beforeIso);
    return Number(r.changes);
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
                         chain_depth, status, error, thread_id, in_reply_to, from_node, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.id, m.from_agent, m.to_agent, m.kind, m.body, m.goal_id, m.origin_channel, m.origin_chat_id,
          m.chain_depth, m.status, m.error, m.thread_id ?? m.id, m.in_reply_to ?? null, m.from_node ?? null, new Date().toISOString());
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
      "SELECT * FROM mail WHERE to_agent = ? AND status = 'unread' ORDER BY created_at ASC, rowid ASC",
    ).all(agent) as unknown as MailRow[];
  }

  /** Unread inbound count per recipient (status='unread' — same set injectionFor drains).
   *  Excludes queued/spawned requests (work, not messages) and already-read mail. */
  unreadCountsByAgent(): Record<string, number> {
    // The human's inbox is a separate surface (unreadUserInbox) — exclude it from agent badges.
    const rows = this.db.prepare(
      "SELECT to_agent, COUNT(*) AS c FROM mail WHERE status = 'unread' AND to_agent != 'user' GROUP BY to_agent",
    ).all() as unknown as Array<{ to_agent: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.to_agent] = r.c;
    return out;
  }

  refusedMailFrom(agent: string): MailRow[] {
    return this.db.prepare(
      "SELECT * FROM mail WHERE from_agent = ? AND status = 'refused' AND read_at IS NULL ORDER BY created_at ASC, rowid ASC",
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
      "SELECT * FROM mail WHERE kind = 'request' AND status = 'queued' ORDER BY created_at ASC, rowid ASC",
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
    return this.db.prepare("SELECT * FROM mail WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(threadId) as unknown as MailRow[];
  }

  listMailThreadIds(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT thread_id FROM mail").all() as unknown as Array<{ thread_id: string }>;
    return rows.map((r) => r.thread_id);
  }

  /** Thread summaries for conversations involving the human, newest activity first.
   *  pending_ask is DERIVED like pendingUserAsks (a reply carrying in_reply_to answers it). */
  userThreads(limit = 100): UserThreadRow[] {
    return this.db.prepare(`
      SELECT t.thread_id,
             l.created_at AS last_ts, l.from_agent AS last_from, substr(l.body, 1, 160) AS last_body,
             t.unread, t.pending_ask, t.refused
      FROM (
        SELECT thread_id,
               SUM(CASE WHEN status = 'unread' AND to_agent = 'user' THEN 1 ELSE 0 END) AS unread,
               SUM(CASE WHEN kind = 'request' AND to_agent = 'user' AND status = 'awaiting-human'
                         AND id NOT IN (SELECT in_reply_to FROM mail WHERE in_reply_to IS NOT NULL)
                        THEN 1 ELSE 0 END) AS pending_ask,
               SUM(CASE WHEN status = 'refused' THEN 1 ELSE 0 END) AS refused
        FROM mail
        WHERE thread_id IN (SELECT DISTINCT thread_id FROM mail WHERE from_agent = 'user' OR to_agent = 'user')
        GROUP BY thread_id
      ) t
      JOIN mail l ON l.rowid = (
        SELECT rowid FROM mail WHERE thread_id = t.thread_id ORDER BY created_at DESC, rowid DESC LIMIT 1
      )
      ORDER BY l.created_at DESC, l.rowid DESC
      LIMIT ?
    `).all(limit) as unknown as UserThreadRow[];
  }

  unreadUserInbox(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM mail WHERE status = 'unread' AND to_agent = 'user'")
      .get() as { c: number }).c;
  }

  /** Newest mail answering a given request (report/refusal-note carrying in_reply_to). */
  mailAnsweringRequest(requestId: string): MailRow | undefined {
    return this.db.prepare("SELECT * FROM mail WHERE in_reply_to = ? ORDER BY created_at DESC LIMIT 1")
      .get(requestId) as MailRow | undefined;
  }

  /** Unanswered questions addressed to the human, oldest first. Answered-ness is DERIVED
   *  (a report carrying in_reply_to exists) — the request's own status never changes. */
  pendingUserAsks(): MailRow[] {
    return this.db.prepare(
      "SELECT * FROM mail WHERE kind = 'request' AND to_agent = 'user' AND status = 'awaiting-human' " +
      "AND id NOT IN (SELECT in_reply_to FROM mail WHERE in_reply_to IS NOT NULL) " +
      "ORDER BY created_at ASC, rowid ASC",
    ).all() as unknown as MailRow[];
  }

  /** Same, filtered to one asking agent (drives the chat @agent-answer intercept). */
  pendingUserAsksFrom(agent: string): MailRow[] {
    return this.db.prepare(
      "SELECT * FROM mail WHERE kind = 'request' AND to_agent = 'user' AND status = 'awaiting-human' " +
      "AND from_agent = ? " +
      "AND id NOT IN (SELECT in_reply_to FROM mail WHERE in_reply_to IS NOT NULL) " +
      "ORDER BY created_at ASC, rowid ASC",
    ).all(agent) as unknown as MailRow[];
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
    return this.db.prepare("SELECT * FROM goals WHERE status = 'awaiting-mail' AND legacy = 0 ORDER BY created_at ASC")
      .all() as unknown as GoalRow[];
  }

  private inTx = false;

  /** True while inside transaction() — journal appends join instead of nesting. */
  get inTransaction(): boolean { return this.inTx; }

  transaction<T>(fn: () => T): T {
    // node:sqlite has no nested transactions/savepoints here — nesting would roll back the
    // OUTER transaction from the inner catch and mask the real error. Fail loudly instead.
    if (this.inTx) throw new Error("Store.transaction(): nesting not supported — compose one outer transaction");
    this.db.exec("BEGIN IMMEDIATE");
    this.inTx = true;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.inTx = false;
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
        `INSERT INTO trust (action_type, state, approvals, rejections, streak, shadow_matches, first_seen, last_rejection, graduated_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(action_type) DO UPDATE SET
           state=excluded.state, approvals=excluded.approvals, rejections=excluded.rejections,
           streak=excluded.streak, shadow_matches=excluded.shadow_matches, last_rejection=excluded.last_rejection,
           graduated_at=excluded.graduated_at, updated_at=excluded.updated_at`,
      )
      .run(
        t.actionType, t.state, t.approvals, t.rejections, t.streak, t.shadowMatches,
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
                              trust_state, verdict_by, reject_reason, result, created_at, resolved_at, expires_at,
                              idempotency_key, shadow_decision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id, a.type, a.payload, a.preview, a.status, a.origin_channel, a.origin_chat_id,
        a.trust_state, a.verdict_by, a.reject_reason, a.result, a.created_at, a.resolved_at, a.expires_at,
        a.idempotency_key ?? null, a.shadow_decision ?? null,
      );
  }

  getAction(id: string): ActionRow | undefined {
    return this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as ActionRow | undefined;
  }

  actionByIdempotencyKey(key: string): ActionRow | undefined {
    return this.db.prepare("SELECT * FROM actions WHERE idempotency_key = ?").get(key) as ActionRow | undefined;
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

  /** Per-type shadow scoring: human verdicts on actions proposed while graduating.
   *  match = approved (executed/failed with a verdict), mismatch = rejected (spec §6). */
  shadowStats(): Array<{ type: string; matches: number; mismatches: number }> {
    return this.db.prepare(
      `SELECT type,
              SUM(CASE WHEN status IN ('executed', 'failed') AND verdict_by IS NOT NULL THEN 1 ELSE 0 END) AS matches,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS mismatches
       FROM actions WHERE shadow_decision IS NOT NULL GROUP BY type ORDER BY type`,
    ).all() as unknown as Array<{ type: string; matches: number; mismatches: number }>;
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

  // ---- routines (spec 2026-07-15) ----

  addRoutine(r: { name: string; prompt: string; recurrence: string; originChannel?: string; originChatId?: string }): number {
    const res = this.db
      .prepare(
        `INSERT INTO routines (name, prompt, recurrence, origin_channel, origin_chat_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(r.name, r.prompt, r.recurrence, r.originChannel ?? null, r.originChatId ?? null, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  getRoutine(id: number): RoutineRow | undefined {
    return this.db.prepare("SELECT * FROM routines WHERE id = ?").get(id) as RoutineRow | undefined;
  }

  listRoutines(): RoutineRow[] {
    return this.db.prepare("SELECT * FROM routines ORDER BY id").all() as unknown as RoutineRow[];
  }

  updateRoutine(id: number, patch: { name?: string; prompt?: string; recurrence?: string; enabled?: boolean }): boolean {
    const row = this.getRoutine(id);
    if (!row) return false;
    const res = this.db
      .prepare("UPDATE routines SET name = ?, prompt = ?, recurrence = ?, enabled = ? WHERE id = ?")
      .run(
        patch.name ?? row.name,
        patch.prompt ?? row.prompt,
        patch.recurrence ?? row.recurrence,
        patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
        id,
      );
    return res.changes > 0;
  }

  deleteRoutine(id: number): boolean {
    return this.db.prepare("DELETE FROM routines WHERE id = ?").run(id).changes > 0;
  }

  /**
   * CAS stamp before fire (at-most-once, mirrors claimDueReminders): guards on
   * the exact last_fired_at the due-test saw, so a stale read can never
   * double-fire. `IS ?` handles the NULL initial state.
   */
  stampRoutineFired(id: number, expectLastFiredAt: string | null, dateLocal: string, atIso: string): boolean {
    const res = this.db
      .prepare("UPDATE routines SET last_fired_date = ?, last_fired_at = ? WHERE id = ? AND last_fired_at IS ?")
      .run(dateLocal, atIso, id, expectLastFiredAt);
    return res.changes > 0;
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
    doc: { source: string; ref: string; domain: string; labels?: string[]; origin?: string; title: string; body: string; ts: string; len: number; fingerprint: string },
    postings: Array<[string, number]>,
  ): number {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      const existing = this.db.prepare("SELECT id FROM memory_doc WHERE source = ? AND ref = ?").get(doc.source, doc.ref) as { id: number } | undefined;
      if (existing) {
        this.db.prepare("DELETE FROM memory_token WHERE doc_id = ?").run(existing.id);
        this.db.prepare("DELETE FROM entity_link WHERE doc_id = ?").run(existing.id);
        this.db.prepare("DELETE FROM memory_vec WHERE doc_id = ?").run(existing.id);
        this.db.prepare("DELETE FROM memory_doc WHERE id = ?").run(existing.id);
      }
      const res = this.db
        .prepare(`INSERT INTO memory_doc (source, ref, domain, labels, origin, title, body, ts, len, fingerprint, indexed_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(doc.source, doc.ref, doc.domain, JSON.stringify(doc.labels ?? []), doc.origin ?? "trusted", doc.title, doc.body, doc.ts, doc.len, doc.fingerprint, now);
      const docId = Number(res.lastInsertRowid);
      const ins = this.db.prepare("INSERT INTO memory_token (token, doc_id, tf) VALUES (?, ?, ?)");
      for (const [token, tf] of postings) ins.run(token, docId, tf);
      this.db.exec("COMMIT");
      return docId;
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
      this.db.prepare("DELETE FROM entity_link WHERE doc_id = ?").run(row.id);
      this.db.prepare("DELETE FROM memory_vec WHERE doc_id = ?").run(row.id);
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

  memoryPostings(tokens: string[], domain?: string): Array<{ token: string; doc_id: number; tf: number; len: number; domain: string; labels: string; source: string; ref: string; ts: string }> {
    if (!tokens.length) return [];
    const ph = tokens.map(() => "?").join(", ");
    const sql = `SELECT t.token, t.doc_id, t.tf, d.len, d.domain, d.labels, d.source, d.ref, d.ts
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

  memoryDocsMeta(ids: number[]): Array<{ id: number; source: string; ref: string; domain: string; ts: string; labels: string; indexed_at: string; last_retrieved_at: string | null }> {
    if (!ids.length) return [];
    const ph = ids.map(() => "?").join(", ");
    return this.db.prepare(
      `SELECT id, source, ref, domain, ts, labels, indexed_at, last_retrieved_at FROM memory_doc WHERE id IN (${ph})`,
    ).all(...ids) as never;
  }

  logMemoryUse(query: string, docIds: number[], tsIso?: string): void {
    this.db.prepare("INSERT INTO memory_use (query, doc_ids, ts) VALUES (?, ?, ?)")
      .run(query, JSON.stringify(docIds), tsIso ?? new Date().toISOString());
  }

  pruneMemoryUse(beforeIso: string): number {
    return Number(this.db.prepare("DELETE FROM memory_use WHERE ts < ?").run(beforeIso).changes);
  }

  touchMemoryDocs(ids: number[], nowIso: string): void {
    if (!ids.length) return;
    const stmt = this.db.prepare("UPDATE memory_doc SET last_retrieved_at = ? WHERE id = ?");
    for (const id of ids) stmt.run(nowIso, id);
  }

  /** Test helper: backdate indexed_at to exercise the stale-penalty window. */
  backdateMemoryDocForTest(source: string, ref: string, indexedAtIso: string): void {
    this.db.prepare("UPDATE memory_doc SET indexed_at = ? WHERE source = ? AND ref = ?").run(indexedAtIso, source, ref);
  }

  // ---- vectors (memory-v2 §3) ----

  upsertMemoryVec(docId: number, vec: Float32Array): void {
    this.db.prepare("INSERT INTO memory_vec (doc_id, vec) VALUES (?, ?) ON CONFLICT(doc_id) DO UPDATE SET vec = excluded.vec")
      .run(docId, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
  }

  memoryVecs(domain?: string): Array<{ doc_id: number; vec: Float32Array }> {
    const rows = (domain
      ? this.db.prepare("SELECT v.doc_id, v.vec FROM memory_vec v JOIN memory_doc d ON d.id = v.doc_id WHERE d.domain = ?").all(domain)
      : this.db.prepare("SELECT doc_id, vec FROM memory_vec").all()) as Array<{ doc_id: number; vec: Uint8Array }>;
    return rows.map((r) => ({ doc_id: r.doc_id, vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4) }));
  }

  missingVecDocs(cap: number): Array<{ id: number; title: string; body: string }> {
    return this.db.prepare(
      `SELECT d.id, d.title, d.body FROM memory_doc d LEFT JOIN memory_vec v ON v.doc_id = d.id
       WHERE v.doc_id IS NULL ORDER BY d.id LIMIT ?`,
    ).all(cap) as never;
  }

  // ---- entities (memory-v2 §3) ----

  upsertEntity(e: { name: string; kind: string; aliases: string[] }): number {
    const existing = this.db.prepare("SELECT id, aliases FROM entities WHERE name = ? AND kind = ?").get(e.name, e.kind) as { id: number; aliases: string } | undefined;
    if (existing) {
      const merged = [...new Set([...(JSON.parse(existing.aliases) as string[]), ...e.aliases])];
      this.db.prepare("UPDATE entities SET aliases = ? WHERE id = ?").run(JSON.stringify(merged), existing.id);
      return existing.id;
    }
    const res = this.db.prepare("INSERT INTO entities (name, kind, aliases) VALUES (?, ?, ?)").run(e.name, e.kind, JSON.stringify(e.aliases));
    return Number(res.lastInsertRowid);
  }

  listEntities(): Array<{ id: number; name: string; kind: string; aliases: string[] }> {
    return (this.db.prepare("SELECT * FROM entities").all() as Array<{ id: number; name: string; kind: string; aliases: string }>)
      .map((r) => ({ ...r, aliases: JSON.parse(r.aliases) as string[] }));
  }

  replaceEntityLinks(docId: number, entityIds: number[]): void {
    this.db.prepare("DELETE FROM entity_link WHERE doc_id = ?").run(docId);
    const ins = this.db.prepare("INSERT OR IGNORE INTO entity_link (doc_id, entity_id) VALUES (?, ?)");
    for (const id of entityIds) ins.run(docId, id);
  }

  docsLinkedToEntities(entityIds: number[]): number[] {
    if (!entityIds.length) return [];
    const ph = entityIds.map(() => "?").join(", ");
    return (this.db.prepare(`SELECT DISTINCT doc_id FROM entity_link WHERE entity_id IN (${ph})`).all(...entityIds) as Array<{ doc_id: number }>).map((r) => r.doc_id);
  }

  /** Entity seeding source: distinct bank counterparties. NAMES ONLY — used purely for query
   *  expansion; transaction data itself stays out of memory (pinned exclusion). */
  distinctCounterparties(): string[] {
    return (this.db.prepare("SELECT DISTINCT counterparty FROM personal_transactions WHERE counterparty IS NOT NULL AND counterparty != ''").all() as Array<{ counterparty: string }>).map((r) => r.counterparty);
  }

  memoryTitlesSince(sinceIndexedAt: string, cap: number): Array<{ title: string; indexed_at: string }> {
    return this.db.prepare(
      "SELECT title, indexed_at FROM memory_doc WHERE indexed_at > ? ORDER BY indexed_at ASC LIMIT ?",
    ).all(sinceIndexedAt, cap) as never;
  }

  // ---- teachings ----

  addTeaching(t: { text: string; domain: string | null; kind: string; origin?: string }): number {
    const res = this.db
      .prepare("INSERT INTO teachings (text, domain, kind, origin, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(t.text, t.domain, t.kind, t.origin ?? "user-stated", new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  getTeaching(id: number): TeachingRow | undefined {
    return this.db.prepare("SELECT * FROM teachings WHERE id = ?").get(id) as TeachingRow | undefined;
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

  // ---- memo facts (memory-v2 §4) ----

  addMemoFact(f: { domain: string; subject: string; fact: string; sourceRef?: string; origin: string; ts?: string }): number {
    const res = this.db
      .prepare("INSERT INTO memo_facts (domain, subject, fact, ts, source_ref, origin) VALUES (?, ?, ?, ?, ?, ?)")
      .run(f.domain, f.subject, f.fact, f.ts ?? new Date().toISOString(), f.sourceRef ?? null, f.origin);
    return Number(res.lastInsertRowid);
  }

  activeMemoFacts(domain?: string): MemoFactRow[] {
    const rows = domain
      ? this.db.prepare("SELECT * FROM memo_facts WHERE status = 'active' AND domain = ? ORDER BY subject, id").all(domain)
      : this.db.prepare("SELECT * FROM memo_facts WHERE status = 'active' ORDER BY domain, subject, id").all();
    return rows as unknown as MemoFactRow[];
  }

  supersedeMemoFact(id: number, byId: number | null): void {
    this.db.prepare("UPDATE memo_facts SET status = 'superseded', superseded_by = ? WHERE id = ?").run(byId, id);
  }

  memoryDocBody(source: string, ref: string): string | undefined {
    const r = this.db.prepare("SELECT body FROM memory_doc WHERE source = ? AND ref = ?").get(source, ref) as { body: string } | undefined;
    return r?.body;
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
    shadowMatches: (r.shadow_matches as number) ?? 0,
    firstSeen: r.first_seen as string,
    lastRejection: (r.last_rejection as string) ?? null,
    graduatedAt: (r.graduated_at as string) ?? null,
  };
}
