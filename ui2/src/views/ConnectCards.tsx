// ui2/src/views/ConnectCards.tsx — per-channel connect cards for the wizard's Connect step.
// Each card takes its api slice as a prop so a future cockpit Connect view can mount the same
// cards against authenticated mission-control endpoints — only the slice changes.
import { useEffect, useRef, useState } from "react";
import { api as defaultApi, type CapturedChat, type ConnectStatus } from "../api.js";
import { Button } from "../components/ui.js";

const input = "w-full bg-bg border border-line rounded-md px-3 py-2 text-fg outline-none focus:border-dim";
const hint = "text-[11px] text-dim leading-relaxed";

function Card({ title, connected, detail, children }: {
  title: string; connected: boolean; detail?: string; children: React.ReactNode;
}) {
  return (
    <div className="panel w-full p-5 flex flex-col gap-2.5" data-testid={`connect-card-${title.split(" ")[0].toLowerCase()}`}>
      <div className="flex items-center gap-2">
        <div className="text-strong text-[14px]">{title}</div>
        {connected && <span className="text-[10px] uppercase tracking-wide text-ok ml-auto">connected{detail ? ` · ${detail}` : ""}</span>}
      </div>
      {children}
    </div>
  );
}

export function TelegramCard({ status, onSaved, api = defaultApi }: {
  status: ConnectStatus["telegram"]; onSaved: () => void; api?: typeof defaultApi;
}) {
  const [token, setTokenValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captured, setCaptured] = useState<CapturedChat | null>(null);
  const stop = useRef(false);

  useEffect(() => () => { stop.current = true; }, []);

  const verify = async () => {
    setBusy(true); setError("");
    try { await api.connectTelegram(token); setTokenValue(""); onSaved(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  // Long-poll loop: each round holds ~25s server-side; captured:null just means "ask again".
  const capture = async () => {
    setCapturing(true); setError(""); stop.current = false;
    try {
      while (!stop.current) {
        const r = await api.telegramCapture();
        if (r.captured) { setCaptured(r.captured); break; }
      }
    } catch (err) { setError((err as Error).message); }
    finally { setCapturing(false); }
  };

  const makePrimary = async () => {
    if (!captured) return;
    setBusy(true); setError("");
    try {
      // Private chats also pass the sender id so the confirmer is auto-allowed.
      await api.telegramPrimary(captured.chatId, captured.chatType === "private" ? captured.fromId : undefined);
      setCaptured(null); onSaved();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Telegram" connected={status.connected} detail={status.botUsername ? `@${status.botUsername}` : undefined}>
      {!status.connected && (
        <>
          <p className={hint}>Message @BotFather → /newbot → paste the token. AIOS talks to you where you already are.</p>
          <div className="flex gap-2">
            <input type="password" value={token} onChange={(e) => setTokenValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && token.trim() && void verify()}
              placeholder="123456:ABC…" className={input} />
            <Button variant="primary" disabled={busy || !token.trim()} onClick={() => void verify()}>
              {busy ? "Verifying…" : "Verify"}
            </Button>
          </div>
        </>
      )}
      {status.connected && !status.primaryChat && !captured && (
        <>
          <p className={hint}>
            Now open Telegram and send <span className="text-strong">@{status.botUsername}</span> any message —
            AIOS captures your chat automatically and makes it the place for briefs and questions.
          </p>
          <div className="flex gap-2">
            <Button variant="primary" disabled={capturing} onClick={() => void capture()}>
              {capturing ? "Waiting for your message…" : "I sent it — listen"}
            </Button>
            {capturing && <Button onClick={() => { stop.current = true; setCapturing(false); }}>Cancel</Button>}
          </div>
        </>
      )}
      {captured && (
        <>
          <p className="leading-relaxed text-[13px]">
            Got it — chat <span className="text-strong font-mono">{captured.chatId}</span> (from {captured.from}).
            Make this your primary chat?
          </p>
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void makePrimary()}>Yes, use this chat</Button>
            <Button disabled={busy} onClick={() => setCaptured(null)}>No</Button>
          </div>
        </>
      )}
      {status.connected && status.primaryChat && (
        <p className={hint}>Primary chat: <span className="font-mono text-fg">{status.primaryChat}</span></p>
      )}
      <p className={hint}>
        Adding the bot to a group? Send /setprivacy to @BotFather and choose Disable, or the bot cannot see group messages.
      </p>
      {error && <div className="text-[12px] text-err">{error}</div>}
    </Card>
  );
}

export function SlackCard({ status, onSaved, api = defaultApi }: {
  status: ConnectStatus["slack"]; onSaved: () => void; api?: typeof defaultApi;
}) {
  const [bot, setBot] = useState("");
  const [app, setApp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError("");
    try { await api.connectSlack(bot, app); setBot(""); setApp(""); onSaved(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Card title="Slack" connected={status.connected} detail={status.team}>
      {!status.connected ? (
        <>
          <p className={hint}>
            Socket Mode — no public URL needed. api.slack.com → create app → enable Socket Mode:
            app-level token with connections:write (xapp-…), bot token with chat:write, files:write,
            users:read (xoxb-…). Both are required — AIOS skips Slack when only one is set.
          </p>
          <input type="password" value={bot} onChange={(e) => setBot(e.target.value)} placeholder="xoxb-…" className={input} />
          <input type="password" value={app} onChange={(e) => setApp(e.target.value)} placeholder="xapp-…" className={input} />
          <Button variant="primary" className="self-start" disabled={busy || !bot.trim() || !app.trim()} onClick={() => void save()}>
            {busy ? "Verifying…" : "Verify & save"}
          </Button>
        </>
      ) : (
        <p className={hint}>Workspace: <span className="text-fg">{status.team}</span> as {status.botUser}</p>
      )}
      {error && <div className="text-[12px] text-err">{error}</div>}
    </Card>
  );
}

export function ImageCard({ status, onSaved, api = defaultApi }: {
  status: ConnectStatus["image"]; onSaved: () => void; api?: typeof defaultApi;
}) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError("");
    try { await api.connectImage(key, model.trim() || undefined); setKey(""); onSaved(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Card title="Image generation — Nano Banana" connected={status.connected} detail={status.connected ? status.model : undefined}>
      {!status.connected ? (
        <>
          <p className={hint}>
            Gives your agents generate_image via Gemini (~$0.04 per image). aistudio.google.com → API keys.
            The check here is free — no image is generated.
          </p>
          <div className="flex gap-2">
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && key.trim() && void save()}
              placeholder="AIza…" className={input} />
            <Button variant="primary" disabled={busy || !key.trim()} onClick={() => void save()}>
              {busy ? "Checking…" : "Verify"}
            </Button>
          </div>
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={status.model} className={input} />
        </>
      ) : (
        <p className={hint}>Agents with the media-gen capability can now generate images.</p>
      )}
      {error && <div className="text-[12px] text-err">{error}</div>}
    </Card>
  );
}
