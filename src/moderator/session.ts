import { query } from "@anthropic-ai/claude-agent-sdk";
import { moderatorPrompt } from "./prompt.js";
import { buildModeratorServer, type ModeratorToolsDeps } from "./tools.js";
import type { Store } from "../store/db.js";
import type { JobManager } from "../engine/jobs.js";
import type { VaultWriter } from "../vault/writer.js";

const MCP_TOOLS = [
  "mcp__aios__run_playbook",
  "mcp__aios__job_status",
  "mcp__aios__list_playbooks",
  "mcp__aios__vault_write",
  "mcp__aios__vault_read",
  "mcp__aios__vault_list",
];

export interface ModeratorDeps {
  store: Store;
  jobs: JobManager;
  vault: VaultWriter;
  projectsRoot: string;
  model?: string;
  log?: (line: string) => void;
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

  async handle(channel: string, chatId: string, userText: string): Promise<string> {
    const chatKey = `${channel}:${chatId}`;
    const prev = this.locks.get(chatKey) ?? Promise.resolve();
    let release!: () => void;
    this.locks.set(chatKey, new Promise((r) => (release = r)));
    await prev;
    try {
      return await this.turn(chatKey, channel, chatId, userText);
    } finally {
      release();
    }
  }

  private async turn(chatKey: string, channel: string, chatId: string, userText: string): Promise<string> {
    const sessionKey = `moderator-session:${chatKey}`;
    try {
      return await this.runQuery(sessionKey, channel, chatId, userText, this.deps.store.kvGet(sessionKey));
    } catch (err) {
      // Stored session id no longer exists on disk (e.g. the turn that created it
      // errored before persisting). Heal: forget it and retry fresh once.
      if ((err as Error).message.includes("No conversation found")) {
        this.deps.log?.(`stale session for ${chatKey}, starting fresh`);
        this.deps.store.kvSet(sessionKey, "");
        return await this.runQuery(sessionKey, channel, chatId, userText, undefined);
      }
      throw err;
    }
  }

  private async runQuery(
    sessionKey: string,
    channel: string,
    chatId: string,
    userText: string,
    existing: string | undefined,
  ): Promise<string> {
    const { store, jobs, vault, projectsRoot, log = () => {} } = this.deps;
    this.origin = { channel, chatId };
    const server = buildModeratorServer({ jobs, store, vault, projectsRoot, origin: this.origin });

    const q = query({
      prompt: userText,
      options: {
        systemPrompt: moderatorPrompt(jobs.listPlaybooks(), projectsRoot),
        mcpServers: { aios: server },
        allowedTools: [...MCP_TOOLS, "Read", "Grep", "Glob", "WebSearch", "WebFetch"],
        permissionMode: "dontAsk",
        settingSources: [],
        strictMcpConfig: true,
        maxTurns: 40,
        ...(this.deps.model ? { model: this.deps.model } : {}),
        ...(existing ? { resume: existing } : {}),
      },
    });

    let reply = "";
    for await (const msg of q) {
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          // Only persist session ids from successful turns — errored turns may
          // never be written to disk and would poison future resumes.
          store.kvSet(sessionKey, msg.session_id);
          reply = msg.result;
        } else {
          const detail = "errors" in msg ? msg.errors.join("; ") : "";
          log(`moderator turn error: ${msg.subtype}${detail ? ` — ${detail}` : ""}`);
          reply = `Something went wrong handling that (${msg.subtype}${detail ? `: ${detail}` : ""}). Try again.`;
        }
      }
    }
    return reply || "(no reply)";
  }
}
