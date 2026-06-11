import { useEffect, useRef, useState, useCallback } from "react";
import { getToken, type StoredEvent } from "./api.js";

/** Live event stream via SSE, capped buffer, auto-reconnect. */
export function useEvents(cap = 400): { events: StoredEvent[]; connected: boolean } {
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const seen = useRef(new Set<number>());

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const tokenParam = getToken() ? `?token=${encodeURIComponent(getToken())}` : "";
      es = new EventSource(`/api/stream${tokenParam}`);
      es.onopen = () => setConnected(true);
      es.onmessage = (m) => {
        const e = JSON.parse(m.data) as StoredEvent;
        if (seen.current.has(e.id)) return;
        seen.current.add(e.id);
        setEvents((prev) => [...prev.slice(-cap + 1), e]);
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => { es?.close(); clearTimeout(retry); };
  }, [cap]);

  return { events, connected };
}

/** Fetch with manual refresh + optional auto-refresh on event types. */
export function usePoll<T>(fn: () => Promise<T>, deps: unknown[] = []): {
  data: T | undefined;
  error: string | undefined;
  reload: () => void;
} {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    fn().then((d) => { setData(d); setError(undefined); }).catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, reload };
}
