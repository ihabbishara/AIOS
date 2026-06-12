import { moderatorPrompt } from "./prompt.js";
import { buildModeratorServer, type ModeratorToolsDeps } from "./tools.js";
import { resumableTurn } from "../agents/resumable.js";
import type { Store } from "../store/db.js";
import type { JobManager } from "../engine/jobs.js";
import type { VaultWriter } from "../vault/writer.js";
import type { SpecialistRunFn } from "../agents/runner.js";
import type { ActionGate } from "../kernel/gate.js";
import type { GoogleAccounts } from "../senses/google/auth.js";

const MCP_TOOLS = [
  "mcp__aios__run_playbook",
  "mcp__aios__job_status",
  "mcp__aios__list_playbooks",
  "mcp__aios__ask_specialist",
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
];

/** ask_specialist runs a full specialist session inside an MCP call — allow up to 10 min. */
const STREAM_CLOSE_TIMEOUT_MS = 10 * 60 * 1000;

export interface ModeratorDeps {
  store: Store;
  jobs: JobManager;
  vault: VaultWriter;
  run: SpecialistRunFn;
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
    const { store, jobs, vault, projectsRoot } = this.deps;
    this.origin = { channel, chatId };
    const server = buildModeratorServer({
      jobs,
      store,
      vault,
      projectsRoot,
      origin: this.origin,
      consult: (role, question) =>
        this.deps.run(role, question, { cwd: projectsRoot, model: this.deps.specialistModel }),
      gate: this.deps.gate,
      actionTypes: this.deps.actionTypes,
      google: this.deps.google,
    });

    return resumableTurn({
      store,
      sessionKey: `moderator-session:${chatKey}`,
      prompt: userText,
      log: this.deps.log,
      options: {
        systemPrompt: moderatorPrompt(jobs.listPlaybooks(), projectsRoot),
        mcpServers: { aios: server },
        allowedTools: [...MCP_TOOLS, "Read", "Grep", "Glob", "WebSearch", "WebFetch"],
        permissionMode: "dontAsk",
        settingSources: [],
        strictMcpConfig: true,
        maxTurns: 40,
        env: { ...process.env, CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: String(STREAM_CLOSE_TIMEOUT_MS) },
        ...(this.deps.model ? { model: this.deps.model } : {}),
      },
    });
  }
}
