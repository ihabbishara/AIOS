import type { InboundMessage } from "./channels/types.js";
import type { Moderator } from "./moderator/session.js";
import { type DirectChats, parseAddress } from "./agents/direct.js";
import type { ChatBinding } from "./config.js";
import type { EventBus } from "./events.js";
import type { ActionGate } from "./kernel/gate.js";
import type { Attachment } from "./agents/attachment.js";

export type RouterResult = { text: string; attachments: Attachment[] };

export interface RouterDeps {
  moderator: Moderator;
  directChats: DirectChats;
  chatBindings: Map<string, ChatBinding>;
  bus?: EventBus;
  gate?: ActionGate;
  /** Goal lifecycle intercepts (/pause /resume /abandon). */
  goals?: import("./engine/goals.js").GoalEngine;
}

/**
 * Single routing brain for every channel (Telegram, Slack, CLI, Web):
 * bound chats → bound agents (mention-only aware); @role → direct chat;
 * everything else → moderator. Returns null when the message should be ignored.
 */
export class MessageRouter {
  constructor(private deps: RouterDeps) {}

  async handle(msg: InboundMessage): Promise<RouterResult | null> {
    const { moderator, directChats, chatBindings, bus } = this.deps;
    bus?.emit({
      type: "chat.in",
      channel: msg.channel,
      chatId: msg.chatId,
      text: msg.text.slice(0, 300),
      sender: msg.sender?.username ?? msg.sender?.name,
    });

    /** Wrap a plain string result (moderator / finance / gate / reset) into RouterResult. */
    const textOnly = (text: string): RouterResult => ({ text, attachments: [] });

    /** Emit a route.decision event before the agent turn. */
    const routed = (
      to: string,
      via: "mention" | "binding" | "handoff" | "default" | "verdict" | "reset",
      reason: string,
    ) =>
      bus?.emit({ type: "route.decision", to, via, reason, channel: msg.channel, chatId: msg.chatId });

    // Session reset commands: /reset or /new [role]
    // NOTE: This block is intentionally placed BEFORE the mentionOnly gate below.
    // /reset must always be available even in mention-only chats — do not move it
    // below the `binding.mentionOnly` check without understanding this invariant.
    const resetCmd = /^\/(?:reset|new)(?:\s+@?([\w-]+))?$/i.exec(msg.text.trim());
    if (resetCmd) {
      const roleName = resetCmd[1]?.toLowerCase();
      let replyText: string;
      let resetOccurred = false;
      if (roleName) {
        const knownRoles = directChats.names();
        if (!knownRoles.includes(roleName)) {
          replyText = `Unknown role "${roleName}". Available: ${knownRoles.join(", ")}.`;
        } else {
          directChats.resetSession(roleName, msg.channel, msg.chatId);
          replyText = `@${roleName} session reset. Starting fresh next message.`;
          resetOccurred = true;
        }
      } else {
        moderator.resetSession(msg.channel, msg.chatId);
        replyText = "Session reset. Starting fresh next message.";
        resetOccurred = true;
      }
      // Only emit route.decision if reset actually happened (valid role or moderator)
      if (resetOccurred) {
        const resetTarget = roleName ? (directChats.canonical(roleName) ?? roleName) : "hermes";
        routed(resetTarget, "reset", "session reset");
      }
      bus?.emit({ type: "chat.out", channel: msg.channel, chatId: msg.chatId, text: replyText.slice(0, 300) });
      return textOnly(replyText);
    }

    // Gate verdicts short-circuit all routing: /approve <id>, /reject <id> [reason]
    const gateCmd = /^\/(approve|reject)\s+([\w-]+)(?:\s+([\s\S]+))?$/i.exec(msg.text.trim());
    if (gateCmd) {
      routed("gate", "verdict", "/approve|/reject intercept");
      const [, verb, id, reason] = gateCmd;
      let replyText: string;
      if (this.deps.gate) {
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
      } else {
        replyText = `Gate: no action gate configured`;
      }
      bus?.emit({ type: "chat.out", channel: msg.channel, chatId: msg.chatId, text: replyText.slice(0, 300) });
      return textOnly(replyText);
    }

    // Goal lifecycle short-circuits: /pause <goal>, /resume <goal>, /abandon <goal>
    const goalCmd = /^\/(pause|resume|abandon)\s+(\S+)\s*$/i.exec(msg.text.trim());
    if (goalCmd && this.deps.goals) {
      const [, verb, ref] = goalCmd;
      const v = verb.toLowerCase();
      const replyText =
        v === "pause" ? this.deps.goals.pauseGoal(ref)
        : v === "resume" ? this.deps.goals.resumeGoal(ref)
        : this.deps.goals.abandonGoal(ref);
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
      // Bound groups require the @ form — bare "name:" prefixes stay DM-only (spec §8).
      const addressed = parseAddress(msg.text, binding.agents, { requireAt: true });
      const hasAttachments = !!msg.attachments?.length;
      if (addressed) {
        const canonicalTo = directChats.canonical(addressed.role) ?? addressed.role;
        routed(canonicalTo, "mention", `mention of ${addressed.role} in bound chat`);
        const result = await agentTurn(addressed.role, () =>
          directChats.handle(addressed.role, msg.channel, msg.chatId, addressed.text, msg.sender, msg.attachments));
        reply = { text: `[${addressed.role}]\n${result.text}`, attachments: result.attachments };
      } else if (binding.mentionOnly && !hasAttachments) {
        reply = null; // mention-only chat: stay silent for unaddressed chatter
      } else {
        const canonicalTo = directChats.canonical(binding.agents[0]) ?? binding.agents[0];
        routed(canonicalTo, "binding", "first bound agent");
        const result = await agentTurn(binding.agents[0], () =>
          directChats.handle(binding.agents[0], msg.channel, msg.chatId, msg.text, msg.sender, msg.attachments));
        reply = { text: `[${binding.agents[0]}]\n${result.text}`, attachments: result.attachments };
      }
    } else {
      const direct = parseAddress(msg.text, directChats.names());
      if (direct) {
        const canonicalTo = directChats.canonical(direct.role) ?? direct.role;
        routed(canonicalTo, "mention", `@${direct.role} addressed`);
        const result = await agentTurn(direct.role, () =>
          directChats.handle(direct.role, msg.channel, msg.chatId, direct.text, msg.sender, msg.attachments));
        reply = { text: `[${direct.role}]\n${result.text}`, attachments: result.attachments };
      } else {
        routed("hermes", "default", "no mention — chief of staff");
        const text = await agentTurn("hermes", () =>
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
