// src/onboarding/connect.ts — channel verification + Telegram chat-id capture for the wizard's
// Connect step. Pure functions over an injectable fetch (the SetupDeps.ping precedent): tests
// never touch the network, the server never re-implements a channel API.
//
// Everything returned here is written into .env as `KEY=value`, so every input passes the same
// single-line rule the Claude token does (auth.ts): a line break is an env-injection vector.

const VERIFY_TIMEOUT_MS = 10_000;
/** getUpdates long-poll: Telegram holds ≤25s; our abort sits just above it. */
const CAPTURE_TIMEOUT_MS = 28_000;

export type FetchFn = typeof fetch;

export function singleLine(v: string): boolean {
  return v.length > 0 && !/[\r\n]/.test(v);
}

/** "123, 456" → "123,456"; null when any entry is non-numeric. */
export function parseAllowedUserIds(s: string): string | null {
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  return parts.every((p) => /^\d+$/.test(p)) ? parts.join(",") : null;
}

function timed(ms: number): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(t) };
}

export type TelegramVerify = { ok: true; botUsername: string } | { ok: false; error: string };

export async function verifyTelegram(token: string, f: FetchFn = fetch): Promise<TelegramVerify> {
  const { signal, done } = timed(VERIFY_TIMEOUT_MS);
  try {
    const res = await f(`https://api.telegram.org/bot${token}/getMe`, { signal });
    const body = (await res.json()) as { ok?: boolean; result?: { username?: string }; description?: string };
    if (!body.ok) return { ok: false, error: `Telegram rejected the token: ${body.description ?? `HTTP ${res.status}`}` };
    return { ok: true, botUsername: body.result?.username ?? "" };
  } catch (err) {
    return { ok: false, error: `could not reach Telegram: ${(err as Error).message}` };
  } finally {
    done();
  }
}

export interface CapturedChat {
  chatId: string; chatType: string; from: string; fromId: string; text: string;
}
export type TelegramCapture =
  | { ok: true; offset: number; captured: CapturedChat | null }
  | { ok: false; conflict?: true; error: string };

/** One long-poll round of getUpdates. `captured: null` means the poll timed out quietly —
 *  the UI simply asks again. A Telegram 409 means another consumer (a running bot) owns
 *  getUpdates for this token; surfaced distinctly so the card can say what to stop. */
export async function captureTelegramChat(token: string, offset: number, f: FetchFn = fetch): Promise<TelegramCapture> {
  const { signal, done } = timed(CAPTURE_TIMEOUT_MS);
  try {
    const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`;
    const res = await f(url, { signal });
    if (res.status === 409) {
      return { ok: false, conflict: true, error: "another process is polling this bot — stop the other AIOS/bot instance and try again" };
    }
    const body = (await res.json()) as {
      ok?: boolean; description?: string;
      result?: Array<{ update_id: number; message?: { chat?: { id: number; type: string }; from?: { id: number; first_name?: string; username?: string }; text?: string } }>;
    };
    if (!body.ok) return { ok: false, error: `Telegram error: ${body.description ?? `HTTP ${res.status}`}` };
    const updates = body.result ?? [];
    const next = updates.length ? updates[updates.length - 1].update_id + 1 : offset;
    const hit = [...updates].reverse().find((u) => u.message?.chat);
    if (!hit?.message?.chat) return { ok: true, offset: next, captured: null };
    const m = hit.message;
    return {
      ok: true, offset: next,
      captured: {
        chatId: String(m.chat!.id), chatType: m.chat!.type,
        from: m.from?.username ?? m.from?.first_name ?? "someone",
        fromId: m.from ? String(m.from.id) : "",
        text: m.text ?? "",
      },
    };
  } catch (err) {
    return { ok: false, error: `could not reach Telegram: ${(err as Error).message}` };
  } finally {
    done();
  }
}

export type SlackVerify = { ok: true; team: string; botUser: string } | { ok: false; error: string };

/** auth.test proves the xoxb token; apps.connections.open proves the xapp token actually has
 *  connections:write — which is precisely what Socket Mode needs. Both or nothing, mirroring
 *  boot.ts, which silently skips Slack when only one token is set. */
export async function verifySlack(botToken: string, appToken: string, f: FetchFn = fetch): Promise<SlackVerify> {
  const { signal, done } = timed(VERIFY_TIMEOUT_MS);
  try {
    const auth = await f("https://slack.com/api/auth.test", {
      method: "POST", headers: { Authorization: `Bearer ${botToken}` }, signal,
    });
    const a = (await auth.json()) as { ok?: boolean; error?: string; team?: string; user?: string };
    if (!a.ok) return { ok: false, error: `Slack rejected the bot token: ${a.error ?? "auth.test failed"}` };
    const conn = await f("https://slack.com/api/apps.connections.open", {
      method: "POST", headers: { Authorization: `Bearer ${appToken}` }, signal,
    });
    const c = (await conn.json()) as { ok?: boolean; error?: string };
    if (!c.ok) {
      return { ok: false, error: `Slack rejected the app token: ${c.error ?? "apps.connections.open failed"} — it needs the connections:write scope` };
    }
    return { ok: true, team: a.team ?? "", botUser: a.user ?? "" };
  } catch (err) {
    return { ok: false, error: `could not reach Slack: ${(err as Error).message}` };
  } finally {
    done();
  }
}

export type GeminiVerify = { ok: true } | { ok: false; error: string };

/** Free models GET — proves the key and the model name without burning a ~$0.04 generate.
 *  A key that can list models but lacks generate quota surfaces on first real use, where
 *  media/image.ts already returns a clear error; the card copy says so. */
export async function verifyGemini(apiKey: string, model: string, f: FetchFn = fetch): Promise<GeminiVerify> {
  if (!/^[A-Za-z0-9._-]+$/.test(model)) return { ok: false, error: "model name has invalid characters" };
  const { signal, done } = timed(VERIFY_TIMEOUT_MS);
  try {
    const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${model}`, {
      headers: { "x-goog-api-key": apiKey }, signal,
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return { ok: false, error: `Gemini rejected the key or model: ${body.error?.message ?? `HTTP ${res.status}`}` };
  } catch (err) {
    return { ok: false, error: `could not reach Gemini: ${(err as Error).message}` };
  } finally {
    done();
  }
}
