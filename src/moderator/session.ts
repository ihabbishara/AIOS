import { moderatorBlocks } from "./prompt.js";
import { memoContext } from "../memory/memos.js";
import { buildModeratorServer, type ModeratorToolsDeps } from "./tools.js";
import { resumableTurn, clearSession, surfaceHash } from "../agents/resumable.js";
import { processAttachments, type MediaDeps } from "../attachments.js";
import { buildAttachmentServer, ATTACH_TOOL, AIOS_TMP_PREFIX } from "../agents/attachment-server.js";
import type { Attachment } from "../agents/attachment.js";
import { resolve as resolvePath } from "node:path";
import type { Store } from "../store/db.js";
import type { GoalEngine } from "../engine/goals.js";
import type { VaultWriter } from "../vault/writer.js";
import type { ActionGate } from "../kernel/gate.js";
import type { GoogleAccounts } from "../senses/google/auth.js";
import type { Mailbox } from "../mail/mailbox.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import type { ResolveAgentFn } from "../agents/resolve.js";
import { withDenialObserver } from "../agents/permissions.js";
import type { EventBus } from "../events.js";


/** hand_off runs a full specialist session inside an MCP call — allow up to 10 min. */
const STREAM_CLOSE_TIMEOUT_MS = 10 * 60 * 1000;

export interface ModeratorDeps {
  store: Store;
  bus: EventBus;
  goals: GoalEngine;
  vault: VaultWriter;
  /** Inline hand-off to a named agent (full tool set — parity with @mention).
   *  origin is the real per-turn origin — carried so the private-agent wall + ledger
   *  scoping in makeHandOff see the true chat, not a hardcoded system:handoff. */
  handOff: (agent: string, task: string, origin: { channel: string; chatId: string }) => Promise<{ text: string }>;
  registry: LoadedRegistry;
  projectsRoot: string;
  /** THE one resolution path — hermes is a normal coordinator agent (org-model spec §5). */
  resolveAgent: ResolveAgentFn;
  log?: (line: string) => void;
  gate: ActionGate;
  actionTypes: string[];
  google: GoogleAccounts;
  mailbox?: Mailbox;
  /** memory-v2 retrieval knobs, threaded into the recall tool. */
  memory: ModeratorToolsDeps["memory"];
  /** Post-turn conversational capture hook (memory-v2 §5) — fire-and-forget, fail-silent. */
  capture?: (userText: string, replyText: string) => void;
  /** Media understanding for attachments — transcription + downscale (spec 2026-07-18). */
  media?: MediaDeps;
}

/**
 * One persistent moderator conversation per chat (chatKey = channel:chatId).
 * Each inbound message resumes the stored SDK session, so the moderator
 * remembers the whole conversation across daemon restarts.
 */
export class Moderator {
  /** Serializes turns per chat — resuming the same session concurrently corrupts context. */
  private locks = new Map<string, Promise<void>>();
  private origin: ModeratorToolsDeps["origin"] = { channel: "cli", chatId: "local" };

  constructor(private deps: ModeratorDeps) {}

  async handle(
    channel: string,
    chatId: string,
    userText: string,
    attachments?: Array<{ path: string; fileName: string }>,
  ): Promise<{ text: string; attachments: Attachment[] }> {
    const chatKey = `${channel}:${chatId}`;
    const prev = this.locks.get(chatKey) ?? Promise.resolve();
    let release!: () => void;
    this.locks.set(chatKey, new Promise((r) => (release = r)));
    await prev;
    try {
      const collected: Attachment[] = [];
      const reply = await this.turn(chatKey, channel, chatId, userText, attachments, collected);
      this.deps.capture?.(userText, reply); // post-turn capture (memory-v2 §5), fire-and-forget
      return { text: reply, attachments: collected };
    } finally {
      release();
    }
  }

  resetSession(channel: string, chatId: string): void {
    // Bypasses the per-chat lock deliberately: clearSession is atomic kv writes,
    // and the reset-epoch bump makes it win against any in-flight turn.
    clearSession(this.deps.store, `moderator-session:${channel}:${chatId}`);
  }

  private async turn(
    chatKey: string,
    channel: string,
    chatId: string,
    userText: string,
    attachments: Array<{ path: string; fileName: string }> | undefined,
    collected: Attachment[],
  ): Promise<string> {
    const { store, goals, vault, projectsRoot, registry } = this.deps;
    this.origin = { channel, chatId };

    // Process attachments before the agent turn so vault copies exist even if
    // the turn fails. The annotation block is prepended to the user message.
    const attachmentBlock = attachments?.length
      ? await processAttachments(attachments, vault, this.deps.log, this.deps.media)
      : "";

    const prompt = attachmentBlock
      ? `${attachmentBlock}\n${userText || "(no caption — analyze the attached files)"}`
      : userText || "(empty message)";

    // Build roster from the live registry for the team block in the system prompt.
    const roster = [...registry.agents.values()].map((a) => ({
      name: a.manifest.name,
      title: a.manifest.title,
      charter: a.manifest.charter,
      department: a.department,
    }));

    // hermes is a normal coordinator agent — resolveAgent supplies YAML prompt + dept context
    // + capability tools + tiered model; the generated blocks (roster/playbooks/paths/memo)
    // are appended here because they cannot live in YAML.
    // cwd MUST stay the daemon cwd: SDK sessions are stored per project dir, and the
    // moderator's resumable sessions predate the org-model cutover. Changing cwd here made
    // resume fail ("No conversation found with session ID") and the SDK child's teardown
    // EPIPE'd the daemon (observed live at the org-model deploy).
    const resolved = this.deps.resolveAgent(registry.coordinator, this.origin, { cwd: process.cwd() });
    if (!resolved) throw new Error(`coordinator agent "${registry.coordinator}" missing from registry`);
    const systemPrompt = `${resolved.options.systemPrompt}\n\n${moderatorBlocks({
      playbooks: goals.listPlaybooks(), projectsRoot,
      memoBlock: memoContext(store, vault), roster,
    })}`;

    // The coordinator is the chief of staff himself — never a hand_off target (would recurse).
    const agentNames = [...registry.agents.keys()].filter((n) => n !== registry.coordinator);

    const server = buildModeratorServer({
      goals,
      departments: [...registry.departments.keys()],
      bus: this.deps.bus,
      store,
      vault,
      projectsRoot,
      origin: this.origin,
      handOff: this.deps.handOff,
      agentNames,
      media: this.deps.media,
      gate: this.deps.gate,
      actionTypes: this.deps.actionTypes,
      google: this.deps.google,
      mailbox: this.deps.mailbox,
      memory: this.deps.memory,
      log: this.deps.log,
    });

    // Turn-scoped attachment collector — same safe dirs as the direct seam (direct.ts):
    // hermes can deliver rendered media/files from these roots to the chat.
    const attachmentServer = buildAttachmentServer(collected, [
      resolvePath(projectsRoot),
      resolvePath("data/downloads"),
      AIOS_TMP_PREFIX, // realpath'd /tmp/aios- prefix — media render outputs land here
    ]);

    const moderatorOptions = {
      ...resolved.options,
      systemPrompt,
      allowedTools: [...new Set([...(resolved.options.allowedTools ?? []), ATTACH_TOOL])],
      mcpServers: { ...(resolved.options.mcpServers ?? {}), aios: server, aios_attachments: attachmentServer },
      settingSources: [],
      strictMcpConfig: true,
      env: { ...process.env, CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: String(STREAM_CLOSE_TIMEOUT_MS) },
    };

    const finalOptions = withDenialObserver(moderatorOptions, resolved.canonical, (e) => this.deps.bus.emit({ type: "tool.denied", ...e }));
    return resumableTurn({
      store,
      sessionKey: `moderator-session:${chatKey}`,
      prompt,
      log: this.deps.log,
      surfaceHash: surfaceHash(finalOptions, resolved.personaSurface),
      options: finalOptions,
    });
  }
}
