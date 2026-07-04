// src/mail/mailbox.ts — agent-to-agent mail: validation, persistence, context injection.
import { randomUUID } from "node:crypto";
import type { Store } from "../store/db.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import type { AiosEvent } from "../events.js";
import { isPrivateOrigin } from "../agents/direct.js";

export interface MailboxDeps {
  store: Store;
  registry: LoadedRegistry;
  maxDepth: number;
  disabled: boolean;
  primaryChat?: { channel: string; chatId: string };
  onEvent?: (e: AiosEvent) => void;
  onQueued?: () => void;
}

export interface MailSendCtx {
  from: string;
  origin: { channel: string; chatId: string };
  goalDepth: number;
}

const INJECT_CAP = 5;
const BODY_TRUNCATE = 500;
const clip = (s: string) => (s.length <= BODY_TRUNCATE ? s : `${s.slice(0, BODY_TRUNCATE)}…`);

export class Mailbox {
  constructor(private deps: MailboxDeps) {}

  /** Tool-friendly: always returns a human-readable string, never throws. */
  send(ctx: MailSendCtx, args: { to: string; kind: "request" | "note"; body: string }): string {
    if (this.deps.disabled) return "Refused: the mailbox is disabled (AIOS_MAIL_DISABLED).";
    const canonical = this.deps.registry.agentOf.get(args.to);
    const def = canonical ? this.deps.registry.agents.get(canonical) : undefined;
    if (!canonical || !def) return `Refused: Unknown recipient "${args.to}".`;
    if (canonical === ctx.from) return "Refused: you can't mail yourself.";
    if (def.manifest.visibility === "private" &&
        !isPrivateOrigin(this.deps.primaryChat, ctx.origin.channel, ctx.origin.chatId)) {
      return `Refused: ${canonical} is private — this chat's origin can't reach them.`;
    }
    const id = randomUUID();
    this.deps.store.insertMail({
      id, from_agent: ctx.from, to_agent: canonical, kind: args.kind, body: args.body,
      goal_id: null, origin_channel: ctx.origin.channel, origin_chat_id: ctx.origin.chatId,
      chain_depth: ctx.goalDepth + 1,
      status: args.kind === "request" ? "queued" : "unread",
      error: null,
    });
    this.deps.onEvent?.({ type: "mail.sent", id, from: ctx.from, to: canonical, kind: args.kind });
    if (args.kind === "request") this.deps.onQueued?.();
    return args.kind === "request"
      ? `Mail sent — ${canonical} will run this as a goal and the result reports back to you.`
      : `Note delivered to ${canonical}.`;
  }

  /** System-prompt block: unread inbound first, then own refusal acks — WITHOUT marking read.
   *  Returns the picked ids so the caller commits via markDelivered() only after the consuming
   *  run actually succeeds; a run that crashes after injection never commits, so the mail
   *  re-surfaces on the next run (durable delivery — no lost notes on crash). */
  peekInbound(canonical: string): { block: string; ids: string[] } {
    const inbound = this.deps.store.unreadMailFor(canonical);
    const refusals = this.deps.store.refusedMailFrom(canonical);
    const picked = [...inbound, ...refusals].slice(0, INJECT_CAP);
    if (!picked.length) return { block: "", ids: [] };
    const lines = picked.map((m) =>
      m.status === "refused"
        ? `- your request to ${m.to_agent} was refused: ${m.error ?? "unknown reason"}`
        : `- from ${m.from_agent} (${m.kind}, ${m.created_at.slice(0, 16)}): ${clip(m.body)}`,
    );
    return { block: `# Mail\nYou have ${picked.length} message(s):\n${lines.join("\n")}`, ids: picked.map((m) => m.id) };
  }

  /** Commit delivery — stamp read_at (unread→read; refused keeps its status, read_at = ack).
   *  Idempotent and empty-safe; call only from a successful run's completion path. */
  markDelivered(ids: string[]): void {
    if (ids.length) this.deps.store.markMailRead(ids);
  }
}
