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
        pageToken?: string;
      }): Promise<{ data: { history?: Array<{ messagesAdded?: Array<{ message?: { id?: string | null } | null }> | null }> | null; historyId?: string | null; nextPageToken?: string | null } }>;
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

/** Safety cap on history pagination per poll (~1000 messages at Gmail's 100/page default). */
const MAX_HISTORY_PAGES = 10;

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
    // history.list paginates (100/page default) and every page reports the
    // CURRENT mailbox historyId — stamping after one page would silently drop
    // everything beyond it. Walk all pages (capped) before emitting/stamping.
    const ids = new Set<string>();
    let latestHistoryId: string | undefined;
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      let history;
      try {
        history = await this.deps.gmail.users.history.list({
          userId: "me",
          startHistoryId: last,
          historyTypes: ["messageAdded"],
          ...(pageToken ? { pageToken } : {}),
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

      for (const h of history.data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          if (added.message?.id) ids.add(added.message.id);
        }
      }
      if (history.data.historyId) latestHistoryId = history.data.historyId;
      pageToken = history.data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }
    if (pageToken) {
      this.deps.log?.(`gmail(${this.deps.account}): history pagination capped at ${MAX_HISTORY_PAGES} pages — stamping anyway, check Gmail for anything older`);
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

    if (latestHistoryId) store.kvSet(this.kvKey(), latestHistoryId);
  }

  private async bootstrap(): Promise<void> {
    const profile = await this.deps.gmail.users.getProfile({ userId: "me" });
    if (profile.data.historyId) {
      this.deps.store.kvSet(this.kvKey(), profile.data.historyId);
      this.deps.log?.(`gmail(${this.deps.account}): bootstrapped at historyId ${profile.data.historyId}`);
    }
  }
}
