// src/clients/marsad.ts — iris's production senses for the marsad platform.
//
// Two tools ride the `marsad` server builder (resolve.ts):
//   mcp__marsad__vps       — read-only ssh onto the marsad box. The box is root@, so this
//                            validator IS the read-only boundary, not a politeness layer.
//   mcp__marsad-code__sh   — the same jailed analyze-mode shell goals get, pinned to the
//                            MediaMonitoring checkout (built in resolve.ts via buildCodeServer,
//                            not here) so the repo is reachable from chat too.
//
// Why not `Bash` + a named guard: iris is a sandbox agent, and both the advisory guard
// (workspace-less chat) and the workspace jail deny raw Bash outright; guards AND-compose,
// so a capability guard on Bash can never win. MCP tools pass guardOptions untouched
// (governed by allowedTools), which makes a daemon-side tool the only path that works in
// every context — and the enforcement lives here, in code, not in a prompt.
//
// Validation philosophy (knowledge/hard-blocking-destructive-ops-under-bypasspermissions.md §C):
// command-string matching is defeatable in general, so this validator is deliberately
// austere instead of clever — fail-closed head allowlist, no shell metacharacters at all
// (`|` between allowlisted heads is the one concession), no expansions possible because
// `$` and backticks never pass. An op the allowlist doesn't know is refused, not guessed at.
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { execFile } from "node:child_process";

export const MARSAD_REPO = process.env.AIOS_MARSAD_REPO ?? "/Users/ihabbishara/projects/MediaMonitoring";
export const MARSAD_SSH_HOST = process.env.AIOS_MARSAD_SSH_HOST ?? "marsad-vps";

function text(s: string) { return { content: [{ type: "text" as const, text: s }] }; }

// Chaining, substitution, redirection, escapes, comments: banned outright. `|` survives —
// segments are validated independently below. Quotes survive — with `$` and backticks gone
// they only group arguments. Bare parens survive for SQL (`count(*)`): with `$`, backtick
// and `<` banned they cannot substitute, and a subshell needs them at a segment head —
// where the token then fails the allowlist.
const BANNED = /[;&`$<>\\\r\n#]/;

const has = (tokens: string[], ...flags: string[]): boolean =>
  tokens.some((t) => flags.some((f) => t === f || t.startsWith(`${f}=`)));
const sub = (tokens: string[], from = 1): string | undefined =>
  tokens.slice(from).find((t) => !t.startsWith("-"));

/** head → extra restriction beyond "the head is allowed". Returns an error string or null. */
const HEADS: Record<string, (tokens: string[]) => string | null> = {
  // awk is deliberately absent: system() and `"cmd" | getline` are command execution.
  ls: () => null, cat: () => null, head: () => null, wc: () => null, stat: () => null,
  file: () => null, du: () => null, df: () => null, free: () => null, uptime: () => null,
  uname: () => null, hostname: () => null, date: () => null, id: () => null,
  whoami: () => null, grep: () => null, zgrep: () => null,
  cut: () => null, tr: () => null, echo: () => null,
  ps: () => null, ss: () => null, dmesg: () => null,
  sort: (t) => has(t, "-o", "--output") ? "sort -o writes a file on the box" : null,
  uniq: (t) => t.filter((x) => !x.startsWith("-")).length > 2
    ? "uniq with an output operand writes a file on the box" : null,
  tail: (t) => has(t, "-f", "-F", "--follow") ? "tail --follow would hang the session; poll instead" : null,
  find: (t) => has(t, "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls")
    ? "find with -delete/-exec/-fprint is not read-only" : null,
  journalctl: (t) =>
    has(t, "-f", "--follow") ? "journalctl --follow would hang the session; use -n" :
    t.some((x) => x.startsWith("--vacuum") || ["--rotate", "--flush", "--sync", "--setup-keys", "--relinquish-var"].includes(x))
      ? "journalctl maintenance flags are not read-only" : null,
  systemctl: (t) => {
    const ok = new Set(["status", "show", "cat", "list-units", "list-unit-files", "list-timers", "is-active", "is-enabled", "is-failed"]);
    return ok.has(sub(t) ?? "") ? null : `systemctl ${sub(t) ?? "(none)"} is not on the read-only allowlist`;
  },
  docker: (t) => {
    const s = sub(t);
    const ok = new Set(["ps", "logs", "inspect", "stats", "top", "images", "version", "info", "port", "diff"]);
    if (s === "compose") {
      const s2 = sub(t, t.indexOf("compose") + 1);
      return new Set(["ps", "logs", "config", "top", "version", "ls"]).has(s2 ?? "")
        ? null : `docker compose ${s2 ?? "(none)"} is not on the read-only allowlist`;
    }
    if (!ok.has(s ?? "")) return `docker ${s ?? "(none)"} is not on the read-only allowlist`;
    if (s === "logs" && has(t, "-f", "--follow")) return "docker logs --follow would hang the session; use --tail";
    return null;
  },
  git: (t) => {
    // `git -c alias.x='!cmd' x` EXECUTES cmd — -c/--config-env are config injection, denied.
    if (has(t, "-c", "--config-env", "--exec-path")) return "git -c/--config-env/--exec-path are denied (config injection)";
    if (has(t, "--output")) return "git --output writes a file on the box";
    // `-C <dir>` / `--git-dir` / `--work-tree` take a value: skip the pair, or the value is
    // misread as the subcommand and every `git -C … log` gets refused.
    let i = 1;
    while (i < t.length && (t[i].startsWith("-") || ["-C", "--git-dir", "--work-tree"].includes(t[i - 1]))) i++;
    const s = t[i];
    const ok = new Set(["log", "status", "diff", "show", "rev-parse", "branch", "remote", "describe", "shortlog", "blame", "ls-files"]);
    if (!ok.has(s ?? "")) return `git ${s ?? "(none)"} is not on the read-only allowlist`;
    if (s === "branch" && has(t, "-d", "-D", "-m", "-M", "--delete", "--move", "--copy")) return "git branch mutation flags are denied";
    if (s === "remote" && new Set(["add", "remove", "rename", "set-url", "prune", "update"]).has(sub(t, t.indexOf("remote") + 1) ?? "")) {
      return "git remote mutations are denied";
    }
    return null;
  },
  psql: (t) => {
    if (has(t, "-f", "--file")) return "psql -f is denied (script contents are unvetted)";
    if (has(t, "-o", "--output", "-L", "--log-file")) return "psql output/log flags write files on the box";
    // EVERY command payload must be read-only, in every spelling: `-c X`, `--command X`,
    // `--command=X`, and the attached `-cX`. One vetted -c must not smuggle a second one
    // (`\!` is psql's shell escape, so an unvetted payload is command execution).
    const stmts: string[] = [];
    for (let i = 1; i < t.length; i++) {
      const x = t[i];
      if (x === "-c" || x === "--command") stmts.push(t[i + 1] ?? "");
      else if (x.startsWith("--command=")) stmts.push(x.slice("--command=".length));
      else if (/^-c./.test(x)) stmts.push(x.slice(2));
    }
    if (stmts.length === 0) return "psql requires -c with a SELECT/EXPLAIN/SHOW/WITH/\\d statement";
    for (const raw of stmts) {
      const stmt = raw.replace(/^['"]/, "").trim().toLowerCase();
      if (!/^(select|explain|show|with|\\d)/.test(stmt)) return `psql statement "${raw.slice(0, 40)}" is not read-only`;
    }
    return null;
  },
  curl: (t) => {
    if (has(t, "-X", "--request", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
      "-F", "--form", "-T", "--upload-file", "-o", "-O", "--output", "--method", "-K", "--config")) {
      return "curl mutation/output flags are denied — GET health checks only";
    }
    // Schemeless URLs (`curl evil.com`) default to http — vet every non-flag operand as a
    // localhost target, not just the ones that happen to carry a scheme.
    const bad = t.slice(1).find((x) => !x.startsWith("-") && !/^(https?:\/\/)?(localhost|127\.0\.0\.1)([:/]|$)/.test(x));
    return bad ? `curl is confined to localhost on the box (got "${bad}")` : null;
  },
};

/** Fail-closed vetting of one remote command line. Exported for tests. */
export function vetVpsCommand(cmd: string): { ok: true } | { ok: false; error: string } {
  const refuse = (error: string) => ({ ok: false as const, error: `Refused (read-only gate): ${error}` });
  if (cmd.length > 2000) return refuse("command too long");
  const banned = BANNED.exec(cmd);
  if (banned) return refuse(`character "${banned[0]}" is not allowed (no chaining/substitution/redirection)`);
  for (const seg of cmd.split("|")) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return refuse("empty pipe segment");
    const check = HEADS[tokens[0]];
    if (!check) return refuse(`"${tokens[0]}" is not on the read-only allowlist`);
    const err = check(tokens);
    if (err) return refuse(err);
  }
  return { ok: true };
}

/** Run one vetted command on the box. Exported for the live smoke test. */
export function runVps(cmd: string): Promise<string> {
  const vet = vetVpsCommand(cmd);
  if (!vet.ok) return Promise.resolve(vet.error);
  return new Promise((resolve) => {
    execFile(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T", MARSAD_SSH_HOST, "--", cmd],
      { timeout: 30_000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        const body = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n").slice(0, 40_000);
        if (err) {
          const why = err.killed ? "timed out after 30s" : `exit ${(err as { code?: number | string }).code ?? "?"}`;
          return resolve(`Command failed (${why}).\n${body}`);
        }
        resolve(body || "(no output)");
      },
    );
  });
}

export function buildMarsadServer() {
  const vps = tool(
    "vps",
    `Run ONE read-only command on the marsad production box (ssh ${MARSAD_SSH_HOST}). ` +
    "Fail-closed allowlist: plain reads (ls/cat/tail/grep/find), ps/ss/df/journalctl/dmesg, " +
    "systemctl status-class, docker ps/logs/inspect (+compose ps/logs), git read subcommands, " +
    "psql -c SELECT, curl on localhost. No pipes to unlisted heads, no ;/&&/$()/redirects, " +
    "no --follow (bounded 30s). Mutations are refused here by design — propose them as a " +
    "diff plus the commands a writer would run.",
    { cmd: z.string() },
    async (args) => text(await runVps(args.cmd)),
  );
  return createSdkMcpServer({ name: "marsad", version: "0.1.0", tools: [vps] });
}
