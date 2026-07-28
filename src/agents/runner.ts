import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { RoleDef } from "./roles/index.js";
import { guardOptions } from "./guards/index.js";
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import type { LoadedRegistry } from "./registry/loader.js";
import { withEffectiveTools, withDenialObserver } from "./permissions.js";
import { buildMailServer, MAIL_TOOL, ASK_TOOL } from "../mail/server.js";
import type { Mailbox, MailSendCtx } from "../mail/mailbox.js";

const SKILLS_PLUGIN_PATH =
  process.env.AIOS_SKILLS_PLUGIN ?? join(process.cwd(), "skills-plugin");

/** SDK options that load this role's skills from the aios-skills plugin. */
export function skillOptions(role: RoleDef): Partial<Options> {
  if (!role.skills?.length || !existsSync(SKILLS_PLUGIN_PATH)) return {};
  return {
    plugins: [{ type: "local", path: SKILLS_PLUGIN_PATH }],
    skills: role.skills.map((s) => `aios-skills:${s}`),
  };
}

/** System prompt = persona + injected context files (e.g. a project CLAUDE.md, read fresh each session). */
export function roleSystemPrompt(role: RoleDef): string {
  let prompt = role.systemPrompt;
  for (const file of role.contextFiles ?? []) {
    if (!existsSync(file)) continue;
    prompt += `\n\n# Project knowledge (${file})\n\n${readFileSync(file, "utf8")}`;
  }
  return prompt;
}

/**
 * Single source of truth for a role's SDK options — used by both the pipeline
 * runner and direct chats so security settings can never diverge.
 */
export function roleQueryOptions(role: RoleDef, opts: { cwd: string; model?: string }): Options {
  return {
    systemPrompt: roleSystemPrompt(role),
    allowedTools: role.allowedTools,
    permissionMode: role.permissionMode,
    ...(role.permissionMode === "bypassPermissions"
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    cwd: role.cwd ?? opts.cwd,
    maxTurns: role.maxTurns,
    settingSources: [],
    ...(opts.model ? { model: opts.model } : {}),
    ...skillOptions(role),
    ...(role.toolChecks ? guardOptions(role.toolChecks, role.toolCheckFallback ?? "allow") : {}),
  };
}



/** One denied tool, correlated exactly to the run that hit it (policy-wall spec §1).
 *  `layer` decides the fix: "allowlist" is grantable via permission.grant; "guard" is
 *  engine policy and is not. `role` is the canonical role that hit the wall — a loop/verify
 *  attempt runs two roles and the grant must name the right one. */
export interface DeniedTool { role: string; tool: string; reason: string; layer: "allowlist" | "guard" }

/** A specialist failure that still carries what the run learned before dying —
 *  denials survive the throw (the burn-turns-against-a-wall case). */
export class SpecialistError extends Error {
  readonly name = "SpecialistError";
  constructor(message: string, readonly denials: DeniedTool[] = []) { super(message); }
}

export interface SpecialistResult {
  text: string;
  structured?: unknown;
  costUsd: number;
  numTurns: number;
  /** Tools the run reached for and was refused, both layers (policy-wall spec §1). */
  denials?: DeniedTool[];
}

export interface RunOptions {
  cwd: string;
  /** Extra directories the agent may touch (e.g. the target project). */
  additionalDirectories?: string[];
  /** Caller model override — loses to a per-agent manifest `model:`, wins over kind tiering. */
  model?: string;
  signal?: AbortSignal;
  /** Originating chat — resolveAgent scopes gate proposals/ledger writes to it. */
  origin?: { channel: string; chatId: string };
  /** Sandbox workspace for code-sandbox capabilities (goal nodes). */
  workspace?: { taskDir: string; mode: "build" | "analyze" };
  /** Goal-attempt dedupe key (goalId:node:attempt#) — gate proposals carry it. */
  idempotencyKey?: string;
  /** Structured-output schema for roles without their own (role schema always wins). */
  outputSchema?: Record<string, unknown>;
  /** When set (with a mailbox in deps), the run gets send_mail + its unread-mail block.
   *  goalDepth = the running goal's chain_depth (0 for chat/hand_off/standup runs). */
  mailCtx?: { origin: { channel: string; chatId: string }; goalDepth: number; goalId?: string; nodeKey?: string };
}

export type SpecialistRunFn = (
  role: string,
  brief: string,
  opts: RunOptions,
) => Promise<SpecialistResult>;


/** Merge the aios-mail server into run options: server + allowlist entry + unread-mail prompt
 *  block. Pure. MUST be applied BEFORE withDenialObserver wraps (the observer denies from the
 *  allowlist it captures at wrap time — the StructuredOutput lesson). */
export function withMailOptions(base: Options, mailbox: Mailbox, ctx: MailSendCtx): { options: Options; deliveredIds: string[] } {
  const { block, ids } = mailbox.peekInbound(ctx.from);
  const options = {
    ...base,
    mcpServers: { ...(base.mcpServers ?? {}), "aios-mail": buildMailServer(mailbox, ctx) },
    allowedTools: [...new Set([...(base.allowedTools ?? []), MAIL_TOOL, ASK_TOOL])],
    ...(block ? { systemPrompt: `${base.systemPrompt}\n\n${block}` } : {}),
  };
  // deliveredIds committed by the caller via mailbox.markDelivered() ONLY on run success —
  // a crash between here and completion leaves the mail unread so it re-surfaces next run.
  return { options, deliveredIds: ids };
}

const DEFAULT_ORIGIN = { channel: "engine", chatId: "goals" };

export function makeRunSpecialist(deps: {
  store: Store; bus: EventBus; registry: LoadedRegistry; mailbox?: Mailbox;
  resolveAgent: import("./resolve.js").ResolveAgentFn;
}): SpecialistRunFn {
  return async (roleName, brief, opts) => {
    // Per-run denial collector (policy-wall spec §1). `collectRole` starts as the alias and is
    // upgraded to the canonical name right after resolution — grants key on canonical names.
    const denials: DeniedTool[] = [];
    let collectRole = roleName;
    const collect = (tool: string, reason: string, layer: DeniedTool["layer"]): void => {
      if (!denials.some((d) => d.tool === tool && d.layer === layer)) {
        denials.push({ role: collectRole, tool, reason, layer });
      }
    };
    // THE one resolution path (org-model spec §7): capabilities → tools/servers/guards/model.
    const resolved = deps.resolveAgent(roleName, opts.origin ?? DEFAULT_ORIGIN, {
      cwd: opts.cwd, workspace: opts.workspace,
      idempotencyKey: opts.idempotencyKey, model: opts.model,
      onDeny: (tool, reason) => collect(tool, reason, "guard"),
    });
    if (!resolved) throw new Error(`Unknown agent: ${roleName}`);
    const { canonical, def } = resolved;
    collectRole = canonical;
    const role = def.role;

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      let merged = resolved.options;
      // Mail server + unread-mail block, applied BEFORE the observer wraps (same widen-before-wrap
      // rule as StructuredOutput below). deliveredIds committed only on run success (below).
      let deliveredIds: string[] = [];
      if (deps.mailbox && opts.mailCtx) {
        const r = withMailOptions(merged, deps.mailbox, { from: canonical, ...opts.mailCtx });
        merged = r.options;
        deliveredIds = r.deliveredIds;
      }
      // Structured output arrives via the SDK's StructuredOutput tool. Widen the allowlist
      // BEFORE the denial observer wraps it — the observer's PreToolUse hook denies from the
      // list it captures at wrap time (observed live: tool.denied athena StructuredOutput →
      // structured: undefined for planner leads and verdict critics).
      const schema = role.outputSchema ?? opts.outputSchema;
      const withSchema = schema
        ? { ...merged, allowedTools: [...new Set([...(merged.allowedTools ?? []), "StructuredOutput"])] }
        : merged;
      const observed = withDenialObserver(withSchema, canonical, (e) => {
        collect(e.tool, `${e.tool} is not in ${canonical}'s allowlist`, "allowlist");
        deps.bus.emit({ type: "tool.denied", ...e });
      });
      const q = query({
        prompt: brief,
        options: {
          ...observed,
          additionalDirectories: opts.additionalDirectories,
          persistSession: false,
          abortController: abort,
          ...(schema
            ? { outputFormat: { type: "json_schema" as const, schema: schema as Record<string, unknown> } }
            : {}),
        },
      });

      for await (const msg of q) {
        if (msg.type === "result") {
          if (msg.subtype === "success") {
            deps.mailbox?.markDelivered(deliveredIds); // commit unread mail ONLY on success
            return {
              text: msg.result,
              structured: msg.structured_output,
              costUsd: msg.total_cost_usd,
              numTurns: msg.num_turns,
              ...(denials.length ? { denials } : {}),
            };
          }
          throw new SpecialistError(
            `Specialist ${roleName} failed: ${msg.subtype}${"errors" in msg ? ` — ${msg.errors.join("; ")}` : ""}`,
            denials,
          );
        }
      }
      throw new SpecialistError(`Specialist ${roleName} ended without a result message`, denials);
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  };
}
