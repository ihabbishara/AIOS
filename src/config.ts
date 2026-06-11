import { homedir } from "node:os";
import { join } from "node:path";
import "dotenv/config";

export interface Config {
  vaultPath: string;
  vaultSubdir: string;
  dataDir: string;
  dbPath: string;
  playbooksDir: string;
  projectsRoot: string;
  telegramToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  maxConcurrentJobs: number;
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

export function loadConfig(root = process.cwd()): Config {
  const home = homedir();
  const dataDir = process.env.AIOS_DATA_DIR ?? join(root, "data");
  return {
    vaultPath: process.env.AIOS_VAULT_PATH ?? join(home, "Desktop", "AI-Vault"),
    vaultSubdir: process.env.AIOS_VAULT_SUBDIR ?? "AIOS",
    dataDir,
    dbPath: join(dataDir, "aios.sqlite"),
    playbooksDir: process.env.AIOS_PLAYBOOKS_DIR ?? join(root, "playbooks"),
    projectsRoot: process.env.AIOS_PROJECTS_ROOT ?? join(home, "projects"),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN,
    maxConcurrentJobs: Number(process.env.AIOS_MAX_CONCURRENT_JOBS ?? 1),
    jobWallTimeMs: Number(process.env.AIOS_JOB_WALL_TIME_MS ?? 2 * 60 * 60 * 1000),
    moderatorModel: process.env.AIOS_MODERATOR_MODEL,
    specialistModel: process.env.AIOS_SPECIALIST_MODEL,
    chatBindings: parseBindings(process.env.AIOS_CHAT_BINDINGS),
    financeCompany: process.env.AIOS_FINANCE_COMPANY ?? "IDAMA",
    financeMembers: parseMembers(process.env.AIOS_FINANCE_MEMBERS),
  };
}

export function assertAuth(): void {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "[aios] WARNING: CLAUDE_CODE_OAUTH_TOKEN is not set. " +
        "Run `claude setup-token` and put the token in .env to use your Claude subscription.",
    );
  }
}
