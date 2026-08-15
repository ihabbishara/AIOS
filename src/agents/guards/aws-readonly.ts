/**
 * Deterministic read-only gate for an agent's AWS + Bash access.
 *
 * Philosophy: prompts are advisory, this gate is enforcement. Every command is
 * parsed in code and must match an explicit read-only allowlist. `aws ssm
 * send-command` executes shell ON the EC2 instance, so its inner commands are
 * validated against their own allowlist (logs, status, SELECT-only mysql).
 *
 * Which AWS profiles and instances an agent may reach is DEPLOYMENT config, not product code —
 * it names one operator's infrastructure. It comes from the env (see .env.example); unset means
 * this guard denies every aws command rather than guessing, so a misconfiguration fails closed
 * and says which variable is missing.
 */

import { resolve, sep } from "node:path";
import { allow, deny, type GuardVerdict, type ToolCheck } from "./types.js";

/**
 * Outbound files (CSV/report exports) the agent generates land here. It is a real
 * project dir (no symlink) and already an attach_file safe dir (see direct.ts), so a
 * file written here can be uploaded to the chat. Confining Write here keeps the agent
 * read-only against the source repo and the live instances while still letting it
 * deliver files. Override with AIOS_EXPORTS_DIR.
 */
export const EXPORTS_DIR = resolve(process.env.AIOS_EXPORTS_DIR ?? "data/downloads");

/** Comma-separated env list → trimmed values. Read at call time so tests can set it late. */
const envList = (name: string): string[] =>
  (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const allowedProfiles = () => envList("AIOS_AWS_READONLY_PROFILES");
const allowedInstances = () => envList("AIOS_AWS_READONLY_INSTANCES");

const SAFE_FILTERS = /^(jq|grep|egrep|head|tail|sort|uniq|wc|column|cut|tr|awk)\b/;

/**
 * Splits a command on unquoted pipes and rejects unquoted shell composition
 * (;, &, $(), backticks, redirection). Quoted content is the next layer's job.
 */
function splitTopLevel(cmd: string): { segments: string[] } | { error: string } {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        current += c + (cmd[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === quote) quote = null;
      current += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      continue;
    }
    if (c === "|") {
      segments.push(current);
      current = "";
      continue;
    }
    if (c === ";" || c === "&" || c === "`" || c === ">" || c === "<") {
      return { error: `shell composition/redirection ('${c}') is not allowed` };
    }
    if (c === "$" && cmd[i + 1] === "(") {
      return { error: "command substitution is not allowed" };
    }
    if (c === "\n") {
      return { error: "multi-line commands are not allowed" };
    }
    current += c;
  }
  if (quote) return { error: "unbalanced quotes" };
  segments.push(current);
  return { segments: segments.map((s) => s.trim()).filter(Boolean) };
}

/** Read-only commands allowed to run ON the EC2 instance via SSM. */
function checkInnerCommand(inner: string): GuardVerdict {
  const split = splitTopLevel(inner);
  if ("error" in split) return deny(`inner command: ${split.error}`);
  const [main, ...filters] = split.segments;
  for (const f of filters) {
    if (!SAFE_FILTERS.test(f)) return deny(`inner pipe target not allowed: ${f.split(" ")[0]}`);
  }
  if (!main) return deny("empty inner command");

  if (/^(tail|head|cat|zcat|grep|zgrep|egrep|ls|stat|wc|du|df|free|uptime|date|hostname|ps|id|whoami)\b/.test(main)) {
    return allow;
  }
  if (/^systemctl (status|is-active|list-units)\b/.test(main)) return allow;
  if (/^php (-v|-m|-i)\b/.test(main)) return allow;

  if (/^mysql\b/.test(main)) {
    const sqlMatch = /-e\s+(["'])([\s\S]+?)\1/.exec(main) ?? /-e\s+(\\")([\s\S]+?)\\"/.exec(main);
    if (!sqlMatch) return deny("mysql must use -e with a quoted, single read-only statement");
    const sql = sqlMatch[2].trim().replace(/;\s*$/, "");
    if (!/^(SELECT|SHOW|EXPLAIN|DESCRIBE|DESC)\b/i.test(sql)) {
      return deny("mysql statement must start with SELECT/SHOW/EXPLAIN/DESCRIBE");
    }
    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|REPLACE|RENAME|CALL|HANDLER|LOAD|OUTFILE|DUMPFILE|LOCK)\b/i.test(sql)) {
      return deny("mysql statement contains a write/DDL keyword");
    }
    if (sql.includes(";")) return deny("multiple SQL statements are not allowed");
    return allow;
  }

  return deny(`inner command not in read-only allowlist: ${main.split(" ")[0]}`);
}

function checkSsmSendCommand(main: string): GuardVerdict {
  const instances = allowedInstances();
  if (!instances.length) {
    return deny("ssm send-command is unavailable — set AIOS_AWS_READONLY_INSTANCES to the instance ids this agent may reach");
  }
  const instMatch = /--instance-ids[= ]+("?)(i-[0-9a-f]+)\1/.exec(main);
  if (!instMatch || !instances.includes(instMatch[2])) {
    return deny(`ssm send-command must target a known instance (${instances.join(", ")})`);
  }
  if (!/--document-name[= ]+["']?AWS-RunShellScript["']?/.test(main)) {
    return deny("ssm send-command must use the AWS-RunShellScript document");
  }
  const blob = /commands=\[([\s\S]*)\]/.exec(main);
  if (!blob) return deny("ssm send-command must pass --parameters 'commands=[...]'");
  let inners: string[];
  try {
    inners = JSON.parse(`[${blob[1]}]`) as string[];
  } catch {
    return deny("could not parse the commands array — keep it valid JSON");
  }
  if (!inners.length) return deny("empty commands array");
  for (const inner of inners) {
    const verdict = checkInnerCommand(inner);
    if (!verdict.ok) return verdict;
  }
  return allow;
}

/** The main gate for the agent's local Bash tool. */
export function checkAwsReadOnlyBash(command: string): GuardVerdict {
  const split = splitTopLevel(command.trim());
  if ("error" in split) return deny(split.error);
  const [main, ...filters] = split.segments;
  for (const f of filters) {
    if (!SAFE_FILTERS.test(f)) return deny(`pipe target not allowed: ${f.split(" ")[0]}`);
  }
  if (!main) return deny("empty command");

  // Local git history of the agent's project — read subcommands only.
  if (/^git (log|show|diff|status|blame|branch|tag|describe|rev-parse|shortlog|ls-files|grep|remote)\b/.test(main)) {
    return allow;
  }

  if (!/^aws\s/.test(main)) {
    return deny("only aws CLI and read-only git commands are allowed");
  }

  const profiles = allowedProfiles();
  if (!profiles.length) {
    return deny("no aws profile is permitted — set AIOS_AWS_READONLY_PROFILES to the profiles this agent may use");
  }
  const profile = /--profile[= ]+(\S+)/.exec(main)?.[1]?.replace(/["']/g, "");
  if (!profile || !profiles.includes(profile)) {
    return deny(`aws commands must use --profile ${profiles.join(" or ")}`);
  }

  if (/^aws ssm start-session\b/.test(main)) {
    return deny("interactive sessions are not available — use ssm send-command with a read-only command");
  }
  if (/^aws ssm send-command\b/.test(main)) {
    return checkSsmSendCommand(main);
  }
  if (/^aws ssm (get-command-invocation|list-commands|list-command-invocations|describe-instance-information)\b/.test(main)) {
    return allow;
  }
  if (/^aws s3 ls\b/.test(main)) return allow;
  if (/^aws logs (tail|filter-log-events|get-log-events|describe-log-groups|describe-log-streams)\b/.test(main)) {
    return allow;
  }

  // Generic read-only AWS actions: describe-* / get-* / list-* / head-*
  const action = /^aws\s+[a-z0-9-]+\s+([a-z0-9-]+)/.exec(main)?.[1];
  if (action && /^(describe|get|list|head)-/.test(action)) return allow;

  return deny(`aws action "${action ?? "?"}" is not read-only — this agent has read access only`);
}

/** Per-tool checks for a read-only project role: Bash gated, project reads confined, writes denied. */
export function awsReadOnlyToolChecks(projectDir: string): Record<string, ToolCheck> {
  const inProject = (p: unknown): boolean => typeof p !== "string" || p === "" || p.startsWith(projectDir);
  return {
    Bash: (input) => checkAwsReadOnlyBash(String(input.command ?? "")),
    Read: (input) =>
      inProject(input.file_path) ? allow : deny(`reads are confined to ${projectDir}`),
    Grep: (input) => (inProject(input.path) ? allow : deny(`searches are confined to ${projectDir}`)),
    Glob: (input) => (inProject(input.path) ? allow : deny(`searches are confined to ${projectDir}`)),
    // Write is confined to the exports dir so the agent can generate a CSV/report to attach,
    // without gaining write access to the source repo or the live instances. Absolute paths only.
    Write: (input) => {
      const p = input.file_path;
      if (typeof p !== "string" || !p) return deny("Write needs a file_path");
      const real = resolve(p);
      return real === EXPORTS_DIR || real.startsWith(EXPORTS_DIR + sep)
        ? allow
        : deny(`writes are confined to ${EXPORTS_DIR} — generate exports there, then attach_file them`);
    },
    WebSearch: () => allow,
    WebFetch: () => allow,
    TodoWrite: () => allow,
  };
}
