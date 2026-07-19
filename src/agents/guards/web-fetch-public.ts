import type { ToolCheck } from "./halalo-readonly.js";

/** Block private/loopback/link-local hosts so a WebFetch can't be an SSRF pivot — notably the
 *  cloud metadata endpoint (169.254.169.254) and the daemon's own API (localhost:4280). Host
 *  LITERALS only; a public name that DNS-resolves to a private IP (rebinding) is a documented
 *  residual. Deliberately duplicated from src/web/skills-view.ts isBlockedHost — the agent-spawn
 *  path must not import the web layer (same layering rule as runner.ts skillsPluginRoot). */
export function isBlockedFetchHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h === "::1" || h === "::") return true;
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 127 || a === 10 ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** WebFetch guard: http(s) only, no private/loopback/link-local hosts. Applied to the fetch-only
 *  `web-fetch` capability (minos citation spot-checks fetch attacker-influenced URLs into the
 *  gate-keeping critic). Non-WebFetch tools are not this guard's concern (fallback allow). */
export function webFetchPublicChecks(): Record<string, ToolCheck> {
  const check: ToolCheck = (input) => {
    const raw = (input as { url?: unknown }).url;
    if (typeof raw !== "string") return { ok: true as const }; // no url arg → not a fetch we gate
    let u: URL;
    try { u = new URL(raw); } catch { return { ok: false as const, reason: "invalid url" }; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false as const, reason: "http(s) only" };
    if (isBlockedFetchHost(u.hostname)) return { ok: false as const, reason: "host not allowed (private/loopback/link-local)" };
    return { ok: true as const };
  };
  return { WebFetch: check };
}
