import { resolve } from "node:path";
import type { LoadedRegistry } from "./registry/loader.js";
import { resumableTurn } from "./resumable.js";
import { roleQueryOptions, roleSystemPrompt, packRunOptions } from "./runner.js";
import { withEffectiveTools, withDenialObserver } from "./permissions.js";
import { buildAttachmentServer } from "./attachment-server.js";
import { buildMailServer, MAIL_TOOL, ASK_TOOL } from "../mail/server.js";
import type { Mailbox } from "../mail/mailbox.js";
import { buildCloudflareServer } from "../senses/cloudflare/server.js";
import { HALALO_EXPORTS_DIR } from "./guards/halalo-readonly.js";
import type { Attachment } from "./attachment.js";
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";

const DIRECT_ADDENDUM =
  "\n\nYou are currently in a DIRECT CHAT with the user (via Telegram/Slack/terminal), " +
  "outside any pipeline job. Reply conversationally and phone-readable: outcome first, " +
  "short paragraphs. You keep memory of this conversation across messages. " +
  "Structured-output rules from pipeline runs do not apply here — just talk. " +
  "Never use markdown tables — unreadable on phones; use short lines or bullets.";

export interface DirectChatsDeps {
  store: Store;
  bus: EventBus;
  projectsRoot: string;
  registry: LoadedRegistry;
  model?: string;
  log?: (line: string) => void;
  /** Resolve a pack for a direct-addressed role (undefined = role has no/ambiguous pack). */
  resolvePackFor?: (role: string, origin: { channel: string; chatId: string }) => import("../packs/resolve.js").ResolvedPack | undefined;
  /** The private primary chat — privateOnly roles are refused from any other origin. */
  primaryChat?: { channel: string; chatId: string };
  /** Agent mailbox — when set, @mention turns get send_mail + their unread-mail block. */
  mailbox?: Mailbox;
}

export function isPrivateOrigin(primary: { channel: string; chatId: string } | undefined, channel: string, chatId: string): boolean {
  // The Mission Control web cockpit (web:ui) is treated as a private surface: it is bound to
  // 127.0.0.1 and operated by the single machine user, so privateOnly roles (e.g. cfo) answer there.
  if (channel === "web" && chatId === "ui") return true;
  return !!primary && primary.channel === channel && primary.chatId === chatId;
}

/** Persistent one-on-one chats with individual specialists (the `@role ...` syntax). */
export class DirectChats {
  private locks = new Map<string, Promise<void>>();

  constructor(private deps: DirectChatsDeps) {}

  /** All addressable names (canonical names + aliases) from the registry. */
  names(): string[] {
    return [...this.deps.registry.agentOf.keys()];
  }

  /** Canonical agent name for a name-or-alias, undefined when unknown. */
  canonical(nameOrAlias: string): string | undefined {
    return this.deps.registry.agentOf.get(nameOrAlias);
  }

  async handle(
    role: string,
    channel: string,
    chatId: string,
    userText: string,
    sender?: { name?: string; username?: string },
    attachments?: Array<{ path: string; fileName: string }>,
  ): Promise<{ text: string; attachments: Attachment[] }> {
    const canonical = this.deps.registry.agentOf.get(role);
    const def = canonical ? this.deps.registry.agents.get(canonical)?.role : undefined;
    if (!def || !canonical) throw new Error(`Unknown specialist: ${role}`);

    if (def.privateOnly && !isPrivateOrigin(this.deps.primaryChat, channel, chatId)) {
      return { text: "That's private — ask me from your private chat.", attachments: [] };
    }

    const key = `direct-session:${canonical}:${channel}:${chatId}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    this.locks.set(key, new Promise((r) => (release = r)));
    await prev;
    try {
      const pack = this.deps.resolvePackFor?.(canonical, { channel, chatId });
      const base = {
        ...roleQueryOptions(def, { cwd: this.deps.projectsRoot, model: this.deps.model }),
        systemPrompt: roleSystemPrompt(def) + DIRECT_ADDENDUM,
      };
      const withPack = pack ? packRunOptions(base, pack) : base;
      let options = withEffectiveTools(withPack, canonical, this.deps.store);
      // Mail: per-turn aios-mail server + widen allowlist BEFORE the observer wraps; the unread-mail
      // block prepends to the per-turn prompt (the system prompt is fixed on resumed sessions).
      let mailBlock = "";
      let deliveredIds: string[] = [];
      const mailServers: Record<string, ReturnType<typeof buildMailServer>> = {};
      if (this.deps.mailbox) {
        const mailCtx = { from: canonical, origin: { channel, chatId }, goalDepth: 0 };
        mailServers["aios-mail"] = buildMailServer(this.deps.mailbox, mailCtx);
        options = { ...options, allowedTools: [...new Set([...(options.allowedTools ?? []), MAIL_TOOL, ASK_TOOL])] };
        const peek = this.deps.mailbox.peekInbound(canonical);
        mailBlock = peek.block;
        deliveredIds = peek.ids; // committed on turn success via onSuccess below (crash re-surfaces)
      }
      const observed = withDenialObserver(options, canonical, (e) => this.deps.bus.emit({ type: "tool.denied", ...e }));

      // Attachment server: turn-scoped collector + in-process MCP server.
      const collected: Attachment[] = [];
      const safeDirs = [
        resolve(def.cwd ?? this.deps.projectsRoot),
        resolve("data/downloads"),
        HALALO_EXPORTS_DIR, // keep in sync with the halalo Write guard so generated exports are attachable
        "/tmp/aios-",       // prefix match — any /tmp/aios-* path is permitted
        ...(def.attachDirs ?? []),
      ];
      const attachmentServer = buildAttachmentServer(collected, safeDirs);

      // Halalo gets a read-only Cloudflare analytics tool: true edge visitor counts,
      // the source of truth its log-derived numbers undercount (CDN cache hits).
      const roleServers: Record<string, ReturnType<typeof buildCloudflareServer>> =
        canonical === "halalo" ? { halalo_analytics: buildCloudflareServer() } : {};

      // Prefix the user text with sender identity when provided (group-chat attribution).
      // Attachment markers follow the sender prefix so the agent sees evidence before the text.
      const from = sender
        ? `[from: ${sender.name ?? "?"}${sender.username ? ` (@${sender.username})` : ""}]\n`
        : "";
      const attachmentLines = (attachments ?? []).map((a) => `[attached file stored at: ${a.path}]`);
      const prompt =
        (mailBlock ? `${mailBlock}\n\n` : "") +
        from +
        (attachmentLines.length ? `${attachmentLines.join("\n")}\n` : "") +
        userText;

      const text = await resumableTurn({
        store: this.deps.store,
        sessionKey: key,
        prompt,
        log: this.deps.log,
        // Commit mail ONLY on a successful turn. An SDK error-reply (no throw) does NOT fire this,
        // so the mail re-surfaces next @mention — intended: re-deliver beats losing it (durability
        // favours the safe side; the ≤5-cap block just reappears until a turn succeeds).
        onSuccess: () => this.deps.mailbox?.markDelivered(deliveredIds),
        options: {
          ...observed,
          mcpServers: { ...(observed.mcpServers ?? {}), ...roleServers, ...mailServers, aios_attachments: attachmentServer },
        },
      });

      return { text, attachments: collected };
    } finally {
      release();
    }
  }

  resetSession(role: string, channel: string, chatId: string): void {
    // Canonicalize so the key matches the one used in handle().
    const canonical = this.deps.registry.agentOf.get(role) ?? role;
    // Intentionally bypasses the per-key lock: clearing the session key is a
    // single atomic KV write. However, if a turn is in-flight when this is called,
    // the completing turn will write the old session_id back, silently undoing the
    // reset. If that happens the user may need to issue /reset a second time once
    // the in-flight turn finishes.
    this.deps.store.kvSet(`direct-session:${canonical}:${channel}:${chatId}`, "");
  }
}

/** Parses "@name rest" / "name: rest" against an explicit agent-name list. */
export function parseAgentAddress(
  text: string,
  names: string[],
): { role: string; text: string } | undefined {
  if (!names.length) return undefined;
  const pattern = names.map((n) => n.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|");
  const m = text.match(new RegExp(`^@?(${pattern})[:,]?\\s+(.+)$`, "is"));
  if (!m) return undefined;
  return { role: m[1].toLowerCase(), text: m[2].trim() };
}

/**
 * Parses direct-address prefixes for specialist roles: "@architect how should we...".
 * Returns the role + remaining text, or undefined when the message is for the moderator.
 * The caller (router) supplies the names list from the live registry.
 */
export function parseDirectAddress(text: string, names: string[]): { role: string; text: string } | undefined {
  return parseAgentAddress(text, names);
}

/**
 * Finds an @agent mention ANYWHERE in the message (group convention — people
 * write greetings first, mention on a later line). Returns the full text with
 * the mention removed so the agent isn't confused by its own name.
 */
export function findAgentMention(
  text: string,
  names: string[],
): { role: string; text: string } | undefined {
  // Prefix form first (also supports bare "finance: ..." without @).
  const prefixed = parseAgentAddress(text, names);
  if (prefixed) return prefixed;
  for (const name of names) {
    const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const re = new RegExp(`(^|\\s)@${escaped}\\b[:,]?`, "i");
    if (re.test(text)) {
      return { role: name.toLowerCase(), text: text.replace(re, "$1").trim() };
    }
  }
  return undefined;
}
