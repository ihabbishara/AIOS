import { useEffect, useRef, useState } from "react";
import { api, type StateInfo } from "../api.js";

interface Msg { who: "you" | string; text: string; pending?: boolean }

const LOG_KEY = "aios_chat_log";

function loadLog(): Msg[] {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]") as Msg[];
  } catch {
    return [];
  }
}

export function Chat({ state }: { state: StateInfo | undefined }) {
  const [target, setTarget] = useState("moderator");
  const [input, setInput] = useState("");
  const [log, setLog] = useState<Msg[]>(loadLog);
  const [recording, setRecording] = useState<MediaRecorder | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);

  // Persist across reloads (drop in-flight placeholders, cap at 200 entries).
  useEffect(() => {
    localStorage.setItem(LOG_KEY, JSON.stringify(log.filter((m) => !m.pending).slice(-200)));
  }, [log]);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const targets = ["moderator", ...(state?.agents.filter((a) => a.kind !== "moderator").map((a) => a.name) ?? [])];

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setLog((l) => [...l, { who: "you", text }, { who: target, text: "…", pending: true }]);
    setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 50);
    try {
      const { reply } = await api.chat(target, text);
      setLog((l) => l.map((m) => (m.pending ? { who: target, text: reply ?? "(no reply)" } : m)));
    } catch (err) {
      setLog((l) => l.map((m) => (m.pending ? { who: target, text: `error: ${(err as Error).message}` } : m)));
    } finally {
      setBusy(false);
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  };

  const appendMessage = (who: "you" | string, text: string) => {
    setLog((l) => [...l, { who, text }]);
    setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 50);
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
      try {
        const { transcript, reply, audio } = await api.voiceChat(target, new Blob(chunks, { type: "audio/webm" }));
        appendMessage("you", `🎙 ${transcript}`);
        appendMessage(target, reply);
        if (audio) new Audio(`data:audio/ogg;base64,${audio}`).play().catch(() => {});
      } catch (e) {
        appendMessage("system", `voice error: ${(e as Error).message}`);
      }
      setVoiceBusy(false);
    };
    rec.start();
    setRecording(rec);
  };

  return (
    <div className="flex flex-col h-full min-h-0 max-w-4xl">
      <div className="flex gap-1 mb-4 flex-wrap">
        {targets.map((t) => (
          <button
            key={t}
            onClick={() => setTarget(t)}
            className={`px-3 py-1.5 text-[11px] font-display uppercase tracking-wider border transition-colors ${
              target === t ? "border-phosphor text-phosphor glow-green" : "border-line text-dim hover:text-fg"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="hud flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-3">
        {log.length === 0 && (
          <div className="text-dim text-[12px]">
            channel open to <span className="text-phosphor">{target}</span>
            <span className="cursor-blink" />
          </div>
        )}
        {log.map((m, i) => (
          <div key={i} className={m.who === "you" ? "self-end max-w-[80%]" : "self-start max-w-[85%]"}>
            <div className={`label mb-1 ${m.who === "you" ? "text-right text-cyan" : "text-phosphor"}`}>{m.who}</div>
            <div
              className={`px-3 py-2 text-[13px] whitespace-pre-wrap leading-relaxed border ${
                m.who === "you" ? "border-cyan/40 bg-panel-2 text-bright" : "border-line bg-panel-2 text-fg"
              } ${m.pending ? "live-dot" : ""}`}
            >
              {m.text}
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <div className="flex gap-2 mt-4">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={`message ${target}…`}
          className="flex-1 bg-panel border border-line px-3 py-2.5 text-fg outline-none focus:border-phosphor"
        />
        <button
          onClick={send}
          disabled={busy}
          className="px-5 border border-phosphor text-phosphor font-display uppercase tracking-[0.2em] text-[11px] hover:bg-phosphor hover:text-void transition-colors disabled:opacity-40"
        >
          {busy ? "…" : "Send"}
        </button>
        {state?.voice && (
          <button
            onClick={toggleMic}
            disabled={voiceBusy}
            title={recording ? "Stop and send" : "Record voice message"}
            className={`border px-3 py-2 text-[11px] font-display uppercase tracking-widest transition-colors ${
              recording
                ? "border-alert text-alert animate-pulse"
                : "border-line text-dim hover:text-phosphor hover:border-phosphor"
            }`}
          >
            {voiceBusy ? "…" : recording ? "● rec" : "🎙"}
          </button>
        )}
      </div>
    </div>
  );
}
