// src/boot.ts — normal-mode boot, moved verbatim out of index.ts so the onboarding
// wizard can bring the daemon up in-process once it has provisioned an org.
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { loadConfig, assertAuth, ensureUiToken } from "./config.js";
import { Store } from "./store/db.js";
import { VaultWriter } from "./vault/writer.js";
import { makeDailyLogger } from "./vault/daily-log.js";
import { makeResolveAgent, type ResolveAgentDeps } from "./agents/resolve.js";
import type { Embedder } from "./memory/embeddings.js";
import { loadRegistry, disabledDepartments, dropDepartment, type LoadedRegistry } from "./agents/registry/loader.js";
import { buildExtras } from "./agents/registry/extras.js";
import { allocateWorkspace, deliverBranch } from "./code/workspace.js";
import { resolveReal } from "./code/paths.js";
import { randomUUID } from "node:crypto";
import { localParts } from "./heartbeat/clock.js";
import { GoalEngine, MAIL_PREFIX, type GoalOutcome } from "./engine/goals.js";
import { artifactFooter } from "./engine/artifact-footer.js";
import { SpendGuard, attachBudgetLedger } from "./engine/budget.js";
import { makePlanner } from "./engine/plan.js";
import type { GoalRow } from "./store/db.js";
import type { Playbook } from "./engine/playbook.js";
import { makeRunSpecialist } from "./agents/runner.js";
import { Mailbox, isUserReportEvent } from "./mail/mailbox.js";
import { Moderator } from "./moderator/session.js";
import { makeHandOff } from "./moderator/handoff.js";
import { DirectChats } from "./agents/direct.js";
import { EventBus } from "./events.js";
import { MessageRouter } from "./router.js";
import { startWebServer, exitOnListenError } from "./web/server.js";
import { CliChannel } from "./channels/cli.js";
import { TelegramChannel } from "./channels/telegram.js";
import { SlackChannel } from "./channels/slack.js";
import type { ChannelAdapter } from "./channels/types.js";
import { dispatchAttachments } from "./channels/dispatch.js";
import { startChannels } from "./channels/boot.js";
import { createAttachmentRegistry } from "./web/attachment-registry.js";
import { AIOS_TMP_PREFIX } from "./agents/attachment-server.js";
import { ExecutorRegistry } from "./kernel/actions.js";
import { vaultWriteExecutor, echoExecutor, trustPromoteExecutor, permissionGrantExecutor, permissionRevokeExecutor, ledgerWriteExecutor } from "./kernel/executors.js";
import { ActionGate } from "./kernel/gate.js";
import { makeGrantProposer } from "./kernel/propose-grant.js";
import { Policy } from "./kernel/policy.js";
import { deptLabel } from "./kernel/labels.js";
import { newRecord } from "./kernel/trust.js";
import { activeAnchors, Clock } from "./heartbeat/clock.js";
import { Triage, modelClassifier } from "./heartbeat/triage.js";
import { makeRoutineFire, makeReminderFire } from "./heartbeat/routines.js";
import { runBrief } from "./heartbeat/briefs.js";
import { VoiceService } from "./voice/index.js";
import { deliverReply } from "./voice/mirror.js";
import { GoogleAccounts } from "./senses/google/auth.js";
import { GmailWatcher } from "./senses/google/gmail.js";
import { CalendarWatcher } from "./senses/google/calendar.js";
import { emailExecutors } from "./senses/google/executors.js";
import { BunqSense } from "./senses/bunq/index.js";
import { BunqSync } from "./senses/bunq/sync.js";
import { reconcile, reindexVault, indexEvent, indexDecision, indexMailThread } from "./memory/indexer.js";
import { captureTurn, extractLLM } from "./memory/capture.js";
import { seedEntities, extractNewEntities, extractEntitiesLLM } from "./memory/entities.js";
import { LocalEmbedder, embedMissing } from "./memory/embeddings.js";
import { distill, factDiffLLM, groundLLM } from "./memory/distiller.js";
import { runDreamCycle, dreamRankLLM } from "./heartbeat/dream.js";
import { runSpeculate, speculatePlanLLM } from "./heartbeat/speculate.js";
import { runSpeculateEmail, scanInboxFor, readMessageFor, triageLLM, composeLLM } from "./heartbeat/speculate-email.js";
import { runStandups } from "./heartbeat/standup.js";
import { runWikiMaintenance } from "./heartbeat/wiki.js";
import { makeCategorizer, categoryClassifier } from "./money/categorize.js";
import { buildMoneyServer } from "./money/server.js";
import { buildResearchServer } from "./research/server.js";
import { computeMoneySignals } from "./money/signals.js";
import { buildLifeopsServer } from "./lifeops/server.js";
import { computeLifeopsSignals } from "./lifeops/ops.js";
import { buildLedgerServer } from "./finance/server.js";

export const log = (line: string) => console.log(`[aios ${new Date().toISOString()}] ${line}`);

export interface BootedWorld {
  store: Store;
  bus: EventBus;
  goals: GoalEngine;
  moderator: Moderator;
  registry: LoadedRegistry;
  vault: VaultWriter;
  startWeb: () => void;
  shutdown: () => Promise<void>;
}

export async function bootNormal(opts: { startWeb?: boolean } = {}): Promise<BootedWorld> {
  // Config is loaded here, not passed in: the workspace step writes AIOS_VAULT_PATH to
  // .env after the process-start load, so a captured config would send every artifact
  // to the wrong directory.
  const config = loadConfig();

  assertAuth();
  ensureUiToken(resolve(".env"), log);

  // Known trap: data/aios.db is a stale zero-byte file from an old path; queries
  // against it silently return nothing. Delete only if empty and not the live DB.
  try {
    const staleDb = resolve("data/aios.db");
    if (staleDb !== resolve(config.dbPath) && existsSync(staleDb) && statSync(staleDb).size === 0) {
      unlinkSync(staleDb);
      log("cleanup: removed stale empty data/aios.db");
    }
  } catch { /* best-effort */ }

  const store = new Store(config.dbPath);
  const bus = new EventBus(store);
  const registry = loadRegistry(
    config.agentsDir,
    config.playbooksDir,
    buildExtras({
      vaultPath: config.vaultPath,
      vaultSubdir: config.vaultSubdir,
      financeCompany: config.financeCompany,
      financeMembers: config.financeMembers,
    }),
    log,
  );
  // Agent mailbox: onQueued forward-refs `goals` (initialized below) — the closure only fires
  // when mail is sent, long after boot, so the reference is resolved by then.
  // Information-flow checkpoint (spec §4). Reports violations onto the bus; audit blocks nothing.
  // Constructed here (ahead of its other uses) so the mailbox's inject seam can gate on it.
  const infoPolicy = new Policy({
    mode: config.policyMode,
    report: (v) => bus.emit({ type: "policy.violation", ...v }),
  });
  log(`policy: ${config.policyMode} mode`);

  const mailbox = new Mailbox({
    store, registry,
    maxDepth: config.mailMaxDepth, disabled: config.mailDisabled,
    policy: infoPolicy,
    primaryChat: config.primaryChat,
    onEvent: (e) => bus.emit(e),
    onQueued: () => goals.pump(),
    onAskParked: (g, n, m) => goals.parkFromAsk(g, n, m),
  });
  const vault = new VaultWriter(config.vaultPath, config.vaultSubdir);
  vault.init();

  // projectsRoot is the cwd every specialist and hand-off is spawned in, and it defaults to
  // ~/projects — a developer convention a new user's machine has no reason to contain. Spawning
  // into a directory that is not there fails deep inside the SDK, which reports it as the Claude
  // binary being unable to start ("likely a libc/architecture mismatch"), so the daemon looks
  // broken and the real cause is never mentioned. Observed on a clean install 2026-08-11.
  try {
    mkdirSync(config.projectsRoot, { recursive: true });
  } catch (err) {
    log(`projects root ${config.projectsRoot} could not be created: ${(err as Error).message}`);
  }

  // ---- second brain: write-time indexing — registered BEFORE channels start so a
  // decision resolved during the startup window (e.g. /approve, an autonomous
  // gate.propose) is live-indexed, not just recovered on the next restart's reconcile.
  bus.on((e) => {
    try {
      // infoPolicy is a forward-ref (constructed below, after the gate) — this closure only
      // fires at runtime, long after boot, so the binding is resolved by then.
      if (e.event.type === "calendar.changed") indexEvent(store, e, infoPolicy);
      else if (e.event.type === "action.executed" || e.event.type === "action.resolved") {
        indexDecision(store, e.event.actionId, infoPolicy);
      } else if (e.event.type === "mail.sent" || e.event.type === "mail.asked_user") {
        const m = store.getMail(e.event.id);
        if (m) indexMailThread(store, registry, m.thread_id ?? m.id, infoPolicy);
      }
      // Write-time embedding seam (memory-v2 §3/§7): debounced sweep picks up any doc the
      // branches above just indexed. scheduleEmbed is a forward-ref like infoPolicy — this
      // closure only fires at runtime, long after the binding below is initialized.
      scheduleEmbed();
    } catch (err) {
      log(`memory index (write-time) failed: ${(err as Error).message}`);
    }
  });
  for (const d of disabledDepartments(process.env, registry.departments.keys())) dropDepartment(registry, d);
  log(`playbooks: ${[...registry.playbooks.keys()].join(", ")}`);
  log(`departments: ${[...registry.departments.keys()].sort().join(", ") || "(none)"}`);

  // Reload the WHOLE registry in place (after a UI file edit). Mutates the same Map
  // instances JobManager + resolveDeptFor hold by reference, so they stay in sync.
  const reloadRegistry = () => {
    const fresh = loadRegistry(
      config.agentsDir,
      config.playbooksDir,
      buildExtras({
        vaultPath: config.vaultPath,
        vaultSubdir: config.vaultSubdir,
        financeCompany: config.financeCompany,
        financeMembers: config.financeMembers,
      }),
      log,
    );
    for (const d of disabledDepartments(process.env, fresh.departments.keys())) dropDepartment(fresh, d);
    registry.agents.clear(); for (const [k, v] of fresh.agents) registry.agents.set(k, v);
    registry.departments.clear(); for (const [k, v] of fresh.departments) registry.departments.set(k, v);
    registry.agentOf.clear(); for (const [k, v] of fresh.agentOf) registry.agentOf.set(k, v);
    registry.ownerOfPlaybook.clear(); for (const [k, v] of fresh.ownerOfPlaybook) registry.ownerOfPlaybook.set(k, v);
    registry.playbooks.clear(); for (const [k, v] of fresh.playbooks) registry.playbooks.set(k, v);
    log(`registry reloaded: ${[...registry.departments.keys()].sort().join(", ") || "(none)"}`);
  };

  // ---- action gate (the only door out) ----
  const executors = new ExecutorRegistry();
  executors.register(vaultWriteExecutor(vault));
  executors.register(echoExecutor());
  executors.register(trustPromoteExecutor(store, bus));
  executors.register(permissionGrantExecutor(store, bus));
  executors.register(permissionRevokeExecutor(store, bus));
  executors.register(ledgerWriteExecutor(store, vault, config.financeCompany));

  const gate = new ActionGate({
    store, registry: executors, policy: config.trustPolicy, bus, expiryMs: config.actionExpiryMs, log,
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

  // Media understanding for attachments (spec 2026-07-18-media-understanding):
  // same whisper path as voice notes; bare "ffmpeg" resolves via PATH like VoiceService.
  const media = {
    transcribe: (p: string) => voice.transcribe(p),
    available: () => voice.available(),
    ffmpegBin: "ffmpeg",
  };

  // ---- google senses (gmail + calendar) ----
  const google = GoogleAccounts.load(join(config.dataDir, "google-tokens.json"));
  if (!google.enabled()) {
    log(`google senses disabled: ${google.disabledReason()}`);
  } else {
    for (const exec of emailExecutors(google)) executors.register(exec);
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
  else log(`bunq sense: disabled — ${bunq.disabledReason()}`);

  const categorize = makeCategorizer(store, categoryClassifier(config.triageModel));
  // memory-v2 retrieval knobs, shared by the moderator + every pack agent's recall tool.
  // `embedder` is attached at the memory boot block below (single mutable seam) — until
  // then (and whenever the model latches off) recall is lexical-only.
  const memoryDeps: { embedder?: Embedder; halfLifeDays: number; stalePenalty: number } = {
    halfLifeDays: config.memoryHalfLifeDays,
    stalePenalty: config.memoryStalePenalty,
  };
  // Local embedder (memory-v2 §3): lazy model load, fail-latch to lexical-only. The debounced
  // single-flight sweep is the write-time seam — indexDoc stays sync, vectors follow within ~5s.
  const embedder = config.embeddings
    ? new LocalEmbedder({ cacheDir: join(config.dataDir, "models"), log })
    : undefined;
  memoryDeps.embedder = embedder;
  let embedTimer: NodeJS.Timeout | undefined;
  let embedInFlight = false; // true single-flight: a running sweep must not overlap another
  const scheduleEmbed = (delayMs = 5_000) => {
    if (!embedder?.available()) return;
    clearTimeout(embedTimer);
    embedTimer = setTimeout(() => {
      if (embedInFlight) { scheduleEmbed(1_000); return; } // a sweep is running — re-arm, don't overlap
      embedInFlight = true;
      void embedMissing(store, embedder, 64)
        .then((n) => { if (n === 64) scheduleEmbed(1_000); }) // keep draining a big backlog
        .catch((err) => log(`embed sweep failed: ${(err as Error).message}`))
        .finally(() => { embedInFlight = false; });
    }, delayMs);
    embedTimer.unref?.();
  };
  const resolveDeps: ResolveAgentDeps = { registry, store, vault, gate, config, categorize, policy: infoPolicy, embedder, voice };
  // Post-turn conversational capture (memory-v2 §5): one cheap fail-silent one-shot per
  // coordinator/direct turn; candidates ride the teachings pipeline as agent-inferred.
  const captureFn = config.captureEnabled
    ? (u: string, r: string) => {
        void captureTurn({ store, extract: extractLLM(config.captureModel, log), log }, u, r)
          .catch((err) => log(`capture failed: ${(err as Error).message}`));
      }
    : undefined;
  // The ONE resolution path (org-model spec §7) — runner/engine/handoff resolve through this;
  // resolveDeptFor coexists for the direct seam until its cutover, then dies with the Pack struct.
  const resolveAgent = makeResolveAgent(resolveDeps);
  const runSpecialist = makeRunSpecialist({ store, bus, registry, mailbox, resolveAgent });

  const channels = new Map<string, ChannelAdapter>();

  const spendGuard = new SpendGuard({ store, capUsd: config.dailyBudgetUsd });
  attachBudgetLedger(bus, store);

  // One-time cost_daily backfill from event history (idempotent via kv flag).
  if (!store.kvGet("cost:backfilled")) {
    for (const e of bus.history(0, 50_000)) {
      if (e.event.type === "agent.end" && e.event.costUsd) {
        store.costAdd(e.event.agent, e.ts.slice(0, 10), Math.round(e.event.costUsd * 100));
      }
    }
    store.kvSet("cost:backfilled", "1");
  }

  // Serves goal-completion media to the web cockpit by capability token; same safe roots as the
  // moderator attachment server (projects, downloads, /tmp/aios- render outputs).
  const attachmentRegistry = createAttachmentRegistry([
    resolve(config.projectsRoot),
    resolve(config.dataDir, "downloads"),
    AIOS_TMP_PREFIX,
  ]);

  const onGoalComplete = async (outcome: GoalOutcome): Promise<void> => {
    const { goal } = outcome;
    const channel = channels.get(goal.origin_channel);
    // Self-work happens in a clone, so its commits are invisible until fetched home. Refs only —
    // no merge, working tree untouched. Failed goals deliver too: partial commits are reviewable.
    // goal.project_dir is the taskDir by now (the workspace.prepared fold rewrites it).
    let delivered: string | null = null;
    try {
      if (goal.project_dir) delivered = deliverBranch({ taskDir: goal.project_dir, selfRoot: resolveReal(process.cwd()) });
    } catch (err) {
      log(`[${goal.slug}] branch delivery failed: ${(err as Error).message}`);
    }
    const branchLine = delivered
      ? ` The agent's commits are on branch ${delivered} in the AIOS repo (fetched, not merged) — tell the user to review it.`
      : "";
    // FailGoal skips every pending node. That already lands in the journal but never reached a
    // human — on cab8495e the review node silently never ran.
    const skipped = outcome.ok ? [] : store.listNodes(goal.id).filter((n) => n.status === "skipped");
    const skippedLine = skipped.length
      ? ` Skipped by the failure: ${skipped.map((n) => `${n.node_key} (${n.agent})`).join(", ")} — these quality gates did NOT run, say so.`
      : "";
    const notice = outcome.ok
      ? `[GOAL-COMPLETE] Goal "${goal.title}" (${goal.id}) finished. Artifacts in vault under goals/${outcome.goalDirName}/: ${outcome.artifactFiles.join(", ")}. Read the key artifacts with vault_read and report the outcome to the user.${branchLine}`
      : `[GOAL-FAILED] Goal "${goal.title}" (${goal.id}) failed: ${outcome.error}. Partial artifacts under goals/${outcome.goalDirName}/. Tell the user what happened and suggest next steps.${branchLine}${skippedLine}`;
    const { text: report0, attachments } = await moderator.handle(goal.origin_channel, goal.origin_chat_id, notice);
    // Deterministic whereabouts: the moderator is ASKED to mention artifact locations, but a
    // generated sentence is hope — the footer is composed from the outcome, so the user always
    // learns exactly where the files landed and how to open them.
    const report = report0 + artifactFooter(outcome, { vaultRoot: vault.root, uiPort: config.uiPort });
    await channel?.send(goal.origin_chat_id, report);
    // A real push channel (telegram) gets media via sendVoice/sendFile; web has no ChannelAdapter,
    // so its media rides the chat.out event as capability-token descriptors (rendered by ui2).
    if (channel) await dispatchAttachments(channel, goal.origin_chat_id, attachments, log);
    const descriptors = channel
      ? []
      : attachments.flatMap((a) => {
          try { return [attachmentRegistry.register(a.path, { caption: a.caption, kind: a.kind })]; }
          catch (err) { log(`goal media register failed (${a.path}): ${(err as Error).message}`); return []; }
        });
    bus.emit({
      type: "chat.out",
      channel: goal.origin_channel,
      chatId: goal.origin_chat_id,
      text: report.slice(0, 1500), // web-origin goals are DELIVERED via this event; 300 clipped real reports
      pushed: true, // server-initiated — ui2 folds this into the web chat (router echoes are not pushed)
      ...(descriptors.length ? { attachments: descriptors } : {}),
    });
  };

  const prepareGoalSandbox = async (goal: GoalRow, _opts: { playbook?: Playbook }) => {
    // Facade code goals keep today's engineering-only allocation; planned engineering
    // goals get greenfield/worktree per project_dir presence (analyze read-only).
    // Single-node mail-goals never get a sandbox; graph mail-goals are gated upstream by the
    // engine's mailWorkspaceEligible check (user-sent + engineering only, spec 2026-07-07).
    if (goal.plan_summary.startsWith(MAIL_PREFIX)) return undefined;
    if (goal.department === "clients") {
      // Clients goals: read-only analyze workspace when the goal names a project_dir.
      // Client agents (iris) hold code-sandbox, and a sandbox agent without a workspace
      // is dead — the advisory guard strips all fs/exec tools (resolve.ts sandbox branch).
      // Analyze matches their read-only charter: taskDir IS the source repo, codeGuard
      // blocks writes. No project_dir → no workspace (vault/recall work needs none).
      if (!goal.project_dir) return undefined;
      const { taskDir } = allocateWorkspace(
        { mode: "analyze", source: goal.project_dir, slug: goal.slug },
        {
          workspaceRoot: config.workspaceRoot, readRoots: config.codeReadRoots,
          now: localParts(new Date()).date, id: randomUUID().slice(0, 8),
          selfRoot: resolveReal(process.cwd()),
        },
      );
      return { taskDir, mode: "analyze" as const };
    }
    if (goal.department !== "engineering") return undefined;
    const pbName = goal.plan_summary.startsWith("playbook:") ? goal.plan_summary.slice("playbook:".length) : undefined;
    if (pbName === "code-inplace") return undefined; // inplace edits the real checkout — no sandbox
    const mode: "build" | "analyze" = pbName === "code-analyze" ? "analyze" : "build";
    const wsMode = mode === "analyze" ? "analyze" : (goal.project_dir ? "worktree" : "greenfield");
    const { taskDir } = allocateWorkspace(
      { mode: wsMode, source: goal.project_dir ?? undefined, slug: goal.slug },
      {
        workspaceRoot: config.workspaceRoot, readRoots: config.codeReadRoots,
        now: localParts(new Date()).date, id: randomUUID().slice(0, 8),
        selfRoot: resolveReal(process.cwd()), // AIOS self-work ⇒ clone, not worktree
      },
    );
    return { taskDir, mode };
  };

  const goals = new GoalEngine({
    store, vault, run: runSpecialist, registry,
    playbooks: registry.playbooks,
    proposeGrant: makeGrantProposer(store, gate),
    wallTimeMs: config.jobWallTimeMs,
    nodeTimeoutMs: config.nodeTimeoutMs,
    maxConcurrentNodes: config.maxConcurrentNodes,
    mailMaxDepth: config.mailMaxDepth,
    mailDisabled: config.mailDisabled,
    spendGuard,
    onComplete: onGoalComplete,
    onEvent: (e) => bus.emit(e),
    log,
    prepareSandbox: prepareGoalSandbox,
    planner: makePlanner({
      registry, store, run: runSpecialist,
      primaryChat: config.primaryChat, projectsRoot: config.projectsRoot,
      selfRoot: resolveReal(process.cwd()), // AIOS may be a workspace source (clone, not worktree)
      postPreview: async (origin, text) => {
        await channels.get(origin.channel)?.send(origin.chatId, text);
        bus.emit({ type: "chat.out", channel: origin.channel, chatId: origin.chatId, text: text.slice(0, 300), pushed: true });
      },
      onEvent: (e) => bus.emit(e),
      log,
    }),
    primaryChat: config.primaryChat,
    projectsRoot: config.projectsRoot,
    workspaceRoot: config.workspaceRoot,
    pingBudgetPaused: (text) => {
      if (config.primaryChat) void channels.get(config.primaryChat.channel)?.send(config.primaryChat.chatId, text);
    },
  });

  const handOff = makeHandOff({
    registry,
    runSpecialist,
    bus,
    primaryChat: config.primaryChat,
    projectsRoot: config.projectsRoot,
  });

  const moderator = new Moderator({
    store,
    bus,
    goals,
    vault,
    handOff,
    registry,
    projectsRoot: config.projectsRoot,
    resolveAgent,
    log,
    gate,
    actionTypes: executors.types(),
    google,
    mailbox,
    // memory-v2 retrieval knobs; the embedder is attached later at the memory boot block
    // (same object, mutated once constructed) — recall degrades to lexical until then.
    memory: memoryDeps,
    capture: captureFn,
    media,
  });

  const directChats = new DirectChats({
    store,
    bus,
    projectsRoot: config.projectsRoot,
    registry,
    resolveAgent,
    log,
    primaryChat: config.primaryChat,
    mailbox,
    capture: captureFn,
  });

  const router = new MessageRouter({
    moderator,
    directChats,
    chatBindings: config.chatBindings,
    bus,
    gate,
    goals,
  });

  const onMessage = async (msg: import("./channels/types.js").InboundMessage): Promise<void> => {
    log(`<- ${msg.channel}:${msg.chatId} ${msg.text.slice(0, 80)}`);
    try {
      // Owner answering a pending agent question — primary chat only, BEFORE routing.
      if (config.primaryChat && msg.channel === config.primaryChat.channel &&
          msg.chatId === config.primaryChat.chatId) {
        const answered = goals.answerFromChat(msg.text);
        if (answered) {
          await channels.get(msg.channel)?.send(msg.chatId, answered);
          return;
        }
      }
      const result = await router.handle(msg);
      if (result !== null) {
        await deliverReply({ voice, log }, channels.get(msg.channel), msg, result.text);
        await dispatchAttachments(channels.get(msg.channel), msg.chatId, result.attachments, log);
      }
    } catch (err) {
      log(`handler error: ${(err as Error).stack}`);
      await channels.get(msg.channel)?.send(msg.chatId, `Error: ${(err as Error).message}`);
    }
  };

  // Routines inject their prompt as a synthetic inbound message — full kernel path (spec 2026-07-15).
  const routineFire = makeRoutineFire({ onMessage, primaryChat: config.primaryChat, log });
  bus.on((e) => {
    if (e.event.type === "routine.due") routineFire(e.event);
  });

  // Reminders inject a framed prompt too — the coordinator executes a task reminder
  // or relays a plain nudge (spec 2026-07-25).
  const reminderFire = makeReminderFire({ onMessage, primaryChat: config.primaryChat, log });
  bus.on((e) => {
    if (e.event.type === "reminder.due") reminderFire(e.event);
  });

  // Goal lifecycle → Obsidian daily note (the JobManager→GoalEngine migration dropped this).
  const dailyLogger = makeDailyLogger({ vault, store, log });
  bus.on((e) => dailyLogger(e.event));

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

  const channelFailures = await startChannels(channels, onMessage, log);

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

  // Event retention — goal_journal (future) and budget_ledger are never touched.
  const pruneOld = () => {
    const cutoff = new Date(Date.now() - config.eventRetentionDays * 86_400_000).toISOString();
    try {
      const n = store.pruneEvents(cutoff);
      if (n) log(`retention: pruned ${n} old event(s)`);
    } catch (err) {
      log(`retention sweep failed: ${(err as Error).message}`);
    }
  };
  pruneOld();
  const retentionTimer = setInterval(pruneOld, 24 * 3_600_000);
  retentionTimer.unref?.();

  // Journaled engine heartbeat: sweeps attempt deadlines, budget-abort, stalled decides.
  const engineTick = setInterval(() => goals.tick(), 30_000);
  engineTick.unref?.();

  // ---- second brain: backfill the index on boot, then keep it fresh ----
  // NOTE: the write-time indexing subscription is registered earlier (right after
  // `bus` is constructed) so decisions resolved during the channel-startup window
  // are still live-indexed. reconcile() below is just a snapshot backfill; the
  // listener is idempotent via fingerprints, so any overlap is a harmless no-op.
  try {
    reconcile(store, vault, registry, infoPolicy);
  } catch (err) {
    log(`memory reconcile failed: ${(err as Error).message}`);
  }
  // memory-v2 boot: deterministic entity seeding (idempotent) + lazy vector backfill.
  try { seedEntities(store, registry); } catch (err) { log(`entity seeding failed: ${(err as Error).message}`); }
  scheduleEmbed(1_000);
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

  // An agent asked the human a question — ping the owner's primary chat (transport-only,
  // never vaulted/indexed; safe even for private-dept askers — it's the owner's own channel).
  bus.on((e) => {
    if (e.event.type !== "mail.asked_user" || !config.primaryChat) return;
    void sendVia(config.primaryChat.channel, config.primaryChat.chatId,
      `🙋 ${e.event.from} is asking:\n${e.event.question}\n\nAnswer in Mission Control, or reply here: @${e.event.from} <your answer>`,
    ).catch((err) => log(`ask ping failed: ${(err as Error).message}`));
  });

  // A report for the owner landed (reply to their cold mail) — courtesy copy to primary chat.
  // Transport-only: no read-marking, no vaulting; the Mail tab is the source of truth.
  bus.on((e) => {
    if (!isUserReportEvent(e.event) || !config.primaryChat) return;
    if (e.event.type !== "mail.sent") return; // narrow for TypeScript
    const first = (store.getMail(e.event.id)?.body.split("\n")[0] ?? "").slice(0, 200);
    void sendVia(config.primaryChat.channel, config.primaryChat.chatId,
      `📨 ${e.event.from} → you: ${first}\n\nFull report in Mission Control → Mail.`,
    ).catch((err) => log(`report ping failed: ${(err as Error).message}`));
  });

  const notify = async (e: import("./events.js").AiosEvent): Promise<void> => {
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
      e.type === "goal.status"
        ? `🔔 Goal ${e.goalId} ${e.status}${e.error ? `: ${e.error.slice(0, 200)}` : ""}`
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
    return moderator
      .handle(
        p.channel,
        p.chatId,
        `[${anchor.toUpperCase()}-BRIEF] ${dataJson} — narrate this as my chief of staff: short, lead with what needs me, plain text.`,
      )
      .then((r) => r.text); // briefs are text-by-design; attachments dropped here
  };

  const clock = new Clock({
    store,
    // Disabled features are filtered OUT rather than returning early in onAnchor: a due
    // anchor is stamped before its handler runs, so a no-op handler still burns the day.
    anchors: activeAnchors([
      { name: "dream", hhmm: config.anchorDream },
      { name: "speculate", hhmm: config.anchorSpeculate },
      { name: "wiki", hhmm: config.anchorWiki },
      { name: "standup", hhmm: config.anchorStandup },
      { name: "morning", hhmm: config.anchorMorning },
      { name: "evening", hhmm: config.anchorEvening },
    ], {
      wiki: config.wikiDisabled,
      standup: config.standupDisabled || config.mailDisabled,
    }),
    catchupAfter: config.catchupAfter,
    onAnchor: async (name) => {
      if (name === "dream") {
        if (!spendGuard.allow()) { log("budget: skipping dream"); return; }
        // fire-and-forget: the ranker's LLM call must not block the clock tick / reminders.
        void runDreamCycle({ store, rank: dreamRankLLM(config.dreamModel), topN: config.dreamTopN, log })
          .catch((err) => log(`dream cycle failed: ${(err as Error).message}`));
        return;
      }
      if (name === "speculate") {
        if (!spendGuard.allow()) { log("budget: skipping speculate"); return; }
        // fire-and-forget: the planner's LLM call + enqueue must not block the clock tick / reminders.
        void runSpeculate({
          store,
          jobs: { createJob: (p) => goals.createFromPlaybook(p) },
          plan: speculatePlanLLM(config.speculateModel, config.speculateMaxJobs),
          maxJobs: config.speculateMaxJobs,
          log,
        }).catch((err) => log(`speculate failed: ${(err as Error).message}`));
        if (!config.speculateEmailDisabled && google.enabled()) {
          const acct = config.speculateEmailAccount ?? google.accounts()[0]?.name;
          if (acct) {
            // fire-and-forget: gmail reads + LLM calls must not block the clock tick / reminders.
            void runSpeculateEmail({
              store,
              gate,
              account: acct,
              maxJobs: config.speculateEmailMaxJobs,
              // System origin (not primaryChat): overnight drafts must NOT ping at 03:00.
              // The action.proposed handler only pings real channels, so a "system" origin
              // stays silent; the drafts surface at 07:30 via the brief's private detail send
              // (and the Mission Control approval inbox). /approve <id> resolves origin-independently.
              origin: { channel: "system", chatId: "speculate-email" },
              scan: scanInboxFor(google, acct, config.gmailSkipCategories),
              read: readMessageFor(google, acct),
              triage: triageLLM(config.speculateEmailModel, config.speculateEmailMaxJobs),
              compose: composeLLM(config.speculateEmailModel),
              log,
            }).catch((err) => log(`speculate-email failed: ${(err as Error).message}`));
          }
        }
        return;
      }
      if (name === "wiki") {
        if (config.wikiDisabled) return;
        // fire-and-forget: the maintainer's LLM call must not block the clock tick / reminders.
        // Budget and agent selection are decided inside; a failed pass defers its files.
        void runWikiMaintenance({
          store, vault, registry, run: runSpecialist, spendGuard,
          ...(config.wikiAgent ? { agent: config.wikiAgent } : {}),
          onEvent: (e) => bus.emit(e), log,
        }).catch((err) => log(`wiki maintenance failed: ${(err as Error).message}`));
        return;
      }
      if (name === "standup") {
        if (config.standupDisabled || config.mailDisabled) return;
        // fire-and-forget: lead one-shots must not block the clock tick / reminders.
        void runStandups({ store, registry, run: runSpecialist, spendGuard, onEvent: (e) => bus.emit(e), policy: infoPolicy, log })
          .catch((err) => log(`standups failed: ${(err as Error).message}`));
        return;
      }
      await runBrief(
        {
          store, bus, vault, narrate, send: sendVia, primary: config.primaryChat,
          degraded: () => [...google.degraded(), ...bunq.degraded(),
            ...channelFailures.map((f) => ({ name: `channel:${f.name}`, reason: f.reason }))],
          policy: infoPolicy,
          labelOf: (a) => deptLabel(registry.agents.get(registry.agentOf.get(a) ?? a)?.department ?? ""),
          log,
        },
        name,
      );
      if (name === "evening") {
        reindexVault(store, vault); // sync, cheap — catch direct vault edits before distilling
        // fire-and-forget: distill's LLM calls must not block the clock tick / reminders.
        void distill({
          store, vault, gate, bus,
          factDiff: factDiffLLM(config.curatorModel, log),
          ground: groundLLM(config.curatorModel, log),
          policy: infoPolicy, log,
          // Make the system-prompt-memo untrusted filter LIVE (was defaulting to trusted, so it
          // never fired): classify a teaching by its stored origin. Only the literal 'untrusted'
          // origin is filtered; 'agent-inferred' capture output stays trusted here by design (see
          // the capture trust-model note — promoting it to untrusted needs the consolidation
          // decision, not a silent flip). Decisions are human acts → always trusted.
          signalOrigin: (source, ref) =>
            source === "teaching" && store.getTeaching(Number(ref))?.origin === "untrusted"
              ? "untrusted"
              : "trusted",
        }).catch((err) => log(`distill failed: ${(err as Error).message}`));
        // memory-v2 housekeeping: entity extraction over new titles, vector sweep, usage-log prune.
        void extractNewEntities({ store, extract: extractEntitiesLLM(config.curatorModel, log), log })
          .catch((err) => log(`entity extraction failed: ${(err as Error).message}`));
        scheduleEmbed(0);
        try { store.pruneMemoryUse(new Date(Date.now() - 90 * 86_400_000).toISOString()); } catch { /* best-effort */ }
      }
    },
    onTick: () => { goals.resumeBudgetPaused(); goals.resumeApiPaused(); goals.resumeSessionPaused(); },
    onReminderDue: (r) =>
      bus.emit({ type: "reminder.due", id: r.id, text: r.text, channel: r.origin_channel, chatId: r.origin_chat_id }),
    onRoutineDue: (r) =>
      bus.emit({
        type: "routine.due", id: r.id, name: r.name, prompt: r.prompt,
        channel: r.origin_channel ?? "", chatId: r.origin_chat_id ?? "",
      }),
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

  if (config.primaryChat) {
    stops.push(startWatcher("money", config.moneyPollSeconds * 1000, async () => {
      const signals = await computeMoneySignals(store, categorize, new Date(), config);
      for (const sig of signals) {
        if (store.kvGet(sig.key)) continue;               // fire once
        await sendVia(config.primaryChat!.channel, config.primaryChat!.chatId, sig.text);
        store.kvSet(sig.key, new Date().toISOString());   // stamp AFTER send
      }
    }, () => {}, () => {}));
    stops.push(startWatcher("lifeops", config.lifeopsPollSeconds * 1000, async () => {
      const signals = computeLifeopsSignals(store.listTasks("open"), new Date(), config);
      for (const sig of signals) {
        if (store.kvGet(sig.key)) continue;               // fire once
        await sendVia(config.primaryChat!.channel, config.primaryChat!.chatId, sig.text);
        store.kvSet(sig.key, new Date().toISOString());   // stamp AFTER send
      }
    }, () => {}, () => {}));
  }

  // /api/health senses provider — google degradations are per-account, bunq is one line.
  // Both report only what EXISTS: google maps over its accounts, so none means nothing, and
  // bunq contributes nothing until it is configured. That absence is the point rather than a
  // side effect — this feeds the attention view, where an unconfigured sense would read as a
  // chore the user has to go and do.
  const sensesStatus = () => [
    ...google.accounts().map((a) => ({
      name: `google:${a.name}`,
      ok: !google.isDegraded(a.name),
      ...(google.isDegraded(a.name)
        ? { reason: google.degraded().find((d) => d.name === a.name)?.reason ?? "degraded" }
        : {}),
    })),
    ...(!bunq.enabled() ? []
      : bunq.degraded().length ? [{ name: "bunq", ok: false, reason: bunq.degraded()[0]!.reason }]
      : [{ name: "bunq", ok: true }]),
  ];

  // Deferred so the setup server can keep the port while onboarding is still running.
  // `fatal` is what separates this function's two callers, and it is required rather than
  // defaulted so neither can state its intent by accident. At startup a taken port means another
  // daemon already owns this install, and this one must not carry on headless beside it (see
  // exitOnListenError). The wizard's handover is the opposite: it is taking back a port it just
  // released, and a failure there must not kill the process still serving the user.
  const startWeb = (fatal: boolean) => {
    const web = startWebServer(
      { store, bus, goals, spendGuard, vault, config, router, gate, voice, registry, mailbox, senses: sensesStatus, reloadPacks: reloadRegistry, envPath: config.envPath, uiDist: config.uiDist, log, attachments: attachmentRegistry },
      config.uiPort,
      fatal ? exitOnListenError(log) : undefined,
    );
    // In the listen callback, not beside the call: the bind result lands a tick later, so logging
    // it here unconditionally printed "ready — …" immediately followed by the failure.
    web.once("listening", () => log(`ready — mission control listening on 127.0.0.1:${config.uiPort}`));
  };
  // Derived, never written literally. "Is this the startup call?" and "is a taken port fatal?"
  // are the same fact, and spelling the second one out as `true` lets them drift — which nothing
  // would catch, since bootNormal never runs under vitest and both call sites are unreachable
  // from the suite. One name, used twice, cannot separate.
  const atStartup = opts.startWeb !== false;
  if (atStartup) startWeb(atStartup);

  const resumed = goals.resumeUnfinished();
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

  // Wrapped, not passed through: BootedWorld.startWeb is `() => void`, and handing the raw
  // two-arity function to a caller that forwarded an argument — `promise.then(w.startWeb)` —
  // would make a truthy value mean "exit the process".
  return { store, bus, goals, moderator, registry, vault, startWeb: () => startWeb(false), shutdown };
}
