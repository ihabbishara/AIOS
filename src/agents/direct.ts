import { resolve } from "node:path";
import type { LoadedRegistry } from "./registry/loader.js";
import type { ResolveAgentFn } from "./resolve.js";
import { resumableTurn, clearSession } from "./resumable.js";
import { withDenialObserver } from "./permissions.js";
import { buildAttachmentServer, ATTACH_TOOL, AIOS_TMP_PREFIX } from "./attachment-server.js";
import { buildMailServer, MAIL_TOOL, ASK_TOOL } from "../mail/server.js";
import type { Mailbox } from "../mail/mailbox.js";
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
  /** THE one resolution path (org-model spec §7) — capabilities → tools/servers/guards/model. */
  resolveAgent: ResolveAgentFn;
  log?: (line: string) => void;
  /** The private primary chat — privateOnly roles are refused from any other origin. */
  primaryChat?: { channel: string; chatId: string };
  /** Agent mailbox — when set, @mention turns get send_mail + their unread-mail block. */
  mailbox?: Mailbox;
  /** Post-turn conversational capture hook (memory-v2 §5) — fire-and-forget, fail-silent. */
  capture?: (userText: string, replyText: string) => void;
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
    const resolved = this.deps.resolveAgent(role, { channel, chatId }, { cwd: this.deps.projectsRoot });
    if (!resolved) throw new Error(`Unknown specialist: ${role}`);
    const { canonical } = resolved;
    const def = resolved.def.role;

    if (def.privateOnly && !isPrivateOrigin(this.deps.primaryChat, channel, chatId)) {
      return { text: "That's private — ask me from your private chat.", attachments: [] };
    }

    const key = `direct-session:${canonical}:${channel}:${chatId}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    this.locks.set(key, new Promise((r) => (release = r)));
    await prev;
    try {
      let options = {
        ...resolved.options,
        systemPrompt: `${resolved.options.systemPrompt}${DIRECT_ADDENDUM}`,
        allowedTools: [...new Set([...(resolved.options.allowedTools ?? []), ATTACH_TOOL])],
      };
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
        AIOS_TMP_PREFIX,    // realpath'd prefix — any /tmp/aios-* path is permitted (macOS /tmp → /private/tmp)
        ...(def.attachDirs ?? []),
      ];
      const attachmentServer = buildAttachmentServer(collected, safeDirs);

      // (Cloudflare analytics for halalo now arrives inside resolved.options.mcpServers via
      // the halalo-aws capability — the hardcoded roleServers wiring is gone.)

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
          mcpServers: { ...(observed.mcpServers ?? {}), ...mailServers, aios_attachments: attachmentServer },
        },
      });

      this.deps.capture?.(userText, text); // post-turn capture (memory-v2 §5), fire-and-forget
      return { text, attachments: collected };
    } finally {
      release();
    }
  }

  resetSession(role: string, channel: string, chatId: string): void {
    // Canonicalize so the key matches the one used in handle().
    const canonical = this.deps.registry.agentOf.get(role) ?? role;
    // Bypasses the per-key lock deliberately: clearSession is atomic kv writes,
    // and the reset-epoch bump makes it win against any in-flight turn.
    clearSession(this.deps.store, `direct-session:${canonical}:${channel}:${chatId}`);
  }
}

/**
 * THE one address parser (org-model spec §8): `@name` anywhere, or `name:` prefix.
 * Bound group chats pass `requireAt: true` — the bare prefix form is DM-only there,
 * so ordinary text like "finance: revenue up" no longer hijacks a group message.
 * Mid-text mentions are stripped so the agent isn't confused by its own name.
 */
export function parseAddress(
  text: string,
  names: string[],
  opts: { requireAt?: boolean } = {},
): { role: string; text: string } | undefined {
  if (!names.length) return undefined;
  const pattern = names.map((n) => n.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|");

  // Prefix form: "@name rest" always; bare "name: rest" only when !requireAt.
  const at = opts.requireAt ? "@" : "@?";
  const m = text.match(new RegExp(`^${at}(${pattern})[:,]?\\s+(.+)$`, "is"));
  if (m) return { role: m[1].toLowerCase(), text: m[2].trim() };

  // Mention form: @name anywhere (group convention — greeting first, mention later).
  for (const name of names) {
    const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const re = new RegExp(`(^|\\s)@${escaped}\\b[:,]?`, "i");
    if (re.test(text)) {
      const rest = text.replace(re, "$1").trim();
      if (!rest) return undefined; // a bare mention with no message is not an address
      return { role: name.toLowerCase(), text: rest };
    }
  }
  return undefined;
}
