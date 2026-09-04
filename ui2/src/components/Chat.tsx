// ui2/src/components/Chat.tsx — the conversation surface: markdown bubbles, a real composer
// (Enter sends, Shift+Enter breaks the line), and a live voice orb that breathes with the mic.
import { useEffect, useRef, useState } from "react";
import { api, type StateInfo, type StoredEvent, type WebAttachment } from "../api.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { Markdown } from "../lib/markdown.js";
import { Avatar, Button, Dot } from "./ui.js";

interface Msg { who: "you" | string; text: string; ts?: string; pending?: boolean; pendingId?: string; audio?: string; attachments?: WebAttachment[]; srcEventId?: number }

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

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

/** The voice bubble: idle mic → recording orb that scales with the live mic level and emits
 *  pulse rings → breathing while the round trip transcribes. Red = recording, by convention. */
function VoiceOrb({ recording, level, busy, secs, onClick }: {
  recording: boolean; level: number; busy: boolean; secs: number; onClick: () => void;
}) {
  return (
    <span className="relative inline-flex items-center justify-center shrink-0">
      {recording && <span className="orb-ring" />}
      {recording && <span className="orb-ring" style={{ animationDelay: "0.6s" }} />}
      <button
        onClick={onClick}
        disabled={busy}
        aria-label={recording ? "Stop and send voice message" : "Record a voice message"}
        title={recording ? "Stop and send" : "Record a voice message"}
        className={`relative z-10 w-11 h-11 rounded-full border flex items-center justify-center transition-all ${
          recording
            ? "bg-err text-bg border-err"
            : busy
              ? "border-line text-dim breathe"
              : "border-line text-fg hover:text-strong hover:border-dim bg-surface"
        }`}
        style={recording ? { transform: `scale(${1 + Math.min(level, 1) * 0.35})` } : undefined}
      >
        {busy ? "…" : <MicIcon />}
      </button>
      {recording && (
        <span className="absolute -bottom-4 font-mono text-[9.5px] text-err whitespace-nowrap">
          {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
        </span>
      )}
    </span>
  );
}

export function Chat({ open, state, events, target, setTarget, seed }: {
  /** Drawer visibility. The log mounts once at app boot behind a closed drawer, so
   *  scroll-to-bottom has to key off this — there is no remount on open. */
  open?: boolean;
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
  const [level, setLevel] = useState(0);
  const [secs, setSecs] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Context-aware pre-targeting: an opener can seed the draft ("About approval a1: …").
  useEffect(() => { if (seed) { setInput(seed); inputRef.current?.focus(); } }, [seed]);

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
          return { who: target, text: ev.text, ts: e.ts, srcEventId: e.id, attachments: ev.attachments };
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
  const scroller = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  // Land on the newest message. Instant on open (smooth would animate past the whole
  // backlog); smooth on appends while open, unless the OS asks for reduced motion.
  // Also covers SSE-pushed messages, which previously never scrolled at all.
  useEffect(() => {
    const el = scroller.current;
    const justOpened = open === true && !wasOpen.current;
    wasOpen.current = open === true;
    if (open !== true || !el) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    if (!justOpened && !reduced && typeof el.scrollTo === "function") {
      try { el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); return; } catch { /* jsdom */ }
    }
    el.scrollTop = el.scrollHeight;
  }, [open, log.length]);

  // Recording clock for the orb.
  useEffect(() => {
    if (!recording) { setSecs(0); return; }
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  // The server names the moderator row after the org's OWN coordinator. Prepending a literal
  // "neo" listed an agent that does not exist in most orgs, and left the real coordinator
  // showing again as a specialist beside it (observed 2026-09-04 on an org led by `nova`).
  const coordinator = state?.coordinator
    ?? state?.agents.find((a) => a.kind === "moderator")?.name
    ?? "";
  const targets = [
    ...(coordinator ? [coordinator] : []),
    ...(state?.agents.filter((a) => a.kind !== "moderator" && a.name !== coordinator).map((a) => a.name) ?? []),
  ];

  // Live picker state: violet dot = agent working right now, count = unread mail from it.
  const { data: org } = useLiveQuery(() => api.org(), events, T.agentsActions);
  const { data: unread } = useLiveQuery(() => api.mailUnread(), events, T.agentMail);
  const statusOf = new Map((org ?? []).flatMap((d) => d.agents.map((a) => [a.name, a.status] as const)));

  // Inline routing trail — decisions made for this web cockpit chat.
  const trail = events.filter(
    (e) => e.event.type === "route.decision" && e.event.channel === "web" && e.event.chatId === "ui",
  ).slice(-3);

  const scrollDown = () => setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 50);

  const resetComposer = () => {
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    resetComposer();
    setBusy(true);
    // Unique id so concurrent text/voice round trips resolve only their own placeholder.
    const pid = crypto.randomUUID();
    const now = new Date().toISOString();
    setLog((l) => [...l, { who: "you", text, ts: now }, { who: target, text: "…", pending: true, pendingId: pid }]);
    scrollDown();
    try {
      const { reply, attachments } = await api.chat(target, text);
      setLog((l) => l.map((m) => (m.pendingId === pid ? { who: target, text: reply ?? "(no reply)", ts: new Date().toISOString(), attachments } : m)));
    } catch (err) {
      setLog((l) => l.map((m) => (m.pendingId === pid ? { who: target, text: `error: ${(err as Error).message}` } : m)));
    } finally {
      setBusy(false);
      scrollDown();
    }
  };

  const levelLoop = useRef<number>(0);
  const audioCtx = useRef<AudioContext | null>(null);

  const toggleMic = async () => {
    if (recording) {
      recording.stop();
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Live level drives the orb: RMS of the time-domain signal, ~60fps.
    const ctx = new AudioContext();
    audioCtx.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      setLevel(Math.sqrt(sum / buf.length) * 4); // ×4: speech RMS is small, orb should visibly move
      levelLoop.current = requestAnimationFrame(tick);
    };
    levelLoop.current = requestAnimationFrame(tick);

    const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      cancelAnimationFrame(levelLoop.current);
      void audioCtx.current?.close().catch(() => {});
      audioCtx.current = null;
      setLevel(0);
      setRecording(null);
      setVoiceBusy(true);
      // Show immediate feedback while the round-trip is in flight.
      const pid = crypto.randomUUID();
      setLog((l) => [...l, { who: "you", text: "🎙 transcribing…", pending: true, pendingId: pid }]);
      scrollDown();
      try {
        const { transcript, reply, audio } = await api.voiceChat(target, new Blob(chunks, { type: "audio/webm" }));
        setLog((l) => [
          ...l.map((m) => (m.pendingId === pid ? { who: "you" as const, text: `🎙 ${transcript}`, ts: new Date().toISOString() } : m)),
          { who: target, text: reply, ts: new Date().toISOString(), ...(audio ? { audio } : {}) },
        ]);
        scrollDown();
        // Best-effort autoplay — works when the round trip is fast enough that the click gesture is still live.
        if (audio) new Audio(`data:audio/ogg;base64,${audio}`).play().catch(() => {});
      } catch (e) {
        setLog((l) => l.map((m) => (m.pendingId === pid ? { who: "you" as const, text: `voice error: ${(e as Error).message}` } : m)));
        scrollDown();
      }
      setVoiceBusy(false);
    };
    rec.start();
    setRecording(rec);
  };

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
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
            {(unread?.byAgent?.[t] ?? 0) > 0 && (
              <span className="font-mono text-[9px] text-bg bg-info rounded-full px-1">{unread?.byAgent?.[t]}</span>
            )}
          </button>
        ))}
      </div>

      <div ref={scroller} data-testid="chat-scroller" className="panel flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-3.5">
        {log.length === 0 && (
          <div className="text-dim text-[12px] m-auto text-center flex flex-col gap-1.5 items-center">
            <Avatar name={target} tone="agent" />
            <div>Channel open to <span className="text-strong">{target}</span>{target === coordinator ? ` — describe what you need; ${coordinator} routes it.` : "."}</div>
            <div className="text-[10.5px]">Enter sends · Shift+Enter for a new line{state?.voice ? " · or hold a thought and press the mic" : ""}</div>
          </div>
        )}
        {log.map((m, i) => (
          m.who === "you" ? (
            <div key={i} className="self-end max-w-[80%] flex flex-col items-end">
              <div className={`px-3.5 py-2 text-[13px] whitespace-pre-wrap leading-relaxed border rounded-2xl rounded-br-md bg-raised border-agent/40 text-strong ${m.pending ? "breathe" : ""}`}>
                {m.text}
              </div>
              {m.ts && <span className="font-mono text-[9px] text-dim mt-0.5">{m.ts.slice(11, 16)}</span>}
            </div>
          ) : (
            <div key={i} className="self-start max-w-[88%] flex gap-2.5 min-w-0">
              <Avatar name={m.who} tone="agent" />
              <div className="min-w-0 flex flex-col items-start">
                <div className={`px-3.5 py-2 text-[13px] leading-relaxed border rounded-2xl rounded-tl-md bg-raised border-line text-fg ${m.pending ? "breathe" : ""}`}>
                  <Markdown text={m.text} />
                  {m.attachments?.map((a, j) => <MediaBlock key={j} a={a} />)}
                </div>
                <span className="flex items-center gap-2 mt-0.5">
                  {m.ts && <span className="font-mono text-[9px] text-dim">{m.ts.slice(11, 16)}</span>}
                  {m.audio && (
                    <button
                      onClick={() => new Audio(`data:audio/ogg;base64,${m.audio}`).play().catch(() => {})}
                      title="Replay voice reply"
                      className="border border-line rounded text-dim hover:text-fg text-[10px] px-1.5 leading-relaxed transition-colors"
                    >
                      ▶ replay
                    </button>
                  )}
                </span>
              </div>
            </div>
          )
        ))}
        {trail.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5">
            {trail.map((e) => {
              const v = e.event as unknown as { to: string; via: string; reason: string };
              return (
                <div key={e.id} className="text-[10px] text-dim self-center">
                  ⇢ neo → <span className="text-fg">{v.to}</span> ({v.via}) — {v.reason}
                </div>
              );
            })}
          </div>
        )}
        <div ref={bottom} />
      </div>

      <div className="flex gap-2.5 mt-3 items-end">
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          onChange={(e) => { setInput(e.target.value); grow(e.target); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
          placeholder={`Message ${target}… (Shift+Enter = new line)`}
          className="flex-1 bg-bg border border-line rounded-xl px-3.5 py-2.5 text-fg outline-none focus:border-dim resize-none leading-relaxed min-h-11"
        />
        <Button variant="primary" onClick={send} disabled={busy} className="px-5 h-11">
          {busy ? "…" : "Send"}
        </Button>
        {state?.voice && (
          <VoiceOrb recording={!!recording} level={level} busy={voiceBusy} secs={secs} onClick={() => void toggleMic()} />
        )}
      </div>
    </div>
  );
}
