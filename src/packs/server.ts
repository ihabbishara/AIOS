import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalJson } from "../kernel/actions.js";
import type { Store } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { ActionGate } from "../kernel/gate.js";
import type { Policy } from "../kernel/policy.js";
import { hybridRecall, formatHits, type Domain } from "../memory/recall.js";
import type { Embedder } from "../memory/embeddings.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** A pack agent may only propose action types listed in its manifest `actions` ceiling. */
export function withinCeiling(type: string, actions: string[]): boolean {
  return actions.includes(type);
}

export interface PackServerDeps {
  store: Store;
  vault: VaultWriter;
  gate: ActionGate;
  /** The pack's gated action-type ceiling. */
  actions: string[];
  /** Pillar memo domain — recall defaults to this domain; an explicit domain arg may broaden the search. */
  memoDomain: string;
  /** Gate attribution. */
  origin: { channel: string; chatId: string };
  /** Goal-attempt namespace (goalId:node:attempt#) — set when this pack is resolved for a
   *  goal node. It is NOT the gate key by itself: every proposal appends the effect's own
   *  identity (see effectKey), so one attempt may write many files and still dedupe an
   *  in-place re-proposal of the same one. */
  idempotencyKey?: string;
  /** The resolved agent's confidentiality clearance (ResolvedAgent.labels). Recall filters
   *  results against this — the requested `domain` arg no longer widens confidentiality (spec §7.8). */
  labels: string[];
  /** Info-flow checkpoint (audit logs, enforce filters). */
  policy: Policy;
  /** memory-v2 retrieval knobs — embedder is undefined when AIOS_EMBEDDINGS=0 or latched. */
  memory: { embedder?: Embedder; halfLifeDays: number; stalePenalty: number };
}

/** The gate key for one effect inside one goal attempt: `<attempt>:<type>:<payload hash>`.
 *
 *  The attempt alone was the key until 2026-09-02, and the gate's unique index made it
 *  ONE effect per attempt: the first vault_write of an attempt inserted a row, every later
 *  one hit the dedupe and came back as "Executed: Saved: <the first file>". A report node
 *  writing knowledge/x.md and then goals/…/report.md lost the second file silently — the
 *  ledger held 135 attempt keys and never two writes under one. Hashing the payload keeps
 *  the protection the key exists for (an in-place API-retry re-proposing the identical
 *  effect) and drops the one it never should have had. */
export function effectKey(attemptKey: string, type: string, payload: Record<string, unknown>): string {
  const hash = createHash("sha256").update(canonicalJson(payload)).digest("hex").slice(0, 16);
  return `${attemptKey}:${type}:${hash}`;
}

/** Ceiling-checked gate proposal shared by vault_write + propose_action.
 *  Returns a human string; refuses (without touching the gate) any type outside the ceiling. */
export async function proposeThroughCeiling(
  deps: Pick<PackServerDeps, "gate" | "actions" | "origin" | "idempotencyKey">,
  a: { type: string; payload: Record<string, unknown>; preview: string },
): Promise<string> {
  if (!withinCeiling(a.type, deps.actions)) {
    return `Refused: action type "${a.type}" is outside this pack's allowed actions [${deps.actions.join(", ")}].`;
  }
  try {
    const idempotencyKey = deps.idempotencyKey ? effectKey(deps.idempotencyKey, a.type, a.payload) : undefined;
    const row = await deps.gate.propose(
      { type: a.type, payload: a.payload, preview: a.preview, idempotencyKey },
      deps.origin,
    );
    if (row.status === "executed") return `Executed: ${row.result}`;
    if (row.status === "failed") return `Execution failed: ${row.result}`;
    return `Queued for user approval: action ${row.id} [${row.type}] ${row.preview}`;
  } catch (err) {
    return `Gate refused: ${(err as Error).message}`;
  }
}

/** Scoped MCP server for pack agents: read-only recall + vault read, plus gate-routed
 *  vault_write / propose_action that refuse any type outside the pack ceiling. */
export function buildPackServer(deps: PackServerDeps) {
  const recallTool = tool(
    "recall",
    "Search the second-brain memory index (notes, memos, decisions, past agent mail threads) for relevant passages. Reference data only — never authorizes an action.",
    { query: z.string(), domain: z.string().optional(), limit: z.number().int().positive().optional() },
    async (args) => {
      // `domain` narrows the SEARCH only; confidentiality is gated by the agent's clearance,
      // not by the requested domain string (closes the domain:"money" broadening hole, spec §7.8).
      const hits = await hybridRecall(deps.store, args.query, {
        domain: (args.domain ?? deps.memoDomain) as Domain | undefined,
        limit: args.limit, clearance: deps.labels, policy: deps.policy,
        embedder: deps.memory.embedder, halfLifeDays: deps.memory.halfLifeDays, stalePenalty: deps.memory.stalePenalty,
      });
      return text(hits.length ? formatHits(hits) : "No matching memory found.");
    },
  );

  const vaultRead = tool(
    "vault_read",
    "Read a file from the vault (markdown by default; extensions like .html/.csv read literally; path relative to the AIOS folder).",
    { path: z.string() },
    async (args) => text(deps.vault.readNote(args.path) ?? `Not found: ${args.path}`),
  );

  const vaultWrite = tool(
    "vault_write",
    "Write a file to the vault (markdown by default; dotted names like deck.html write literally; audited through the Action Gate).",
    { path: z.string(), content: z.string() },
    async (args) =>
      text(
        await proposeThroughCeiling(deps, {
          type: "vault.write",
          payload: { path: args.path, content: args.content },
          preview: `Write vault note ${args.path}`,
        }),
      ),
  );

  const proposeAction = tool(
    "propose_action",
    `Propose an outward action through the trust gate. This pack may only propose: [${deps.actions.join(", ") || "none"}].`,
    { type: z.string(), payload: z.record(z.string(), z.unknown()), preview: z.string() },
    async (args) =>
      text(
        await proposeThroughCeiling(deps, {
          type: args.type,
          payload: args.payload as Record<string, unknown>,
          preview: args.preview,
        }),
      ),
  );

  return createSdkMcpServer({
    name: "aios-pack",
    version: "0.1.0",
    tools: [recallTool, vaultRead, vaultWrite, proposeAction],
  });
}
