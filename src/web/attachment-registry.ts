import { basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { isSafe } from "../agents/attachment-server.js";

export interface AttachmentDescriptor {
  token: string;
  name: string;
  mime: string;
  caption?: string;
  kind?: "voice";
}

export interface AttachmentRegistry {
  register(path: string, meta?: { caption?: string; kind?: "voice" }): AttachmentDescriptor;
  get(token: string): { path: string; mime: string; name: string } | undefined;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
};

export function mimeFor(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
}

interface Entry { path: string; mime: string; name: string; expires: number }

/**
 * Maps unguessable capability tokens to pre-validated file paths so the browser can fetch
 * agent-generated media (charts/diagrams/voice) without a bearer header (an <img src> can't send
 * one). Possession of the token is the capability; the route never accepts a caller-supplied path.
 * Path safety reuses the same realpath check as the agent attach_file server (isSafe) — mirroring
 * the AIOS_TMP_PREFIX "-" suffix rule so macOS /tmp symlink paths still validate.
 */
export function createAttachmentRegistry(
  safeDirs: string[],
  opts: { ttlMs?: number; now?: () => number; genToken?: () => string } = {},
): AttachmentRegistry {
  const ttl = opts.ttlMs ?? 60 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());
  const gen = opts.genToken ?? (() => randomUUID());
  const map = new Map<string, Entry>();

  const sweep = () => {
    const t = now();
    for (const [k, v] of map) if (v.expires < t) map.delete(k);
  };

  return {
    register(path, meta = {}) {
      if (!isSafe(path, safeDirs)) throw new Error(`refused: path outside safe roots: ${path}`);
      sweep();
      const name = basename(path);
      const mime = mimeFor(name);
      const token = gen();
      map.set(token, { path, mime, name, expires: now() + ttl });
      return { token, name, mime, caption: meta.caption, kind: meta.kind };
    },
    get(token) {
      const e = map.get(token);
      if (!e) return undefined;
      if (e.expires < now()) { map.delete(token); return undefined; }
      return { path: e.path, mime: e.mime, name: e.name };
    },
  };
}
