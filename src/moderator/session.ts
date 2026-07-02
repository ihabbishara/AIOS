import { moderatorPrompt } from "./prompt.js";
import { memoContext } from "../memory/memos.js";
import { buildModeratorServer, type ModeratorToolsDeps } from "./tools.js";
import { resumableTurn } from "../agents/resumable.js";
import { processAttachments } from "../attachments.js";
import type { Store } from "../store/db.js";
import type { JobManager } from "../engine/jobs.js";
import type { VaultWriter } from "../vault/writer.js";
import type { ActionGate } from "../kernel/gate.js";
import type { GoogleAccounts } from "../senses/google/auth.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import { effectiveAllowedTools, withDenialObserver } from "../agents/permissions.js";
import type { EventBus } from "../events.js";

const MCP_TOOLS = [
  "mcp__aios__run_playbook",
  "mcp__aios__job_status",
  "mcp__aios__list_playbooks",
  "mcp__aios__hand_off",
  "mcp__aios__vault_write",
  "mcp__aios__vault_read",
  "mcp__aios__vault_list",
  "mcp__aios__propose_action",
  "mcp__aios__add_reminder",
  "mcp__aios__list_reminders",
  "mcp__aios__cancel_reminder",
  "mcp__aios__add_triage_rule",
  "mcp__aios__list_inbox",
  "mcp__aios__read_email",
  "mcp__aios__recall",
  "mcp__aios__remember",
  "mcp__aios__forget",
];

/** The moderator (hermes) pseudo-role's code-default allowlist — single source of truth (also read by /api/permissions). */
export const MODERATOR_ALLOWED_TOOLS = [...MCP_TOOLS, "Read", "Grep", "Glob", "WebSearch", "WebFetch"];

/** hand_off runs a full specialist session inside an MCP call — allow up to 10 min. */
const STREAM_CLOSE_TIMEOUT_MS = 10 * 60 * 1000;

export interface ModeratorDeps {
  store: Store;
  bus: EventBus;
  jobs: JobManager;
  vault: VaultWriter;
  /** Inline hand-off to a named agent (full tool set — parity with @mention).
   *  origin is the real per-turn origin — carried so the private-agent wall + ledger
   *  scoping in makeHandOff see the true chat, not a hardcoded system:handoff. */
  handOff: (agent: string, task: string, origin: { channel: string; chatId: string }) => Promise<{ text: string }>;
  registry: LoadedRegistry;
  projectsRoot: string;
  model?: string;
  specialistModel?: string;
  log?: (line: string) => void;
  gate: ActionGate;
  actionTypes: string[];
  google: GoogleAccounts;
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
  ): Promise<string> {
    const chatKey = `${channel}:${chatId}`;
    const prev = this.locks.get(chatKey) ?? Promise.resolve();
    let release!: () => void;
    this.locks.set(chatKey, new Promise((r) => (release = r)));
    await prev;
    try {
      return await this.turn(chatKey, channel, chatId, userText, attachments);
    } finally {
      release();
    }
  }

  resetSession(channel: string, chatId: string): void {
    // Intentionally bypasses the per-chat lock: clearing the session key is a
    // single atomic KV write. However, if a turn is in-flight when this is called,
    // the completing turn will write the old session_id back, silently undoing the
    // reset. If that happens the user may need to issue /reset a second time once
    // the in-flight turn finishes.
    this.deps.store.kvSet(`moderator-session:${channel}:${chatId}`, "");
  }

  private async turn(
    chatKey: string,
    channel: string,
    chatId: string,
    userText: string,
    attachments?: Array<{ path: string; fileName: string }>,
  ): Promise<string> {
    const { store, jobs, vault, projectsRoot, registry } = this.deps;
    this.origin = { channel, chatId };

    // Process attachments before the agent turn so vault copies exist even if
    // the turn fails. The annotation block is prepended to the user message.
    const attachmentBlock = attachments?.length
      ? await processAttachments(attachments, vault, this.deps.log)
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

    // Prepend hermes's persona block (tolerate hermes absent — skip prefix).
    const hermesPersona = registry.agents.get("hermes")?.role.systemPrompt;
    const basePrompt = moderatorPrompt(jobs.listPlaybooks(), projectsRoot, memoContext(store, vault), roster);
    const systemPrompt = hermesPersona ? `${hermesPersona}\n\n${basePrompt}` : basePrompt;

    // hermes is the chief of staff himself — never a hand_off target (would recurse).
    const agentNames = [...registry.agents.keys()].filter((n) => n !== "hermes");

    const server = buildModeratorServer({
      jobs,
      store,
      vault,
      projectsRoot,
      origin: this.origin,
      handOff: this.deps.handOff,
      agentNames,
      gate: this.deps.gate,
      actionTypes: this.deps.actionTypes,
      google: this.deps.google,
      log: this.deps.log,
    });

    const moderatorOptions = {
      systemPrompt,
      mcpServers: { aios: server },
      allowedTools: effectiveAllowedTools("hermes", MODERATOR_ALLOWED_TOOLS, store),
      permissionMode: "dontAsk" as const,
      settingSources: [],
      strictMcpConfig: true,
      maxTurns: 40,
      env: { ...process.env, CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: String(STREAM_CLOSE_TIMEOUT_MS) },
      ...(this.deps.model ? { model: this.deps.model } : {}),
    };

    return resumableTurn({
      store,
      sessionKey: `moderator-session:${chatKey}`,
      prompt,
      log: this.deps.log,
      options: withDenialObserver(moderatorOptions, "hermes", (e) => this.deps.bus.emit({ type: "tool.denied", ...e })),
    });
  }
}
