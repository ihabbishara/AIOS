// ui2/src/components/Chat.tsx — port of ui/src/views/Chat.tsx in Ember dress + context-aware seed.
import { useEffect, useRef, useState } from "react";
import { api, type StateInfo, type StoredEvent, type WebAttachment } from "../api.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { Button, Dot } from "./ui.js";

interface Msg { who: "you" | string; text: string; pending?: boolean; pendingId?: string; audio?: string; attachments?: WebAttachment[]; srcEventId?: number }

function MediaBlock({ a }: { a: WebAttachment }) {
  const src = `/api/attachment/${encodeURIComponent(a.token)}`;
  const el =
    a.kind === "voice" || a.mime.startsWith("audio/") ? (
      <button
        onClick={() => new Audio(src).play().catch(() => {})}
        className="border border-line rounded text-dim hover:text-fg text-[11px] px-2 py-1 leading-none transition-colors"
      >
        ▶ {a.name}
      </button>
    ) : a.mime.startsWith("image/") ? (
      <img src={src} alt={a.caption ?? a.name} className="rounded-lg border border-line max-w-full max-h-[420px]" />
    ) : (
      <a href={src} download={a.name} className="text-accent underline text-[12px]">
        ⬇ {a.name}
      </a>
    );
  return (
    <div className="mt-2 flex flex-col gap-1">
      {el}
      {a.caption && <div className="text-dim text-[11px]">{a.caption}</div>}
    </div>
  );
}

const LOG_KEY = "aios_chat_log";

function loadLog(): Msg[] {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]") as Msg[];
  } catch {
    return [];
  }
}

export function Chat({ state, events, target, setTarget, seed }: {
  state: StateInfo | undefined;
  events: StoredEvent[];
  target: string;
  setTarget: (t: string) => void;
  seed?: string;
}) {
  const [input, setInput] = useState("");
  const [log, setLog] = useState<Msg[]>(loadLog);
  const [recording, setRecording] = useState<MediaRecorder | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);

  // Context-aware pre-targeting: an opener can seed the draft ("About approval a1: …").
  useEffect(() => { if (seed) setInput(seed); }, [seed]);

  // Server-pushed cockpit messages (goal completions, planner previews) arrive over SSE as
  // chat.out events flagged pushed:true. Interactive replies ALSO emit chat.out (router echo, for
  // the activity log/triage) but unflagged — folding those would double the HTTP reply, so gate on pushed.
  useEffect(() => {
    const pushes = events.filter((e) => {
      const ev = e.event as unknown as { type: string; channel?: string; chatId?: string; pushed?: boolean };
      return ev.type === "chat.out" && ev.pushed === true && ev.channel === "web" && ev.chatId === "ui";
    });
    if (!pushes.length) return;
    setLog((prev) => {
      const seen = new Set(prev.map((m) => m.srcEventId).filter((x): x is number => x != null));
      const add: Msg[] = pushes
        .filter((e) => !seen.has(e.id))
        .map((e) => {
          const ev = e.event as unknown as { text: string; attachments?: WebAttachment[] };
          return { who: target, text: ev.text, srcEventId: e.id, attachments: ev.attachments };
        });
      return add.length ? [...prev, ...add] : prev;
    });
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist across reloads (drop in-flight placeholders, cap at 200 entries; strip audio blobs to keep storage small).
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    localStorage.setItem(LOG_KEY, JSON.stringify(log.filter((m) => !m.pending).slice(-200).map(({ audio, attachments, ...m }) => m)));
  }, [log]);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const targets = ["hermes", ...(state?.agents.filter((a) => a.kind !== "moderator").map((a) => a.name) ?? [])];

  // Live picker state: violet dot = agent working right now, count = unread mail from it.
  const { data: org } = useLiveQuery(() => api.org(), events, T.agentsActions);
  const { data: unread } = useLiveQuery(() => api.mailUnread(), events, T.agentMail);
  const statusOf = new Map((org ?? []).flatMap((d) => d.agents.map((a) => [a.name, a.status] as const)));

  // Inline routing trail — decisions made for this web cockpit chat.
  const trail = events.filter(
    (e) => e.event.type === "route.decision" && e.event.channel === "web" && e.event.chatId === "ui",
  ).slice(-3);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    // Unique id so concurrent text/voice round trips resolve only their own placeholder.
    const pid = crypto.randomUUID();
    setLog((l) => [...l, { who: "you", text }, { who: target, text: "…", pending: true, pendingId: pid }]);
    setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 50);
    try {
      const { reply, attachments } = await api.chat(target, text);
      setLog((l) => l.map((m) => (m.pendingId === pid ? { who: target, text: reply ?? "(no reply)", attachments } : m)));
    } catch (err) {
      setLog((l) => l.map((m) => (m.pendingId === pid ? { who: target, text: `error: ${(err as Error).message}` } : m)));
    } finally {
      setBusy(false);
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  };

  const toggleMic = async () => {
    if (recording) {
      recording.stop();
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setRecording(null);
      setVoiceBusy(true);
      // Show immediate feedback while the round-trip is in flight.
      const pid = crypto.randomUUID();
      setLog((l) => [...l, { who: "you", text: "🎙 transcribing…", pending: true, pendingId: pid }]);
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 50);
      try {
        const { transcript, reply, audio } = await api.voiceChat(target, new Blob(chunks, { type: "audio/webm" }));
        setLog((l) => [
          ...l.map((m) => (m.pendingId === pid ? { who: "you" as const, text: `🎙 ${transcript}` } : m)),
          { who: target, text: reply, ...(audio ? { audio } : {}) },
        ]);
        setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 50);
        // Best-effort autoplay — works when the round trip is fast enough that the click gesture is still live.
        if (audio) new Audio(`data:audio/ogg;base64,${audio}`).play().catch(() => {});
      } catch (e) {
        setLog((l) => l.map((m) => (m.pendingId === pid ? { who: "you" as const, text: `voice error: ${(e as Error).message}` } : m)));
        setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 50);
      }
      setVoiceBusy(false);
    };
    rec.start();
    setRecording(rec);
  };

  return (
    <div className="flex flex-col h-full min-h-0 max-w-4xl w-full mx-auto">
      <div className="flex gap-1 mb-3 flex-wrap">
        {targets.map((t) => (
          <button
            key={t}
            onClick={() => setTarget(t)}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] border rounded-md transition-colors ${
              target === t ? "border-accent text-accent" : "border-line text-dim hover:text-fg"
            }`}
          >
            {statusOf.get(t) === "working" && <Dot tone="agent" breathing />}
            {t}
            {(unread?.byAgent[t] ?? 0) > 0 && (
              <span className="font-mono text-[9px] text-bg bg-info rounded-full px-1">{unread!.byAgent[t]}</span>
            )}
          </button>
        ))}
      </div>

      <div className="panel flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-3">
        {log.length === 0 && (
          <div className="text-dim text-[12px]">
            Channel open to <span className="text-strong">{target}</span>.
          </div>
        )}
        {log.map((m, i) => (
          <div key={i} className={m.who === "you" ? "self-end max-w-[80%]" : "self-start max-w-[85%]"}>
            <div className={`label mb-1 flex items-center gap-2 ${m.who === "you" ? "justify-end text-agent" : "text-ok"}`}>
              {m.who}
              {m.audio && (
                <button
                  onClick={() => new Audio(`data:audio/ogg;base64,${m.audio}`).play().catch(() => {})}
                  title="Replay audio"
                  className="border border-line rounded text-dim hover:text-fg text-[10px] px-1 leading-none transition-colors"
                >
                  ▶
                </button>
              )}
            </div>
            <div
              className={`px-3 py-2 text-[13px] whitespace-pre-wrap leading-relaxed border rounded-lg bg-raised ${
                m.who === "you" ? "border-agent/40 text-strong" : "border-line text-fg"
              } ${m.pending ? "breathe" : ""}`}
            >
              {m.text}
              {m.attachments?.map((a, j) => <MediaBlock key={j} a={a} />)}
            </div>
          </div>
        ))}
        {trail.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5">
            {trail.map((e) => {
              const v = e.event as unknown as { to: string; via: string; reason: string };
              return (
                <div key={e.id} className="text-[10px] text-dim self-center">
                  ⇢ hermes → <span className="text-fg">{v.to}</span> ({v.via}) — {v.reason}
                </div>
              );
            })}
          </div>
        )}
        <div ref={bottom} />
      </div>

      <div className="flex gap-2 mt-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={`Message ${target}…`}
          className="flex-1 bg-bg border border-line rounded-md px-3 py-2 text-fg outline-none focus:border-dim"
        />
        <Button variant="primary" onClick={send} disabled={busy} className="px-5">
          {busy ? "…" : "Send"}
        </Button>
        {state?.voice && (
          <Button
            onClick={toggleMic}
            disabled={voiceBusy}
            variant={recording ? "danger" : "ghost"}
            title={recording ? "Stop and send" : "Record voice message"}
            className={recording ? "breathe" : ""}
          >
            {voiceBusy ? "…" : recording ? "● rec" : "🎙"}
          </Button>
        )}
      </div>
    </div>
  );
}
