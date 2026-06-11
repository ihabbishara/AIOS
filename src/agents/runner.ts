import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { roles, type RoleDef } from "./roles/index.js";

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

export interface SpecialistResult {
  text: string;
  structured?: unknown;
  costUsd: number;
  numTurns: number;
}

export interface RunOptions {
  cwd: string;
  /** Extra directories the agent may touch (e.g. the target project). */
  additionalDirectories?: string[];
  model?: string;
  signal?: AbortSignal;
}

export type SpecialistRunFn = (
  role: string,
  brief: string,
  opts: RunOptions,
) => Promise<SpecialistResult>;

export const runSpecialist: SpecialistRunFn = async (roleName, brief, opts) => {
  const role = roles[roleName];
  if (!role) throw new Error(`Unknown role: ${roleName}`);

  const abort = new AbortController();
  const onAbort = () => abort.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const q = query({
      prompt: brief,
      options: {
        systemPrompt: role.systemPrompt,
        allowedTools: role.allowedTools,
        permissionMode: role.permissionMode,
        ...(role.permissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        cwd: opts.cwd,
        additionalDirectories: opts.additionalDirectories,
        maxTurns: role.maxTurns,
        persistSession: false,
        settingSources: [],
        ...skillOptions(role),
        abortController: abort,
        ...(opts.model ? { model: opts.model } : {}),
        ...(role.outputSchema
          ? { outputFormat: { type: "json_schema" as const, schema: role.outputSchema } }
          : {}),
      },
    });

    for await (const msg of q) {
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          return {
            text: msg.result,
            structured: msg.structured_output,
            costUsd: msg.total_cost_usd,
            numTurns: msg.num_turns,
          };
        }
        throw new Error(
          `Specialist ${roleName} failed: ${msg.subtype}${"errors" in msg ? ` — ${msg.errors.join("; ")}` : ""}`,
        );
      }
    }
    throw new Error(`Specialist ${roleName} ended without a result message`);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
};
