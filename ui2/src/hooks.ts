import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { getToken, UnauthorizedError, type StoredEvent } from "./api.js";
import { lastMatching } from "./lib/topics.js";

/** Live event stream via SSE, capped buffer, auto-reconnect. */
export function useEvents(cap = 400): { events: StoredEvent[]; connected: boolean } {
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const seen = useRef(new Set<number>());

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let stopped = false;
    const connect = async () => {
      // Exchange the bearer token (sent as a header) for a short-lived one-time ticket, so the
      // long-lived token never lands in the stream URL / logs / history. Re-fetched each connect,
      // so auto-reconnect gets a fresh ticket.
      let ticket = "";
      try {
        const r = await fetch("/api/stream-ticket", getToken() ? { headers: { Authorization: `Bearer ${getToken()}` } } : undefined);
        if (r.ok) ticket = ((await r.json()) as { ticket: string }).ticket;
      } catch { /* fall through — EventSource will error and schedule a retry */ }
      if (stopped) return;
      es = new EventSource(`/api/stream?ticket=${encodeURIComponent(ticket)}`);
      es.onopen = () => setConnected(true);
      es.onmessage = (m) => {
        const e = JSON.parse(m.data) as StoredEvent;
        if (seen.current.has(e.id)) return;
        seen.current.add(e.id);
        // Bound the dedup set (insertion-ordered): drop the oldest ids well past the buffer window
        // and the 100-event reconnect replay, so it can't grow unbounded over a long session.
        if (seen.current.size > 4000) {
          const it = seen.current.values();
          for (let i = 0; i < 2000; i++) seen.current.delete(it.next().value as number);
        }
        setEvents((prev) => [...prev.slice(-cap + 1), e]);
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = setTimeout(() => void connect(), 3000);
      };
    };
    void connect();
    return () => { stopped = true; es?.close(); clearTimeout(retry); };
  }, [cap]);

  return { events, connected };
}

/** Fetch once + manual reload; re-fetches when deps change. (Renamed from the misnamed usePoll.) */
export function useFetch<T>(fn: () => Promise<T>, deps: unknown[] = []): {
  data: T | undefined;
  error: string | undefined;
  unauthorized: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [unauthorized, setUnauthorized] = useState(false);
  const reload = useCallback(() => {
    fn()
      .then((d) => { setData(d); setError(undefined); setUnauthorized(false); })
      // Gate on the error TYPE, not its message — a renamed string can't silently break the gate.
      .catch((e) => { setError((e as Error).message); setUnauthorized(e instanceof UnauthorizedError); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, unauthorized, reload };
}

/** useFetch keyed on the newest event matching `topics` — SSE events invalidate REST reads. */
export function useLiveQuery<T>(
  fn: () => Promise<T>,
  events: StoredEvent[],
  topics: readonly string[],
  extraDeps: unknown[] = [],
): ReturnType<typeof useFetch<T>> {
  const lastEvt = useMemo(() => lastMatching(events, topics), [events, topics]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useFetch(fn, [lastEvt, ...extraDeps]);
}
