// src/code/guard.ts
import type { ToolCheck, GuardVerdict } from "../agents/guards/halalo-readonly.js";
import { isUnder, isSecretPath } from "./paths.js";

const deny = (reason: string): GuardVerdict => ({ ok: false, reason });
const ok: GuardVerdict = { ok: true };

function pathArg(input: Record<string, unknown>): string | undefined {
  return (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
}

/** Deterministic confinement for a jailed code job. */
export function codeGuard(taskDir: string, mode: "build" | "analyze"): Record<string, ToolCheck> {
  const readCheck: ToolCheck = (input) => {
    const p = pathArg(input);
    if (!p) return deny("missing path");
    if (isSecretPath(p)) return deny("read denied: secret path");
    return isUnder(p, taskDir) ? ok : deny(`read denied: outside workspace ${taskDir}`);
  };
  const writeCheck: ToolCheck = (input) => {
    if (mode === "analyze") return deny("analyze mode is read-only");
    const p = pathArg(input);
    if (!p) return deny("missing path");
    return isUnder(p, taskDir) ? ok : deny(`write denied: outside workspace ${taskDir}`);
  };
  const denyExec: ToolCheck = () => deny("raw Bash is disabled; use mcp__code__sh");
  return {
    Read: readCheck, Grep: readCheck, Glob: readCheck,
    Write: writeCheck, Edit: writeCheck, NotebookEdit: writeCheck,
    Bash: denyExec,
  };
}

/** Sandbox pack resolved without a workspace (e.g. direct chat): advisory only. */
export function advisoryGuard(): Record<string, ToolCheck> {
  const no: ToolCheck = () => deny("advisory context: filesystem/exec disabled — use recall/vault_read");
  return { Read: no, Grep: no, Glob: no, Write: no, Edit: no, NotebookEdit: no, Bash: no };
}
