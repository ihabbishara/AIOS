import { loadConfig, assertAuth } from "./config.js";
import { Store } from "./store/db.js";
import { VaultWriter } from "./vault/writer.js";
import { loadPlaybooks } from "./engine/playbook.js";
import { JobManager, type JobOutcome } from "./engine/jobs.js";
import { runSpecialist } from "./agents/runner.js";
import { Moderator } from "./moderator/session.js";
import { CliChannel } from "./channels/cli.js";
import { TelegramChannel } from "./channels/telegram.js";
import { SlackChannel } from "./channels/slack.js";
import type { ChannelAdapter } from "./channels/types.js";

const log = (line: string) => console.log(`[aios ${new Date().toISOString()}] ${line}`);

async function main(): Promise<void> {
  const config = loadConfig();
  assertAuth();

  const store = new Store(config.dbPath);
  const vault = new VaultWriter(config.vaultPath, config.vaultSubdir);
  vault.init();
  const playbooks = loadPlaybooks(config.playbooksDir);
  log(`playbooks: ${[...playbooks.keys()].join(", ")}`);

  const channels = new Map<string, ChannelAdapter>();

  const onJobComplete = async (outcome: JobOutcome): Promise<void> => {
    const { job } = outcome;
    const channel = channels.get(job.channel);
    const notice = outcome.ok
      ? `[JOB-COMPLETE] Job "${job.title}" (${job.id}) finished. Artifacts in vault under jobs/${outcome.jobDirName}/: ${outcome.artifactFiles.join(", ")}. Read the key artifacts with vault_read and report the outcome to the user.`
      : `[JOB-FAILED] Job "${job.title}" (${job.id}) failed: ${outcome.error}. Partial artifacts under jobs/${outcome.jobDirName}/. Tell the user what happened and suggest next steps.`;
    const report = await moderator.handle(job.channel, job.chat_id, notice);
    await channel?.send(job.chat_id, report);
  };

  const jobs = new JobManager({
    store,
    vault,
    run: runSpecialist,
    playbooks,
    wallTimeMs: config.jobWallTimeMs,
    maxConcurrent: config.maxConcurrentJobs,
    model: config.specialistModel,
    onComplete: onJobComplete,
    log,
  });

  const moderator = new Moderator({
    store,
    jobs,
    vault,
    projectsRoot: config.projectsRoot,
    model: config.moderatorModel,
    log,
  });

  const onMessage = async (msg: { channel: string; chatId: string; text: string }): Promise<void> => {
    log(`<- ${msg.channel}:${msg.chatId} ${msg.text.slice(0, 80)}`);
    try {
      const reply = await moderator.handle(msg.channel, msg.chatId, msg.text);
      await channels.get(msg.channel)?.send(msg.chatId, reply);
    } catch (err) {
      log(`handler error: ${(err as Error).stack}`);
      await channels.get(msg.channel)?.send(msg.chatId, `Error: ${(err as Error).message}`);
    }
  };

  // Channels: CLI only with --cli flag (interactive dev); bots whenever tokens exist.
  if (process.argv.includes("--cli") || (!config.telegramToken && !config.slackBotToken)) {
    channels.set("cli", new CliChannel());
  }
  if (config.telegramToken) {
    const allowed = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(",").map((s) => Number(s.trim())).filter(Boolean);
    channels.set("telegram", new TelegramChannel(config.telegramToken, allowed));
  }
  if (config.slackBotToken && config.slackAppToken) {
    channels.set("slack", new SlackChannel(config.slackBotToken, config.slackAppToken));
  }

  for (const [name, ch] of channels) {
    await ch.start(onMessage);
    log(`channel up: ${name}`);
  }

  const resumed = jobs.resumeUnfinished();
  if (resumed) log(`resumed ${resumed} unfinished job(s)`);

  const shutdown = async () => {
    log("shutting down");
    for (const ch of channels.values()) await ch.stop().catch(() => {});
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log("aios daemon running");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
