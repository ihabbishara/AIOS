// src/mail/mailbox.ts — agent-to-agent mail: validation, persistence, context injection.
import { randomUUID } from "node:crypto";
import type { Store } from "../store/db.js";
import type { LoadedRegistry, AgentDef } from "../agents/registry/loader.js";
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
  /** Set when the run is a goal node — enables ask_mail to park the goal. */
  goalId?: string;
  nodeKey?: string;
}

const INJECT_CAP = 5;
const BODY_TRUNCATE = 500;
const clip = (s: string) => (s.length <= BODY_TRUNCATE ? s : `${s.slice(0, BODY_TRUNCATE)}…`);

export class Mailbox {
  constructor(private deps: MailboxDeps) {}

  /** Shared recipient validation for send/ask. Returns the resolved recipient or a refusal string. */
  private resolveRecipient(ctx: MailSendCtx, to: string, verb: "mail" | "ask"):
    { canonical: string; def: AgentDef } | { refusal: string } {
    if (this.deps.disabled) return { refusal: "Refused: the mailbox is disabled (AIOS_MAIL_DISABLED)." };
    const canonical = this.deps.registry.agentOf.get(to);
    const def = canonical ? this.deps.registry.agents.get(canonical) : undefined;
    if (!canonical || !def) return { refusal: `Refused: Unknown recipient "${to}".` };
    if (canonical === ctx.from) return { refusal: `Refused: you can't ${verb} yourself.` };
    if (def.manifest.visibility === "private" &&
        !isPrivateOrigin(this.deps.primaryChat, ctx.origin.channel, ctx.origin.chatId))
      return { refusal: `Refused: ${canonical} is private — this chat's origin can't reach them.` };
    return { canonical, def };
  }

  /** Tool-friendly: always returns a human-readable string, never throws. */
  send(ctx: MailSendCtx, args: { to: string; kind: "request" | "note"; body: string }): string {
    const r = this.resolveRecipient(ctx, args.to, "mail");
    if ("refusal" in r) return r.refusal;
    const { canonical } = r;
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

  /** Ask another agent a question mid-goal. Queues a request AND parks the caller's goal
   *  until the answer reports back. Tool-friendly: always returns a string, never throws. */
  ask(ctx: MailSendCtx, args: { to: string; question: string }): string {
    if (this.deps.disabled) return "Refused: the mailbox is disabled (AIOS_MAIL_DISABLED).";
    if (!ctx.goalId) return "Refused: ask_mail only works inside a goal (use send_mail for fire-and-forget).";
    const r = this.resolveRecipient(ctx, args.to, "ask");
    if ("refusal" in r) return r.refusal;
    const { canonical } = r;
    const goal = this.deps.store.getGoal(ctx.goalId);
    if (goal?.awaiting_mail) return `Refused: you already have a pending question (mail ${goal.awaiting_mail}).`;
    // Continue the goal's incoming conversation when it was itself mail-spawned; else a fresh thread.
    const parentThread = goal?.spawned_by_mail
      ? this.deps.store.getMail(goal.spawned_by_mail)?.thread_id : undefined;
    const id = randomUUID();
    this.deps.store.transaction(() => {
      this.deps.store.insertMail({
        id, from_agent: ctx.from, to_agent: canonical, kind: "request", body: args.question,
        goal_id: null, origin_channel: ctx.origin.channel, origin_chat_id: ctx.origin.chatId,
        chain_depth: ctx.goalDepth + 1, status: "queued", error: null,
        thread_id: parentThread ?? id, in_reply_to: null,
      });
      this.deps.store.parkGoalAwaiting(ctx.goalId!, id);
      // The asking node did its job (it asked) — mark it done inside the same tx so a later
      // run reject can't fail it and a crash-time resetRunningNodes can't re-run it.
      if (ctx.nodeKey) this.deps.store.updateNodeStatus(ctx.goalId!, ctx.nodeKey, "done");
    });
    this.deps.onEvent?.({ type: "mail.sent", id, from: ctx.from, to: canonical, kind: "request" });
    this.deps.onQueued?.();
    return `Question sent to ${canonical}. Your task will pause and resume automatically when they answer.`;
  }

  /** System-prompt block: unread inbound first, then own refusal acks — WITHOUT marking read.
   *  Returns the picked ids so the caller commits via markDelivered() only after the consuming
   *  run actually succeeds; a run that crashes after injection never commits, so the mail
   *  re-surfaces on the next run (durable delivery — no lost notes on crash). */
  peekInbound(canonical: string): { block: string; ids: string[] } {
    if (this.deps.disabled) return { block: "", ids: [] }; // kill-switch: no injection
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
    if (!ids.length) return;
    this.deps.store.markMailRead(ids);
    this.deps.onEvent?.({ type: "mail.read", ids });
  }
}
