import type { InboundMessage } from "./channels/types.js";
import type { Moderator } from "./moderator/session.js";
import type { DirectChats } from "./agents/direct.js";
import { parseDirectAddress, findAgentMention } from "./agents/direct.js";
import type { FinanceAgent } from "./finance/agent.js";
import type { ChatBinding } from "./config.js";
import type { EventBus } from "./events.js";
import type { ActionGate } from "./kernel/gate.js";

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

  async handle(msg: InboundMessage): Promise<string | null> {
    const { moderator, directChats, finance, chatBindings, bus } = this.deps;
    bus?.emit({
      type: "chat.in",
      channel: msg.channel,
      chatId: msg.chatId,
      text: msg.text.slice(0, 300),
      sender: msg.sender?.username ?? msg.sender?.name,
    });

    // Gate verdicts short-circuit all routing: /approve <id>, /reject <id> [reason]
    const gateCmd = /^\/(approve|reject)\s+([\w-]+)(?:\s+([\s\S]+))?$/i.exec(msg.text.trim());
    if (gateCmd && this.deps.gate) {
      const [, verb, id, reason] = gateCmd;
      let reply: string;
      try {
        const row = await this.deps.gate.resolve(id, verb.toLowerCase() as "approve" | "reject", {
          by: msg.sender?.username ?? msg.sender?.name ?? msg.channel,
          reason: reason?.trim(),
        });
        reply =
          row.status === "executed" ? `✓ Executed [${row.type}] — ${row.result}`
          : row.status === "failed" ? `⚠ Approved, but execution failed [${row.type}] — ${row.result}`
          : `✗ Rejected [${row.type}]${row.reject_reason ? ` — ${row.reject_reason}` : ""}`;
      } catch (err) {
        reply = `Gate: ${(err as Error).message}`;
      }
      bus?.emit({ type: "chat.out", channel: msg.channel, chatId: msg.chatId, text: reply.slice(0, 300) });
      return reply;
    }

    const agentTurn = async (agent: string, run: () => Promise<string>): Promise<string> => {
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
    let reply: string | null;

    if (binding) {
      const addressed = findAgentMention(msg.text, binding.agents);
      const hasAttachments = !!msg.attachments?.length;
      if (addressed) {
        reply =
          addressed.role === "finance"
            ? await agentTurn("finance", () =>
                finance.handle(msg.channel, msg.chatId, addressed.text, msg.sender, msg.attachments))
            : `[${addressed.role}]\n${await agentTurn(addressed.role, () =>
                directChats.handle(addressed.role, msg.channel, msg.chatId, addressed.text))}`;
      } else if (binding.mentionOnly && !hasAttachments) {
        reply = null; // mention-only chat: stay silent for unaddressed chatter
      } else if (binding.agents[0] === "finance") {
        reply = await agentTurn("finance", () =>
          finance.handle(msg.channel, msg.chatId, msg.text, msg.sender, msg.attachments));
      } else {
        reply = `[${binding.agents[0]}]\n${await agentTurn(binding.agents[0], () =>
          directChats.handle(binding.agents[0], msg.channel, msg.chatId, msg.text))}`;
      }
    } else {
      const direct = parseDirectAddress(msg.text);
      reply = direct
        ? `[${direct.role}]\n${await agentTurn(direct.role, () =>
            directChats.handle(direct.role, msg.channel, msg.chatId, direct.text))}`
        : await agentTurn("moderator", () => moderator.handle(msg.channel, msg.chatId, msg.text));
    }

    if (reply !== null) {
      bus?.emit({ type: "chat.out", channel: msg.channel, chatId: msg.chatId, text: reply.slice(0, 300) });
    }
    return reply;
  }
}
