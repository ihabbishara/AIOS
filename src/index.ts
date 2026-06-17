import { join } from "node:path";
import { loadConfig, assertAuth } from "./config.js";
import { Store } from "./store/db.js";
import { VaultWriter } from "./vault/writer.js";
import { loadPacks } from "./packs/loader.js";
import { makeResolvePackFor } from "./packs/resolve.js";
import { JobManager, type JobOutcome } from "./engine/jobs.js";
import { makeRunSpecialist } from "./agents/runner.js";
import { Moderator } from "./moderator/session.js";
import { DirectChats } from "./agents/direct.js";
import { FinanceAgent } from "./finance/agent.js";
import { EventBus } from "./events.js";
import { MessageRouter } from "./router.js";
import { startWebServer } from "./web/server.js";
import { CliChannel } from "./channels/cli.js";
import { TelegramChannel } from "./channels/telegram.js";
import { SlackChannel } from "./channels/slack.js";
import type { ChannelAdapter } from "./channels/types.js";
import { ExecutorRegistry } from "./kernel/actions.js";
import { vaultWriteExecutor, echoExecutor, trustPromoteExecutor, permissionGrantExecutor, permissionRevokeExecutor } from "./kernel/executors.js";
import { ActionGate } from "./kernel/gate.js";
import { newRecord } from "./kernel/trust.js";
import { Clock } from "./heartbeat/clock.js";
import { Triage, modelClassifier } from "./heartbeat/triage.js";
import { runBrief } from "./heartbeat/briefs.js";
import { VoiceService } from "./voice/index.js";
import { deliverReply } from "./voice/mirror.js";
import { GoogleAccounts } from "./senses/google/auth.js";
import { GmailWatcher } from "./senses/google/gmail.js";
import { CalendarWatcher } from "./senses/google/calendar.js";
import { emailExecutors } from "./senses/google/executors.js";
import { BunqSense } from "./senses/bunq/index.js";
import { BunqSync } from "./senses/bunq/sync.js";
import { reconcile, reindexVault, indexEvent, indexDecision } from "./memory/indexer.js";
import { distill, curateLLM } from "./memory/distiller.js";
import { makeCategorizer, categoryClassifier } from "./money/categorize.js";
import { buildMoneyServer } from "./money/server.js";

const log = (line: string) => console.log(`[aios ${new Date().toISOString()}] ${line}`);

async function main(): Promise<void> {
  const config = loadConfig();
  assertAuth();

  const store = new Store(config.dbPath);
  const bus = new EventBus(store);
  const runSpecialist = makeRunSpecialist({ store, bus });
  const vault = new VaultWriter(config.vaultPath, config.vaultSubdir);
  vault.init();

  // ---- second brain: write-time indexing — registered BEFORE channels start so a
  // decision resolved during the startup window (e.g. /approve, an autonomous
  // gate.propose) is live-indexed, not just recovered on the next restart's reconcile.
  bus.on((e) => {
    try {
      if (e.event.type === "calendar.changed") indexEvent(store, e);
      else if (e.event.type === "action.executed" || e.event.type === "action.resolved") {
        indexDecision(store, e.event.actionId);
      }
    } catch (err) {
      log(`memory index (write-time) failed: ${(err as Error).message}`);
    }
  });
  const { playbooks, packs, pillarOf, roleOf } = loadPacks(config.playbooksDir, log);
  log(`playbooks: ${[...playbooks.keys()].join(", ")}`);
  log(`packs: ${[...packs.keys()].join(", ") || "(none)"}`);

  // Reload the WHOLE registry in place (after a UI playbook edit). Mutates the same Map
  // instances JobManager + resolvePackFor hold by reference, so packs/pillarOf/roleOf
  // stay in sync — the old flat reload only refreshed top-level playbooks.
  const reloadPacks = () => {
    const fresh = loadPacks(config.playbooksDir, log);
    playbooks.clear(); for (const [k, v] of fresh.playbooks) playbooks.set(k, v);
    packs.clear();     for (const [k, v] of fresh.packs) packs.set(k, v);
    pillarOf.clear();  for (const [k, v] of fresh.pillarOf) pillarOf.set(k, v);
    roleOf.clear();    for (const [k, v] of fresh.roleOf) roleOf.set(k, v);
    log(`packs reloaded: ${[...packs.keys()].join(", ") || "(none)"}`);
  };

  // ---- action gate (the only door out) ----
  const registry = new ExecutorRegistry();
  registry.register(vaultWriteExecutor(vault));
  registry.register(echoExecutor());
  registry.register(trustPromoteExecutor(store, bus));
  registry.register(permissionGrantExecutor(store, bus));
  registry.register(permissionRevokeExecutor(store, bus));

  const gate = new ActionGate({
    store, registry, policy: config.trustPolicy, bus, expiryMs: config.actionExpiryMs, log,
  });

  // Startup recovery: actions stuck mid-execution from a previous daemon death.
  // MUST run only here, before any executor can be in flight — never on an interval.
  const stale = store.failStaleExecuting(new Date().toISOString());
  if (stale.length) log(`failed ${stale.length} stale executing action(s) from previous run`);

  // Seed initial trust states (only for types with no existing record).
  for (const [type, state] of config.trustSeeds) {
    if (!store.getTrust(type)) {
      const rec = newRecord(type, new Date().toISOString());
      store.upsertTrust(state === "autonomous" ? { ...rec, state, graduatedAt: rec.firstSeen } : rec);
      log(`trust seed: ${type} -> ${state}`);
    }
  }

  // ---- voice (local STT/TTS) ----
  const voice = await VoiceService.create({
    enabled: config.voiceEnabled,
    whisperModel: config.whisperModel,
    ttsVoice: config.ttsVoice,
    dataDir: config.dataDir,
    log,
  });

  // ---- google senses (gmail + calendar) ----
  const google = GoogleAccounts.load(join(config.dataDir, "google-tokens.json"));
  if (!google.enabled()) {
    log(`google senses disabled: ${google.disabledReason()}`);
  } else {
    for (const exec of emailExecutors(google)) registry.register(exec);
    log(`google senses: ${google.accounts().map((a) => `${a.name} (${a.email})`).join(", ")}`);
  }

  // ---- bunq sense (read-only bank transactions) ----
  const bunq = BunqSense.load({
    contextPath: config.bunqContextPath,
    helperPath: config.bunqHelperPath,
    env: config.bunqEnv,
    backfillDays: config.bunqBackfillDays,
    pythonBin: config.pythonBin,
  });
  if (bunq.enabled()) log(`bunq sense: enabled (${config.bunqEnv})`);
  else log(`bunq sense: disabled — ${bunq.degraded()[0]?.reason ?? "no context"}`);

  // Resolve a pack for a playbook (JobManager) or a role (direct @role chats).
  const categorize = makeCategorizer(store, categoryClassifier(config.triageModel));
  const resolvePackFor = makeResolvePackFor(
    { packs, pillarOf, roleOf },
    { store, vault, gate, toolServers: { money: (d) => buildMoneyServer({ store: d.store, categorize }) } },
  );

  const channels = new Map<string, ChannelAdapter>();

  const onJobComplete = async (outcome: JobOutcome): Promise<void> => {
    const { job } = outcome;
    const channel = channels.get(job.channel);
    const notice = outcome.ok
      ? `[JOB-COMPLETE] Job "${job.title}" (${job.id}) finished. Artifacts in vault under jobs/${outcome.jobDirName}/: ${outcome.artifactFiles.join(", ")}. Read the key artifacts with vault_read and report the outcome to the user.`
      : `[JOB-FAILED] Job "${job.title}" (${job.id}) failed: ${outcome.error}. Partial artifacts under jobs/${outcome.jobDirName}/. Tell the user what happened and suggest next steps.`;
    const report = await moderator.handle(job.channel, job.chat_id, notice);
    await channel?.send(job.chat_id, report);
    bus.emit({ type: "chat.out", channel: job.channel, chatId: job.chat_id, text: report.slice(0, 300) });
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
    onEvent: (e) => bus.emit(e),
    log,
    pillarOf,
    resolvePackFor: (playbook, origin) => resolvePackFor(playbook, origin, false),
  });

  const moderator = new Moderator({
    store,
    bus,
    jobs,
    vault,
    run: runSpecialist,
    projectsRoot: config.projectsRoot,
    model: config.moderatorModel,
    specialistModel: config.specialistModel,
    log,
    gate,
    actionTypes: registry.types(),
    google,
  });

  const directChats = new DirectChats({
    store,
    bus,
    projectsRoot: config.projectsRoot,
    model: config.specialistModel,
    log,
    resolvePackFor: (role, origin) => resolvePackFor(role, origin, true),
    primaryChat: config.primaryChat,
  });

  const finance = new FinanceAgent({
    store,
    bus,
    vault,
    company: config.financeCompany,
    members: config.financeMembers,
    model: config.specialistModel,
    sendFile: async (channel, chatId, filePath, caption) => {
      await channels.get(channel)?.sendFile(chatId, filePath, caption);
    },
    log,
  });

  const router = new MessageRouter({
    moderator,
    directChats,
    finance,
    chatBindings: config.chatBindings,
    bus,
    gate,
  });

  const onMessage = async (msg: import("./channels/types.js").InboundMessage): Promise<void> => {
    log(`<- ${msg.channel}:${msg.chatId} ${msg.text.slice(0, 80)}`);
    try {
      const reply = await router.handle(msg);
      if (reply !== null) await deliverReply({ voice, log }, channels.get(msg.channel), msg, reply);
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
    const boundTelegramChats = [...config.chatBindings.keys()]
      .filter((k) => k.startsWith("telegram:"))
      .map((k) => k.slice("telegram:".length));
    channels.set(
      "telegram",
      new TelegramChannel(config.telegramToken, allowed, boundTelegramChats, `${config.dataDir}/downloads`, voice),
    );
  }
  if (config.slackBotToken && config.slackAppToken) {
    channels.set("slack", new SlackChannel(config.slackBotToken, config.slackAppToken));
  }

  for (const [name, ch] of channels) {
    await ch.start(onMessage);
    log(`channel up: ${name}`);
  }

  // Approval delivery: pings the chat that originated a queued action.
  bus.on((e) => {
    if (e.event.type !== "action.proposed") return;
    const row = store.getAction(e.event.actionId);
    if (!row) return;
    const ch = channels.get(row.origin_channel);
    if (!ch) return; // e.g. web-originated — visible in the dashboard approval inbox
    void (async () => {
      if (ch.sendApprovalRequest) {
        await ch.sendApprovalRequest(row.origin_chat_id, { id: row.id, type: row.type, preview: row.preview });
      } else {
        await ch.send(
          row.origin_chat_id,
          `⚖ Approval needed [${row.type}] ${row.preview}\nReply: /approve ${row.id} or /reject ${row.id} <reason>`,
        );
      }
    })().catch((err) => log(`approval notify failed: ${(err as Error).message}`));
  });

  // Button verdicts from channels go straight to the gate.
  for (const ch of channels.values()) {
    ch.setVerdictHandler?.(async (v) => {
      try {
        const row = await gate.resolve(v.actionId, v.verdict, { by: v.by });
        return row.status === "executed" ? `✓ Executed — ${row.result}`
          : row.status === "failed" ? `⚠ Execution failed — ${row.result}`
          : `✗ Rejected`;
      } catch (err) {
        return `Gate: ${(err as Error).message}`;
      }
    });
  }

  // Expiry sweep — fail-closed cleanup for stale approvals.
  setInterval(() => {
    const n = gate.sweepExpired();
    if (n) log(`expired ${n} stale approval(s)`);
  }, 60_000);

  // ---- second brain: backfill the index on boot, then keep it fresh ----
  // NOTE: the write-time indexing subscription is registered earlier (right after
  // `bus` is constructed) so decisions resolved during the channel-startup window
  // are still live-indexed. reconcile() below is just a snapshot backfill; the
  // listener is idempotent via fingerprints, so any overlap is a harmless no-op.
  try {
    reconcile(store, vault);
  } catch (err) {
    log(`memory reconcile failed: ${(err as Error).message}`);
  }
  const reindexTimer = setInterval(() => {
    try { reindexVault(store, vault); } catch (err) { log(`memory reindex failed: ${(err as Error).message}`); }
  }, config.memoReindexSeconds * 1000);
  reindexTimer.unref?.();

  // ---- heartbeat: anchors, briefs, reminders, triage ----
  if (!config.primaryChat) {
    log("WARNING: AIOS_PRIMARY_CHAT not set — briefs are vault-only, notify pings disabled");
  }

  const sendVia = async (channel: string, chatId: string, text: string): Promise<void> => {
    await channels.get(channel)?.send(chatId, text);
  };

  const notify = async (e: import("./events.js").AiosEvent): Promise<void> => {
    if (e.type === "reminder.due") {
      await sendVia(e.channel, e.chatId, `⏰ Reminder: ${e.text}`);
      return;
    }
    if (e.type === "calendar.reminder") {
      if (!config.primaryChat) return;
      await sendVia(config.primaryChat.channel, config.primaryChat.chatId,
        `📅 ${e.summary} in ${e.minutesUntil} min${e.link ? ` — ${e.link}` : ""}`);
      return;
    }
    if (e.type === "mail.received") {
      if (!config.primaryChat) return;
      await sendVia(config.primaryChat.channel, config.primaryChat.chatId,
        `📧 ${e.from}: ${e.subject} (${e.account})\n${e.snippet.slice(0, 150)}`);
      return;
    }
    if (!config.primaryChat) return;
    const summary =
      e.type === "job.status"
        ? `🔔 Job ${e.jobId} ${e.status}${e.error ? `: ${e.error.slice(0, 200)}` : ""}`
        : `🔔 ${e.type}: ${JSON.stringify(e).slice(0, 200)}`;
    await sendVia(config.primaryChat.channel, config.primaryChat.chatId, summary);
  };

  const triage = new Triage({
    store,
    bus,
    classify: modelClassifier(config.triageModel),
    notify,
    log,
  });
  triage.start();

  const narrate = (anchor: "morning" | "evening", dataJson: string): Promise<string> => {
    const p = config.primaryChat!;
    return moderator.handle(
      p.channel,
      p.chatId,
      `[${anchor.toUpperCase()}-BRIEF] ${dataJson} — narrate this as my chief of staff: short, lead with what needs me, plain text.`,
    );
  };

  const clock = new Clock({
    store,
    anchors: [
      { name: "morning", hhmm: config.anchorMorning },
      { name: "evening", hhmm: config.anchorEvening },
    ],
    onAnchor: async (name) => {
      await runBrief(
        { store, bus, vault, narrate, send: sendVia, primary: config.primaryChat, degraded: () => [...google.degraded(), ...bunq.degraded()], log },
        name,
      );
      if (name === "evening") {
        reindexVault(store, vault); // sync, cheap — catch direct vault edits before distilling
        // fire-and-forget: distill's up-to-7 LLM calls must not block the clock tick / reminders.
        void distill({ store, vault, gate, curate: curateLLM(config.curatorModel, log), log })
          .catch((err) => log(`distill failed: ${(err as Error).message}`));
      }
    },
    onReminderDue: (r) =>
      bus.emit({ type: "reminder.due", id: r.id, text: r.text, channel: r.origin_channel, chatId: r.origin_chat_id }),
    log,
  });
  clock.start();

  // Watcher loops: per-account isolation with capped backoff (1m → 5m → 15m).
  const stops: Array<() => void> = [];
  stops.push(() => clearInterval(reindexTimer));

  const BACKOFFS = [60_000, 300_000, 900_000];
  const startWatcher = (
    name: string,
    intervalMs: number,
    pollFn: () => Promise<void>,
    onFail: (reason: string) => void = () => {},
    onOk: () => void = () => {},
  ) => {
    let failures = 0;
    let timer: NodeJS.Timeout;
    const tick = async () => {
      try {
        await pollFn();
        failures = 0;
        onOk();
      } catch (err) {
        failures++;
        onFail((err as Error).message.slice(0, 120));
        log(`${name} poll failed (${failures}): ${(err as Error).message}`);
      }
      const delay = failures > 0 ? BACKOFFS[Math.min(failures - 1, BACKOFFS.length - 1)] : intervalMs;
      timer = setTimeout(() => void tick(), delay);
      timer.unref?.();
    };
    void tick();
    return () => clearTimeout(timer);
  };

  if (google.enabled()) {
    for (const acc of google.accounts()) {
      const gmailWatcher = new GmailWatcher({
        account: acc.name, gmail: acc.gmail, store, bus, skipCategories: config.gmailSkipCategories, log,
      });
      const calWatcher = new CalendarWatcher({
        account: acc.name, calendar: acc.calendar, store, bus, pingMinutes: config.meetingPingMinutes, log,
      });
      stops.push(startWatcher(`gmail:${acc.name}`, config.gmailPollSeconds * 1000, () => gmailWatcher.poll(),
        (r) => google.markDegraded(acc.name, r), () => google.clearDegraded(acc.name)));
      stops.push(startWatcher(`gcal:${acc.name}`, config.calendarPollSeconds * 1000, () => calWatcher.poll(),
        (r) => google.markDegraded(acc.name, r), () => google.clearDegraded(acc.name)));
    }
  }

  if (bunq.enabled()) {
    const bunqSync = new BunqSync({ store, fetch: bunq.fetch, log });
    stops.push(startWatcher("bunq", config.bunqPollSeconds * 1000, () => bunqSync.poll().then(() => {}),
      (r) => bunq.markDegraded(r), () => bunq.clearDegraded()));
  }

  startWebServer(
    { store, bus, jobs, vault, config, router, finance, gate, voice, reloadPacks, envPath: config.envPath, uiDist: config.uiDist, log },
    config.uiPort,
  );

  const resumed = jobs.resumeUnfinished();
  if (resumed) log(`resumed ${resumed} unfinished job(s)`);

  const shutdown = async () => {
    log("shutting down");
    stops.forEach((s) => s());
    for (const ch of channels.values()) await ch.stop().catch(() => {});
    clock.stop();
    triage.stop();
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
