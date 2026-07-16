// src/memory/embeddings.ts — local ONNX sentence embeddings (memory-v2 spec §3). Rides the
// @huggingface/transformers dependency already present via kokoro-js; model downloads once to
// data/models/ (gitignored) like whisper/kokoro. Fail-latch: any load/inference error turns the
// embedder off for the process lifetime — recall silently stays lexical-only.
import type { Store } from "../store/db.js";

export const VEC_DIM = 384;
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const LOAD_TIMEOUT_MS = 120_000;
const EMBED_TEXT_CAP = 2000;

export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
  available(): boolean;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      const t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms);
      (t as { unref?: () => void }).unref?.();
    }),
  ]);
}

type Pipe = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

export class LocalEmbedder implements Embedder {
  private pipe?: Pipe;
  private failed = false;
  private failedAt = 0;
  private static readonly RETRY_COOLDOWN_MS = 5 * 60_000;

  constructor(private opts: { cacheDir: string; log?: (l: string) => void }) {}

  /** Latched off, but only for a cooldown: a transient failure (e.g. a slow cold-load timeout at
   *  boot) must not disable hybrid recall for the whole process lifetime — allow a later retry. */
  available(): boolean {
    if (!this.failed) return true;
    if (Date.now() - this.failedAt >= LocalEmbedder.RETRY_COOLDOWN_MS) { this.failed = false; return true; }
    return false;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.available()) throw new Error("embedder latched off (cooldown)");
    try {
      if (!this.pipe) {
        const { pipeline, env } = await import("@huggingface/transformers");
        (env as { cacheDir: string }).cacheDir = this.opts.cacheDir;
        this.opts.log?.("loading embedding model (one-time download ~25MB)…");
        this.pipe = (await withTimeout(
          pipeline("feature-extraction", MODEL_ID, { dtype: "q8" }) as Promise<unknown>,
          LOAD_TIMEOUT_MS, "embedding model load",
        )) as Pipe;
      }
      const out = await this.pipe(texts, { pooling: "mean", normalize: true });
      return out.tolist().map((v) => Float32Array.from(v));
    } catch (err) {
      this.failed = true; this.failedAt = Date.now(); // don't retry on every recall — but see cooldown
      this.opts.log?.(`embedder failed (${(err as Error).message}) — recall stays lexical-only`);
      throw err;
    }
  }
}

/** Backfill vectors for docs that lack one (lazy backfill + write-time sweep seam, spec §3/§7).
 *  Excluded docs never enter memory_doc, so no vector can exist for them (privacy carries over).
 *  Returns the number embedded; 0 when nothing is missing or the embedder is latched. */
export async function embedMissing(store: Store, embedder: Embedder, cap = 64): Promise<number> {
  if (!embedder.available()) return 0;
  const rows = store.missingVecDocs(cap);
  if (!rows.length) return 0;
  const vecs = await embedder.embed(rows.map((r) => `${r.title}\n${r.body}`.slice(0, EMBED_TEXT_CAP)));
  rows.forEach((r, i) => store.upsertMemoryVec(r.id, vecs[i]));
  return rows.length;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i];
  return s; // vectors are L2-normalized at embed time
}
