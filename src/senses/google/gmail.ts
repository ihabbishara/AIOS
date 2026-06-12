// src/senses/google/gmail.ts
import type { Store } from "../../store/db.js";
import type { EventBus } from "../../events.js";

/** Narrow structural slice of gmail_v1.Gmail — keeps tests free of googleapis. */
export interface GmailLike {
  users: {
    getProfile(p: { userId: string }): Promise<{ data: { historyId?: string | null } }>;
    history: {
      list(p: {
        userId: string;
        startHistoryId: string;
        historyTypes: string[];
      }): Promise<{ data: { history?: Array<{ messagesAdded?: Array<{ message?: { id?: string | null } | null }> | null }> | null; historyId?: string | null } }>;
    };
    messages: {
      get(p: { userId: string; id: string; format: string; metadataHeaders?: string[] }): Promise<{
        data: {
          id?: string | null; threadId?: string | null; labelIds?: string[] | null;
          snippet?: string | null; internalDate?: string | null;
          payload?: { headers?: Array<{ name?: string | null; value?: string | null }> | null } | null;
        };
      }>;
    };
  };
}

export interface GmailWatcherDeps {
  account: string;
  gmail: GmailLike;
  store: Store;
  bus: EventBus;
  /** Lowercase Gmail category names to skip (e.g. "promotions" → CATEGORY_PROMOTIONS). */
  skipCategories: string[];
  log?: (line: string) => void;
}

function header(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/**
 * Incremental Gmail poll via the history API. Bootstrap stamps the current
 * historyId WITHOUT emitting (no backlog flood). historyId is stamped after
 * emitting — a crash in between may duplicate one batch (acceptable).
 */
export class GmailWatcher {
  constructor(private deps: GmailWatcherDeps) {}

  private kvKey(): string {
    return `gmail:${this.deps.account}:historyId`;
  }

  async poll(): Promise<void> {
    const { store } = this.deps;
    const last = store.kvGet(this.kvKey());
    if (!last) {
      await this.bootstrap();
      return;
    }
    let history;
    try {
      history = await this.deps.gmail.users.history.list({
        userId: "me",
        startHistoryId: last,
        historyTypes: ["messageAdded"],
      });
    } catch (err) {
      if ((err as { code?: number }).code === 404) {
        // historyId expired (long downtime) — re-bootstrap; Gmail still has the mail.
        this.deps.log?.(`gmail(${this.deps.account}): historyId expired — re-bootstrapping`);
        await this.bootstrap();
        return;
      }
      throw err;
    }

    const ids = new Set<string>();
    for (const h of history.data.history ?? []) {
      for (const added of h.messagesAdded ?? []) {
        if (added.message?.id) ids.add(added.message.id);
      }
    }

    for (const id of ids) {
      const { data } = await this.deps.gmail.users.messages.get({
        userId: "me", id, format: "metadata", metadataHeaders: ["From", "To", "Subject"],
      });
      const labels = data.labelIds ?? [];
      if (!labels.includes("INBOX")) continue;
      const skip = this.deps.skipCategories.some((c) => labels.includes(`CATEGORY_${c.toUpperCase()}`));
      if (skip) continue;
      const headers = data.payload?.headers ?? [];
      this.deps.bus.emit({
        type: "mail.received",
        account: this.deps.account,
        messageId: data.id ?? id,
        threadId: data.threadId ?? "",
        from: header(headers, "From"),
        to: header(headers, "To"),
        subject: header(headers, "Subject"),
        snippet: data.snippet ?? "",
        labels,
        receivedAt: data.internalDate ? new Date(Number(data.internalDate)).toISOString() : new Date().toISOString(),
      });
    }

    if (history.data.historyId) store.kvSet(this.kvKey(), history.data.historyId);
  }

  private async bootstrap(): Promise<void> {
    const profile = await this.deps.gmail.users.getProfile({ userId: "me" });
    if (profile.data.historyId) {
      this.deps.store.kvSet(this.kvKey(), profile.data.historyId);
      this.deps.log?.(`gmail(${this.deps.account}): bootstrapped at historyId ${profile.data.historyId}`);
    }
  }
}
