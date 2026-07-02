import { homedir } from "node:os";
import { join } from "node:path";
import "dotenv/config";
import type { TrustPolicy, TrustState } from "./kernel/trust.js";

export interface Config {
  vaultPath: string;
  vaultSubdir: string;
  dataDir: string;
  dbPath: string;
  playbooksDir: string;
  agentsDir: string;
  projectsRoot: string;
  workspaceRoot: string;
  codeReadRoots: string[];
  codeDisabled: boolean;
  telegramToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  maxConcurrentJobs: number;
  maxConcurrentNodes: number;
  /** Daily global spend cap in dollars; undefined = unlimited. */
  dailyBudgetUsd?: number;
  jobWallTimeMs: number;
  moderatorModel?: string;
  specialistModel?: string;
  /**
   * chatKey ("channel:chatId") -> binding. Bound chats bypass the moderator.
   * "telegram:-100123=finance|halalo": first agent handles every message, rest via @role.
   * "telegram:-100123=@finance|@halalo": mention-only — agents respond ONLY when
   * addressed (@finance ...); other messages are ignored silently. Attachments
   * still route to the first agent (receipt drops shouldn't need a caption).
   */
  chatBindings: Map<string, ChatBinding>;
  financeCompany: string;
  financeMembers: FinanceMember[];
  uiPort: number;
  envPath: string;
  uiDist: string;
  /** How long a queued approval stays valid (ms). */
  actionExpiryMs: number;
  trustPolicy: TrustPolicy;
  /** Initial trust states applied at startup for types with no existing record. */
  trustSeeds: Map<string, TrustState>;
  /** Where briefs and notify_now pings go ("channel:chatId"). Unset: vault-only briefs. */
  primaryChat?: { channel: string; chatId: string };
  /** Local times, "HH:MM". */
  anchorMorning: string;
  anchorEvening: string;
  /** Local time "HH:MM" for the nightly dream cycle. */
  anchorDream: string;
  /** Max initiatives the dream cycle surfaces in the morning brief. */
  dreamTopN: number;
  /** Model for the dream-cycle ranker one-shot (defaults to specialistModel). */
  dreamModel?: string;
  /** Local time "HH:MM" for the nightly speculate (overnight research) pass. */
  anchorSpeculate: string;
  /** Hard cap on research-report jobs the speculate pass enqueues per night. */
  speculateMaxJobs: number;
  /** Model for the speculate planner one-shot (defaults to specialistModel). */
  speculateModel?: string;
  /** Kill-switch for the overnight email-drafts pass (AIOS_SPECULATE_EMAIL_DISABLED=1). Feature is on by default. */
  speculateEmailDisabled: boolean;
  /** Google account the email-drafts pass scans (default: first enabled account). */
  speculateEmailAccount?: string;
  /** Hard cap on email drafts the pass queues per night. */
  speculateEmailMaxJobs: number;
  /** Model for the email triage/compose one-shots (defaults to specialistModel). */
  speculateEmailModel?: string;
  /** Model for the triage classifier one-shot. */
  triageModel: string;
  /** Voice kill-switch (AIOS_VOICE_ENABLED=false disables STT/TTS everywhere). */
  voiceEnabled: boolean;
  /** Whisper ggml model name: base | small | medium. */
  whisperModel: string;
  /** Kokoro voice id; "say" forces the macOS fallback. */
  ttsVoice: string;
  gmailPollSeconds: number;
  calendarPollSeconds: number;
  meetingPingMinutes: number;
  /** Gmail categories never emitted as events (lowercase, e.g. "promotions"). */
  gmailSkipCategories: string[];
  /** Vault reindex sweep interval (seconds). */
  memoReindexSeconds: number;
  /** Model for the memory curator one-shot (defaults to specialistModel). */
  curatorModel?: string;
  /** Bunq environment: "sandbox" | "production". */
  bunqEnv: string;
  bunqPollSeconds: number;
  bunqBackfillDays: number;
  /** Path to the persisted bunq API context (0600). */
  bunqContextPath: string;
  /** Read-only python helper + one-time setup script paths. */
  bunqHelperPath: string;
  bunqSetupPath: string;
  /** Python interpreter for the bunq helper. */
  pythonBin: string;
  /** How often the money poller runs (seconds). */
  moneyPollSeconds: number;
  /** Debit threshold (cents) for large-transaction signals. */
  moneyLargeTxCents: number;
  /** Days ahead to warn about an upcoming subscription renewal. */
  moneyRenewalDays: number;
  /** How often the lifeops watcher runs (seconds). */
  lifeopsPollSeconds: number;
  /** Days ahead to flag a task as "due soon". */
  lifeopsSoonDays: number;
  /** Days since last update before a task is flagged as stale. */
  lifeopsStaleDays: number;
}

export interface FinanceMember {
  name: string;
  /** Platform username/handle for auto-attribution (Telegram username, Slack display name). */
  handle?: string;
}

/** Parses "Ihab:theAmsterdamer,Amr:amr_tg,Sara" — handle part optional per member. */
export function parseMembers(raw: string | undefined): FinanceMember[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, handle] = entry.split(":").map((s) => s.trim().replace(/^@/, ""));
      return { name, ...(handle ? { handle } : {}) };
    });
}

export interface ChatBinding {
  agents: string[];
  /** When true, agents only respond to @agent-addressed messages (and attachments). */
  mentionOnly: boolean;
}

/** Parses "vault.write=autonomous,test.echo=supervised" — unknown states are ignored. */
export function parseTrustSeeds(raw: string | undefined): Map<string, TrustState> {
  const map = new Map<string, TrustState>();
  for (const pair of (raw ?? "").split(",")) {
    const [type, state] = pair.split("=").map((s) => s.trim());
    if (type && (state === "autonomous" || state === "supervised")) map.set(type, state);
  }
  return map;
}

/** Parses "telegram:12345" → {channel, chatId}. Splits on the FIRST colon only. */
export function parsePrimaryChat(raw: string | undefined): { channel: string; chatId: string } | undefined {
  if (!raw) return undefined;
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) return undefined;
  return { channel: raw.slice(0, idx), chatId: raw.slice(idx + 1) };
}

export function parseBindings(raw: string | undefined): Map<string, ChatBinding> {
  const map = new Map<string, ChatBinding>();
  for (const pair of (raw ?? "").split(",")) {
    const [chatKey, agents] = pair.split("=").map((s) => s.trim());
    if (!chatKey || !agents) continue;
    const entries = agents.split("|").map((s) => s.trim()).filter(Boolean);
    if (!entries.length) continue;
    map.set(chatKey, {
      agents: entries.map((e) => e.replace(/^@/, "")),
      mentionOnly: entries.every((e) => e.startsWith("@")),
    });
  }
  return map;
}

export function buildConfig(env: NodeJS.ProcessEnv = process.env, root = process.cwd()): Config {
  const home = homedir();
  const dataDir = process.env.AIOS_DATA_DIR ?? join(root, "data");
  const projectsRoot = process.env.AIOS_PROJECTS_ROOT ?? join(home, "projects");
  return {
    vaultPath: process.env.AIOS_VAULT_PATH ?? join(home, "Desktop", "AI-Vault"),
    vaultSubdir: process.env.AIOS_VAULT_SUBDIR ?? "AIOS",
    dataDir,
    dbPath: join(dataDir, "aios.sqlite"),
    playbooksDir: process.env.AIOS_PLAYBOOKS_DIR ?? join(root, "playbooks"),
    agentsDir: env.AIOS_AGENTS_DIR ?? join(root, "agents"),
    projectsRoot,
    workspaceRoot: env.AIOS_WORKSPACE_ROOT ?? join(home, "projects", "AIOS-Workspace"),
    codeReadRoots: (env.AIOS_CODE_READ_ROOTS ?? projectsRoot)
      .split(",").map((s) => s.trim()).filter(Boolean),
    codeDisabled: env.AIOS_CODE_DISABLED === "1",
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN,
    maxConcurrentJobs: Number(process.env.AIOS_MAX_CONCURRENT_JOBS ?? 1),
    maxConcurrentNodes: Number(env.AIOS_MAX_CONCURRENT_NODES ?? 2),
    dailyBudgetUsd: env.AIOS_DAILY_BUDGET_USD ? Number(env.AIOS_DAILY_BUDGET_USD) : undefined,
    jobWallTimeMs: Number(process.env.AIOS_JOB_WALL_TIME_MS ?? 2 * 60 * 60 * 1000),
    moderatorModel: process.env.AIOS_MODERATOR_MODEL,
    specialistModel: process.env.AIOS_SPECIALIST_MODEL,
    chatBindings: parseBindings(process.env.AIOS_CHAT_BINDINGS),
    financeCompany: process.env.AIOS_FINANCE_COMPANY ?? "IDAMA",
    financeMembers: parseMembers(process.env.AIOS_FINANCE_MEMBERS),
    uiPort: Number(process.env.AIOS_UI_PORT ?? 4280),
    envPath: join(root, ".env"),
    uiDist: join(root, "ui", "dist"),
    actionExpiryMs: Number(process.env.AIOS_ACTION_EXPIRY_MS ?? 24 * 60 * 60 * 1000),
    trustPolicy: {
      graduationStreak: Number(process.env.AIOS_GRADUATION_STREAK ?? 10),
      graduationAgeDays: Number(process.env.AIOS_GRADUATION_AGE_DAYS ?? 30),
      // trust.promote is ALWAYS in the ceiling set — promotions must always be human-approved.
      alwaysSupervised: new Set([
        "trust.promote",
        "permission.grant",
        "permission.revoke",
        ...(process.env.AIOS_ALWAYS_SUPERVISED ?? "")
          .split(",").map((s) => s.trim()).filter(Boolean),
      ]),
    },
    trustSeeds: parseTrustSeeds(process.env.AIOS_TRUST_SEED ?? "vault.write=autonomous"),
    primaryChat: parsePrimaryChat(process.env.AIOS_PRIMARY_CHAT),
    anchorMorning: process.env.AIOS_ANCHOR_MORNING ?? "07:30",
    anchorEvening: process.env.AIOS_ANCHOR_EVENING ?? "21:00",
    anchorDream: process.env.AIOS_ANCHOR_DREAM ?? "02:00",
    dreamTopN: Number(process.env.AIOS_DREAM_TOP_N ?? 3),
    dreamModel: process.env.AIOS_DREAM_MODEL ?? process.env.AIOS_SPECIALIST_MODEL,
    anchorSpeculate: process.env.AIOS_ANCHOR_SPECULATE ?? "03:00",
    speculateMaxJobs: Number(process.env.AIOS_SPECULATE_MAX_JOBS ?? 2),
    speculateModel: process.env.AIOS_SPECULATE_MODEL ?? process.env.AIOS_SPECIALIST_MODEL,
    speculateEmailDisabled: process.env.AIOS_SPECULATE_EMAIL_DISABLED === "1",
    speculateEmailAccount: process.env.AIOS_SPECULATE_EMAIL_ACCOUNT,
    speculateEmailMaxJobs: Number(process.env.AIOS_SPECULATE_EMAIL_MAX_JOBS ?? 2),
    speculateEmailModel: process.env.AIOS_SPECULATE_EMAIL_MODEL ?? process.env.AIOS_SPECIALIST_MODEL,
    triageModel: process.env.AIOS_TRIAGE_MODEL ?? "claude-haiku-4-5-20251001",
    voiceEnabled: process.env.AIOS_VOICE_ENABLED !== "false",
    whisperModel: process.env.AIOS_WHISPER_MODEL ?? "base",
    ttsVoice: process.env.AIOS_TTS_VOICE ?? "af_heart",
    gmailPollSeconds: Number(process.env.AIOS_GMAIL_POLL_SECONDS ?? 120),
    calendarPollSeconds: Number(process.env.AIOS_CALENDAR_POLL_SECONDS ?? 300),
    meetingPingMinutes: Number(process.env.AIOS_MEETING_PING_MINUTES ?? 15),
    gmailSkipCategories: (process.env.AIOS_GMAIL_SKIP_CATEGORIES ?? "promotions,social")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    memoReindexSeconds: Number(process.env.AIOS_MEMO_REINDEX_SECONDS ?? 300),
    curatorModel: process.env.AIOS_CURATOR_MODEL ?? process.env.AIOS_SPECIALIST_MODEL,
    bunqEnv: process.env.AIOS_BUNQ_ENV ?? "sandbox",
    bunqPollSeconds: Number(process.env.AIOS_BUNQ_POLL_SECONDS ?? 3600),
    bunqBackfillDays: Number(process.env.AIOS_BUNQ_BACKFILL_DAYS ?? 90),
    bunqContextPath: join(dataDir, `bunq-context.${process.env.AIOS_BUNQ_ENV ?? "sandbox"}.conf`),
    bunqHelperPath: join(root, "scripts", "bunq_read.py"),
    bunqSetupPath: join(root, "scripts", "bunq-setup.py"),
    pythonBin: process.env.AIOS_PYTHON_BIN ?? "python3",
    moneyPollSeconds: Number(process.env.AIOS_MONEY_POLL_SECONDS ?? 86400),
    moneyLargeTxCents: Number(process.env.AIOS_MONEY_LARGE_TX_CENTS ?? 50000),
    moneyRenewalDays: Number(process.env.AIOS_MONEY_RENEWAL_DAYS ?? 3),
    lifeopsPollSeconds: Number(process.env.AIOS_LIFEOPS_POLL_SECONDS ?? 21600),
    lifeopsSoonDays: Number(process.env.AIOS_LIFEOPS_SOON_DAYS ?? 2),
    lifeopsStaleDays: Number(process.env.AIOS_LIFEOPS_STALE_DAYS ?? 14),
  };
}

export function loadConfig(root = process.cwd()): Config {
  return buildConfig(process.env, root);
}

export function assertAuth(): void {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "[aios] WARNING: CLAUDE_CODE_OAUTH_TOKEN is not set. " +
        "Run `claude setup-token` and put the token in .env to use your Claude subscription.",
    );
  }
}
