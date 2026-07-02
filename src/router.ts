import type { InboundMessage } from "./channels/types.js";
import type { Moderator } from "./moderator/session.js";
import { type DirectChats, parseDirectAddress, findAgentMention } from "./agents/direct.js";
import type { FinanceAgent } from "./finance/agent.js";
import type { ChatBinding } from "./config.js";
import type { EventBus } from "./events.js";
import type { ActionGate } from "./kernel/gate.js";
import type { Attachment } from "./agents/attachment.js";

export type RouterResult = { text: string; attachments: Attachment[] };

export interface RouterDeps {
  moderator: Moderator;
  directChats: DirectChats;
  finance: FinanceAgent;
  chatBindings: Map<string, ChatBinding>;
  bus?: EventBus;
  gate?: ActionGate;
}

/**
 * Single routing brain for every channel (Telegram, Slack, CLI, Web):
 * bound chats → bound agents (mention-only aware); @role → direct chat;
 * everything else → moderator. Returns null when the message should be ignored.
 */
export class MessageRouter {
  constructor(private deps: RouterDeps) {}

  async handle(msg: InboundMessage): Promise<RouterResult | null> {
    const { moderator, directChats, finance, chatBindings, bus } = this.deps;
    bus?.emit({
      type: "chat.in",
      channel: msg.channel,
      chatId: msg.chatId,
      text: msg.text.slice(0, 300),
      sender: msg.sender?.username ?? msg.sender?.name,
    });

    /** Wrap a plain string result (moderator / finance / gate / reset) into RouterResult. */
    const textOnly = (text: string): RouterResult => ({ text, attachments: [] });

    // Session reset commands: /reset or /new [role]
    // NOTE: This block is intentionally placed BEFORE the mentionOnly gate below.
    // /reset must always be available even in mention-only chats — do not move it
    // below the `binding.mentionOnly` check without understanding this invariant.
    const resetCmd = /^\/(?:reset|new)(?:\s+@?([\w-]+))?$/i.exec(msg.text.trim());
    if (resetCmd) {
      const roleName = resetCmd[1]?.toLowerCase();
      let replyText: string;
      if (roleName) {
        const knownRoles = directChats.names();
        if (!knownRoles.includes(roleName)) {
          replyText = `Unknown role "${roleName}". Available: ${knownRoles.join(", ")}.`;
        } else {
          directChats.resetSession(roleName, msg.channel, msg.chatId);
          replyText = `@${roleName} session reset. Starting fresh next message.`;
        }
      } else {
        moderator.resetSession(msg.channel, msg.chatId);
        replyText = "Session reset. Starting fresh next message.";
      }
      bus?.emit({ type: "chat.out", channel: msg.channel, chatId: msg.chatId, text: replyText.slice(0, 300) });
      return textOnly(replyText);
    }

    // Gate verdicts short-circuit all routing: /approve <id>, /reject <id> [reason]
    const gateCmd = /^\/(approve|reject)\s+([\w-]+)(?:\s+([\s\S]+))?$/i.exec(msg.text.trim());
    if (gateCmd && this.deps.gate) {
      const [, verb, id, reason] = gateCmd;
      let replyText: string;
      try {
        const row = await this.deps.gate.resolve(id, verb.toLowerCase() as "approve" | "reject", {
          by: msg.sender?.username ?? msg.sender?.name ?? msg.channel,
          reason: reason?.trim(),
        });
        replyText =
          row.status === "executed" ? `✓ Executed [${row.type}] — ${row.result}`
          : row.status === "failed" ? `⚠ Approved, but execution failed [${row.type}] — ${row.result}`
          : `✗ Rejected [${row.type}]${row.reject_reason ? ` — ${row.reject_reason}` : ""}`;
      } catch (err) {
        replyText = `Gate: ${err instanceof Error ? err.message : String(err)}`;
      }
      bus?.emit({ type: "chat.out", channel: msg.channel, chatId: msg.chatId, text: replyText.slice(0, 300) });
      return textOnly(replyText);
    }

    // Generic agent wrapper — emits start/end events, propagates typed return.
    const agentTurn = async <T>(agent: string, run: () => Promise<T>): Promise<T> => {
      const context = `chat:${msg.channel}:${msg.chatId}`;
      bus?.emit({ type: "agent.start", agent, context });
      try {
        const out = await run();
        bus?.emit({ type: "agent.end", agent, context, ok: true });
        return out;
      } catch (err) {
        bus?.emit({ type: "agent.end", agent, context, ok: false });
        throw err;
      }
    };

    const binding = chatBindings.get(`${msg.channel}:${msg.chatId}`);
    let reply: RouterResult | null;

    if (binding) {
      const addressed = findAgentMention(msg.text, binding.agents);
      const hasAttachments = !!msg.attachments?.length;
      if (addressed) {
        if (addressed.role === "finance") {
          const text = await agentTurn("finance", () =>
            finance.handle(msg.channel, msg.chatId, addressed.text, msg.sender, msg.attachments));
          reply = textOnly(text);
        } else {
          const result = await agentTurn(addressed.role, () =>
            directChats.handle(addressed.role, msg.channel, msg.chatId, addressed.text));
          reply = { text: `[${addressed.role}]\n${result.text}`, attachments: result.attachments };
        }
      } else if (binding.mentionOnly && !hasAttachments) {
        reply = null; // mention-only chat: stay silent for unaddressed chatter
      } else if (binding.agents[0] === "finance") {
        const text = await agentTurn("finance", () =>
          finance.handle(msg.channel, msg.chatId, msg.text, msg.sender, msg.attachments));
        reply = textOnly(text);
      } else {
        const result = await agentTurn(binding.agents[0], () =>
          directChats.handle(binding.agents[0], msg.channel, msg.chatId, msg.text));
        reply = { text: `[${binding.agents[0]}]\n${result.text}`, attachments: result.attachments };
      }
    } else {
      const direct = parseDirectAddress(msg.text, directChats.names());
      if (direct) {
        const result = await agentTurn(direct.role, () =>
          directChats.handle(direct.role, msg.channel, msg.chatId, direct.text));
        reply = { text: `[${direct.role}]\n${result.text}`, attachments: result.attachments };
      } else {
        const text = await agentTurn("moderator", () =>
          moderator.handle(msg.channel, msg.chatId, msg.text, msg.attachments));
        reply = textOnly(text);
      }
    }

    if (reply !== null) {
      bus?.emit({ type: "chat.out", channel: msg.channel, chatId: msg.chatId, text: reply.text.slice(0, 300) });
    }
    return reply;
  }
}
