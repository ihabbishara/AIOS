import { roles } from "./roles/index.js";
import { resumableTurn } from "./resumable.js";
import { roleQueryOptions, roleSystemPrompt, packRunOptions } from "./runner.js";
import type { Store } from "../store/db.js";

const DIRECT_ADDENDUM =
  "\n\nYou are currently in a DIRECT CHAT with the user (via Telegram/Slack/terminal), " +
  "outside any pipeline job. Reply conversationally and phone-readable: outcome first, " +
  "short paragraphs. You keep memory of this conversation across messages. " +
  "Structured-output rules from pipeline runs do not apply here — just talk. " +
  "Never use markdown tables — unreadable on phones; use short lines or bullets.";

export interface DirectChatsDeps {
  store: Store;
  projectsRoot: string;
  model?: string;
  log?: (line: string) => void;
  /** Resolve a pack for a direct-addressed role (undefined = role has no/ambiguous pack). */
  resolvePackFor?: (role: string, origin: { channel: string; chatId: string }) => import("../packs/resolve.js").ResolvedPack | undefined;
}

/** Persistent one-on-one chats with individual specialists (the `@role ...` syntax). */
export class DirectChats {
  private locks = new Map<string, Promise<void>>();

  constructor(private deps: DirectChatsDeps) {}

  static roleNames(): string[] {
    return Object.keys(roles);
  }

  async handle(role: string, channel: string, chatId: string, userText: string): Promise<string> {
    const def = roles[role];
    if (!def) throw new Error(`Unknown specialist: ${role}`);

    const key = `direct-session:${role}:${channel}:${chatId}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    this.locks.set(key, new Promise((r) => (release = r)));
    await prev;
    try {
      const pack = this.deps.resolvePackFor?.(role, { channel, chatId });
      const base = {
        ...roleQueryOptions(def, { cwd: this.deps.projectsRoot, model: this.deps.model }),
        systemPrompt: roleSystemPrompt(def) + DIRECT_ADDENDUM,
      };
      const options = pack ? packRunOptions(base, pack) : base;
      return await resumableTurn({
        store: this.deps.store,
        sessionKey: key,
        prompt: userText,
        log: this.deps.log,
        options,
      });
    } finally {
      release();
    }
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
 */
export function parseDirectAddress(text: string): { role: string; text: string } | undefined {
  return parseAgentAddress(text, Object.keys(roles));
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
