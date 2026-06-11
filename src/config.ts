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
