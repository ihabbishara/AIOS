// src/senses/google/calendar.ts
import type { Store } from "../../store/db.js";
import type { EventBus } from "../../events.js";

/** Narrow structural slice of calendar_v3.Calendar. */
export interface CalendarLike {
  events: {
    list(p: {
      calendarId: string;
      timeMin: string;
      timeMax: string;
      singleEvents: boolean;
      orderBy: string;
      maxResults: number;
    }): Promise<{ data: { items?: CalendarEventItem[] | null } }>;
  };
}

export interface CalendarEventItem {
  id?: string | null;
  summary?: string | null;
  status?: string | null;
  updated?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
  organizer?: { email?: string | null } | null;
  hangoutLink?: string | null;
}

export interface CalendarWatcherDeps {
  account: string;
  calendar: CalendarLike;
  store: Store;
  bus: EventBus;
  pingMinutes: number;
  log?: (line: string) => void;
  nowFn?: () => Date;
}

const WINDOW_DAYS = 7;

interface SnapshotEntry {
  updated: string;
  summary: string;
  start: string;
  end: string;
  status: string;
  organizer: string;
  link: string | null;
}

function startIso(e: CalendarEventItem): string {
  return e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00.000Z` : "");
}

function endIso(e: CalendarEventItem): string {
  return e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00.000Z` : "");
}

/**
 * Windowed snapshot diff (now → +7d): emits calendar.changed for new, moved,
 * or disappeared (cancelled) events. The kv snapshot doubles as the brief
 * assembler's meetings source. Also scans for meeting-soon pings each poll.
 */
export class CalendarWatcher {
  constructor(private deps: CalendarWatcherDeps) {}

  private snapKey(): string {
    return `gcal:${this.deps.account}:snapshot`;
  }

  async poll(): Promise<void> {
    const now = (this.deps.nowFn ?? (() => new Date()))();
    const { data } = await this.deps.calendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
    });

    const current = new Map<string, SnapshotEntry>();
    for (const item of data.items ?? []) {
      if (!item.id || item.status === "cancelled") continue;
      current.set(item.id, {
        updated: item.updated ?? "",
        summary: item.summary ?? "(no title)",
        start: startIso(item),
        end: endIso(item),
        status: item.status ?? "confirmed",
        organizer: item.organizer?.email ?? "",
        link: item.hangoutLink ?? null,
      });
    }

    const prevRaw = this.deps.store.kvGet(this.snapKey());
    if (prevRaw) {
      const prev = new Map(Object.entries(JSON.parse(prevRaw) as Record<string, SnapshotEntry>));
      for (const [id, entry] of current) {
        const old = prev.get(id);
        if (!old || old.updated !== entry.updated) {
          this.emitChanged(id, entry, entry.status);
        }
      }
      for (const [id, old] of prev) {
        if (!current.has(id) && Date.parse(old.start) > now.getTime()) {
          this.emitChanged(id, old, "cancelled");
        }
      }
    } else {
      this.deps.log?.(`gcal(${this.deps.account}): bootstrapped ${current.size} event(s)`);
    }
    this.deps.store.kvSet(this.snapKey(), JSON.stringify(Object.fromEntries(current)));

    // Meeting-soon pings (once per event, kv-guarded).
    for (const [id, entry] of current) {
      const startMs = Date.parse(entry.start);
      const minutesUntil = Math.round((startMs - now.getTime()) / 60_000);
      if (minutesUntil < 0 || minutesUntil > this.deps.pingMinutes) continue;
      const pingKey = `gcal:pinged:${id}`;
      if (this.deps.store.kvGet(pingKey)) continue;
      this.deps.store.kvSet(pingKey, now.toISOString());
      this.deps.bus.emit({
        type: "calendar.reminder",
        account: this.deps.account,
        eventId: id,
        summary: entry.summary,
        start: entry.start,
        minutesUntil,
        link: entry.link,
      });
    }
  }

  private emitChanged(id: string, entry: SnapshotEntry, status: string): void {
    this.deps.bus.emit({
      type: "calendar.changed",
      account: this.deps.account,
      eventId: id,
      summary: entry.summary,
      start: entry.start,
      end: entry.end,
      status,
      organizer: entry.organizer,
    });
  }
}
