import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync, writeFileSync, readdirSync, rmSync, statSync, createReadStream, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { playbookSchema } from "../engine/playbook.js";
import { parse as parseYaml } from "yaml";
import type { Store } from "../store/db.js";
import type { EventBus, AiosEvent } from "../events.js";
import type { GoalEngine } from "../engine/goals.js";
import type { SpendGuard } from "../engine/budget.js";
import type { VaultWriter } from "../vault/writer.js";
import type { Config } from "../config.js";
import type { MessageRouter } from "../router.js";
import type { ActionGate } from "../kernel/gate.js";
import type { VoiceService } from "../voice/index.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import type { Mailbox } from "../mail/mailbox.js";
import { buildPermissionsView, isWellFormedToolName } from "./permissions-view.js";
import { buildPacksView, validateRunRequest, packDisableKey, validatePackFile, resolvePackFilePath, isSafePlaybookName } from "./packs-view.js";
import { buildOrgView, buildAgentProfile } from "./org-view.js";
import { buildGoalsView, buildGoalDetail, buildBudgetView, buildMailView, buildMailUnread, buildMailThread, buildUserThreads } from "./goals-view.js";
import { buildAttentionView } from "./attention-view.js";
import { buildScheduleView, validateRoutineBody, isValidHHMM, anchorOverrideKey, ANCHOR_NAMES } from "./schedule-view.js";
import {
  skillsPluginRoot, buildSkillsView, validateSkillMd, readSkill, writeSkill,
  deleteSkill, skillUsedBy, fetchSkillMd, agentYamlPath, rewriteSkillsField,
} from "./skills-view.js";
import { buildAgentActivity, spliceManifestField } from "./persona-view.js";
import type { AttachmentRegistry, AttachmentDescriptor } from "./attachment-registry.js";
import { validateHire, renderAgentYaml, retireBlockers } from "./agents-admin.js";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Env keys editable from the UI. Secrets are masked on read, writable on PUT. */
const CONFIG_KEYS: Array<{ key: string; secret: boolean }> = [
  { key: "CLAUDE_CODE_OAUTH_TOKEN", secret: true },
  { key: "TELEGRAM_BOT_TOKEN", secret: true },
  { key: "TELEGRAM_ALLOWED_USER_IDS", secret: false },
  { key: "SLACK_BOT_TOKEN", secret: true },
  { key: "SLACK_APP_TOKEN", secret: true },
  { key: "AIOS_CHAT_BINDINGS", secret: false },
  { key: "AIOS_FINANCE_COMPANY", secret: false },
  { key: "AIOS_FINANCE_MEMBERS", secret: false },
  { key: "AIOS_MODERATOR_MODEL", secret: false },
  { key: "AIOS_SPECIALIST_MODEL", secret: false },
  { key: "AIOS_CRITIC_MODEL", secret: false },
  { key: "AIOS_POLICY_MODE", secret: false },
  { key: "AIOS_MAX_CONCURRENT_JOBS", secret: false },
  { key: "AIOS_PROJECTS_ROOT", secret: false },
  { key: "AIOS_UI_TOKEN", secret: true },
  { key: "AIOS_TRUST_SEED", secret: false },
  { key: "AIOS_ALWAYS_SUPERVISED", secret: false },
  { key: "AIOS_GMAIL_POLL_SECONDS", secret: false },
  { key: "AIOS_CALENDAR_POLL_SECONDS", secret: false },
  { key: "AIOS_MEETING_PING_MINUTES", secret: false },
  { key: "AIOS_GMAIL_SKIP_CATEGORIES", secret: false },
];

/**
 * Returns true when the web UI `target` field should be routed to the coordinator (Chief of
 * Staff). Registry-derived — the target (or any of its aliases) resolving to the coordinator
 * agent counts; undefined/empty is the default coordinator path (org-model spec §5).
 */
export function toCoordinator(registry: LoadedRegistry, target?: string): boolean {
  if (!target) return true;
  return (registry.agentOf.get(target.toLowerCase()) ?? "") === registry.coordinator;
}

export interface WebDeps {
  store: Store;
  bus: EventBus;
  goals: GoalEngine;
  spendGuard: SpendGuard;
  vault: VaultWriter;
  config: Config;
  router: MessageRouter;
  gate: ActionGate;
  voice: VoiceService;
  /** Live registry — source of truth for the agents catalog and permissions view. */
  registry: LoadedRegistry;
  /** Mailbox — compose (sendFromUser) and human read-marking (markDelivered → mail.read). */
  mailbox: Mailbox;
  /** Serves agent-generated media (charts/diagrams/voice) to the browser by capability token. */
  attachments: AttachmentRegistry;
  /** Optional senses status provider for /api/health (index.ts wires the real one). */
  senses?: () => Array<{ name: string; ok: boolean; reason?: string }>;
  reloadPacks: () => void;
  envPath: string;
  uiDist: string;
  log?: (line: string) => void;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const VOICE_BODY_CAP = 25 * 1024 * 1024;
// A saved SKILL.md becomes agent system-prompt content — cap the paste/PUT path too, matching the
// fetch path's rationale (which was capped; this one was not — a multi-MB paste injected unbounded).
const SKILL_BODY_CAP = 512 * 1024;

async function readBodyBuffer(req: IncomingMessage, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > cap) throw new Error(`body too large (cap ${cap} bytes)`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Clamp a `?limit=` query param: junk (NaN) / 0 → default, negative → 1, huge → 200.
 *  (0 includes ?limit= empty — Number("")===0 — default, not 1.) */
const clampLimit = (raw: string | null, dflt: number): number =>
  Math.min(Math.max(1, Number(raw) || dflt), 200);

function updateEnvFile(envPath: string, key: string, value: string): void {
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n") : [];
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(envPath, lines.join("\n").replace(/\n*$/, "\n"));
}

export function startWebServer(deps: WebDeps, port: number): Server {
  const { store, bus, goals, vault, config, router, gate, voice, registry, mailbox, attachments, reloadPacks, log = () => {} } = deps;
  const token = process.env.AIOS_UI_TOKEN;
  const startedAt = Date.now();
  let sseClients = 0;

  // SSE can't send an Authorization header, so the old path put the long-lived token in the
  // stream URL (?token=) — leaking it into access/proxy logs and browser history. Instead the
  // browser exchanges its header-authed token for a short-lived, single-use ticket and passes
  // THAT in the URL; a leaked ticket is spent and expired within seconds.
  const streamTickets = new Map<string, number>(); // ticket → expiryMs
  const STREAM_TICKET_TTL = 30_000;
  const issueStreamTicket = (): string => {
    const t = randomUUID();
    const now = Date.now();
    streamTickets.set(t, now + STREAM_TICKET_TTL);
    if (streamTickets.size > 64) for (const [k, exp] of streamTickets) if (exp < now) streamTickets.delete(k);
    return t;
  };
  const consumeStreamTicket = (t: string | null): boolean => {
    if (!t) return false;
    const exp = streamTickets.get(t);
    if (exp === undefined) return false;
    streamTickets.delete(t); // one-time
    return exp >= Date.now();
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    try {
      if (path.startsWith("/api/")) {
        if (token) {
          // The stream endpoint authenticates via a one-time ticket (SSE has no headers); every
          // other endpoint uses the Authorization header. No token-in-URL path exists anymore.
          const ticketOk = path === "/api/stream" && consumeStreamTicket(url.searchParams.get("ticket"));
          // Media served by capability token (an <img src> can't send a bearer header): the
          // unguessable token IS the auth; an invalid token 404s from the handler, never reaching here.
          const attachmentOk = path.startsWith("/api/attachment/") && req.method === "GET";
          const auth = req.headers.authorization ?? "";
          if (!ticketOk && !attachmentOk && auth !== `Bearer ${token}` && auth !== token) {
            return json(res, 401, { error: "unauthorized" });
          }
        }

        if (path === "/api/stream-ticket" && req.method === "GET") {
          return json(res, 200, { ticket: issueStreamTicket() });
        }

        // ---- read endpoints ----
        if (path === "/api/state" && req.method === "GET") {
          return json(res, 200, {
            uptimeMs: Date.now() - startedAt,
            voice: deps.voice.available(),
            agents: [
              {
                name: "hermes", kind: "moderator",
                description: "Chief of Staff — discusses, routes, runs playbooks, hands off, reports.",
                tools: ["run_playbook", "hand_off", "job_status", "vault"], guarded: false,
              },
              ...[...registry.agents.values()]
                .filter((a) => a.manifest.name !== "hermes")
                .map((a) => ({
                  name: a.manifest.name, kind: "specialist",
                  title: a.manifest.title, description: a.role.description,
                  tools: a.role.allowedTools, permissionMode: a.role.permissionMode,
                  skills: a.role.skills ?? [], guarded: !!a.role.toolChecks, cwd: a.role.cwd,
                })),
            ],
            playbooks: goals.listPlaybooks(),
            bindings: [...config.chatBindings.entries()].map(([chatKey, b]) => ({ chatKey, ...b })),
            capabilities: [...registry.capabilities.keys()].sort(),
          });
        }

        if (path === "/api/events" && req.method === "GET") {
          return json(res, 200, bus.history(Number(url.searchParams.get("since") ?? 0), 500));
        }

        if (path === "/api/stream" && req.method === "GET") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          for (const e of bus.history(0, 100)) res.write(`data: ${JSON.stringify(e)}\n\n`);
          const off = bus.on((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
          const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
          sseClients++;
          req.on("close", () => { off(); clearInterval(ping); sseClients--; });
          return;
        }

        // ---- media: capability-token attachment serving (auth-exempt above; token is the capability) ----
        if (path.startsWith("/api/attachment/") && req.method === "GET") {
          const attToken = decodeURIComponent(path.slice("/api/attachment/".length));
          const hit = attachments.get(attToken);
          if (!hit) return json(res, 404, { error: "not found" });
          try {
            const size = statSync(hit.path).size;
            res.writeHead(200, {
              "Content-Type": hit.mime,
              "Content-Length": String(size),
              "Content-Disposition": `inline; filename="${hit.name.replace(/"/g, "")}"`,
              "Cache-Control": "private, max-age=3600",
            });
            createReadStream(hit.path).pipe(res);
          } catch {
            return json(res, 404, { error: "not found" });
          }
          return;
        }

        if (path === "/api/health" && req.method === "GET") {
          let dbBytes = 0;
          try { dbBytes = statSync(config.dbPath).size; } catch { /* :memory: or missing */ }
          // Info-flow policy posture + violation count (audit-week signal for the enforce flip).
          const policyViolations = bus.history(0, 5000).filter((e) => e.event.type === "policy.violation").length;
          return json(res, 200, {
            uptimeMs: Date.now() - startedAt,
            voice: deps.voice.available(),
            senses: deps.senses?.() ?? [],
            sseClients,
            dbBytes,
            policyMode: process.env.AIOS_POLICY_MODE === "enforce" ? "enforce" : "audit",
            policyViolations,
          });
        }

        if (path === "/api/attention" && req.method === "GET") {
          return json(res, 200, buildAttentionView(store, deps.senses));
        }

        if (path === "/api/costs" && req.method === "GET") {
          // cost_daily rollup — no more bounded history scans (ops-floor spec §2.3).
          const byAgent: Record<string, number> = {};
          for (const r of store.costsByAgent()) byAgent[r.agent] = r.usd_cents / 100;
          const byDay: Record<string, number> = {};
          for (const r of store.costsByDay(14)) byDay[r.date] = r.usd_cents / 100;
          return json(res, 200, { byAgent, byDay });
        }

        // ---- action gate ----
        if (path === "/api/actions" && req.method === "GET") {
          const status = url.searchParams.get("status") ?? undefined;
          return json(res, 200, store.listActions(status, Number(url.searchParams.get("limit") ?? 100)));
        }

        const resolveMatch = /^\/api\/actions\/([\w-]+)\/resolve$/.exec(path);
        if (resolveMatch && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { verdict: "approve" | "reject"; reason?: string };
          if (body.verdict !== "approve" && body.verdict !== "reject") {
            return json(res, 400, { error: "verdict must be approve or reject" });
          }
          try {
            const row = await gate.resolve(resolveMatch[1], body.verdict, { by: "ui", reason: body.reason });
            return json(res, 200, row);
          } catch (err) {
            return json(res, 400, { error: (err as Error).message });
          }
        }

        if (path === "/api/trust" && req.method === "GET") {
          // Per-type shadow match rate rides along for the Governance table (spec §6).
          const stats = new Map(store.shadowStats().map((s) => [s.type, s]));
          return json(res, 200, store.listTrust().map((t) => ({
            ...t,
            matches: stats.get(t.actionType)?.matches ?? 0,
            mismatches: stats.get(t.actionType)?.mismatches ?? 0,
          })));
        }

        const demoteMatch = /^\/api\/trust\/([\w.-]+)\/demote$/.exec(path);
        if (demoteMatch && req.method === "POST") {
          gate.demoteType(demoteMatch[1]);
          return json(res, 200, { ok: true });
        }

        // ---- chat ----
        if (path === "/api/chat" && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { target: string; text: string };
          if (!body.text?.trim()) return json(res, 400, { error: "text required" });
          const text = body.target && !toCoordinator(registry, body.target) ? `@${body.target} ${body.text}` : body.text;
          const result = await router.handle({ channel: "web", chatId: "ui", text, sender: { name: "UI" } });
          const atts: AttachmentDescriptor[] = [];
          for (const a of result?.attachments ?? []) {
            try { atts.push(attachments.register(a.path, { caption: a.caption, kind: a.kind })); }
            catch (err) { log(`attachment register failed (${a.path}): ${(err as Error).message}`); }
          }
          return json(res, 200, { reply: result?.text ?? null, attachments: atts });
        }

        // ---- voice ----
        if (path === "/api/voice" && req.method === "POST") {
          if (!voice.available()) {
            return json(res, 503, { error: `voice disabled: ${voice.disabledReason()}` });
          }
          const target = url.searchParams.get("target") ?? "moderator";
          let audioPath: string | undefined;
          try {
            const body = await readBodyBuffer(req, VOICE_BODY_CAP);
            audioPath = join(config.dataDir, "voice-tmp", `web-${randomUUID()}.webm`);
            writeFileSync(audioPath, body);
            const transcript = await voice.transcribe(audioPath);
            if (!transcript.trim()) return json(res, 422, { error: "could not transcribe audio" });
            const text = target && !toCoordinator(registry, target) ? `@${target} ${transcript}` : transcript;
            const reply = (await router.handle({ channel: "web", chatId: "ui", text, sender: { name: "UI" } }))?.text ?? "";
            let audio: string | null = null;
            try {
              const oggPath = await voice.synthesize(reply);
              audio = readFileSync(oggPath).toString("base64");
              rmSync(oggPath, { force: true });
            } catch (err) {
              log(`voice reply synthesis failed: ${(err as Error).message}`);
            }
            return json(res, 200, { transcript, reply, audio });
          } catch (err) {
            return json(res, 400, { error: (err as Error).message });
          } finally {
            if (audioPath) rmSync(audioPath, { force: true });
          }
        }

        // ---- playbooks ----
        if (path === "/api/playbooks" && req.method === "GET") {
          const out = readdirSync(config.playbooksDir)
            .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
            .map((f) => ({ file: f, yaml: readFileSync(join(config.playbooksDir, f), "utf8") }));
          return json(res, 200, out);
        }
        const pbMatch = /^\/api\/playbooks\/([\w.-]+\.ya?ml)$/.exec(path);
        if (pbMatch && req.method === "PUT") {
          const file = normalize(pbMatch[1]).replace(/^(\.\.[/\\])+/, "");
          const body = JSON.parse(await readBody(req)) as { yaml: string };
          try {
            playbookSchema.parse(parseYaml(body.yaml));
          } catch (err) {
            return json(res, 400, { error: `invalid playbook: ${(err as Error).message}` });
          }
          writeFileSync(join(config.playbooksDir, file), body.yaml);
          reloadPacks();
          return json(res, 200, { ok: true, reloaded: true });
        }

        // ---- config ----
        if (path === "/api/config" && req.method === "GET") {
          return json(res, 200, CONFIG_KEYS.map(({ key, secret }) => {
            const value = process.env[key] ?? "";
            return { key, secret, set: !!value, value: secret ? (value ? "••••••" : "") : value };
          }));
        }
        if (path === "/api/config" && req.method === "PUT") {
          const body = JSON.parse(await readBody(req)) as { key: string; value: string };
          if (!CONFIG_KEYS.some((c) => c.key === body.key)) {
            return json(res, 400, { error: `key not editable: ${body.key}` });
          }
          updateEnvFile(deps.envPath, body.key, body.value);
          return json(res, 200, { ok: true, note: "restart required to apply" });
        }

        if (path === "/api/restart" && req.method === "POST") {
          json(res, 200, { ok: true, note: "daemon exiting — launchd restarts it in seconds" });
          log("restart requested from UI");
          setTimeout(() => process.exit(0), 300);
          return;
        }

        if (path === "/api/packs" && req.method === "GET") {
          return json(res, 200, buildPacksView(config, store));
        }

        const runMatch = /^\/api\/packs\/([\w-]+)\/run$/.exec(path);
        if (runMatch && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { playbook?: string; project_dir?: string };
          if (!body.playbook) return json(res, 400, { error: "playbook required" });
          const v = validateRunRequest(config, runMatch[1], body.playbook, body.project_dir);
          if (!v.ok) return json(res, 400, { error: v.error });
          try {
            const goal = goals.createFromPlaybook({
              playbook: body.playbook,
              title: `${body.playbook}: ${v.projectDir ?? "new workspace"}`,
              request: `Run ${body.playbook} from the Packs view${v.projectDir ? ` on ${v.projectDir}` : ""}.`,
              projectDir: v.projectDir,
              channel: "web", chatId: "packs-view",
            });
            return json(res, 200, { id: goal.id });
          } catch (e) {
            return json(res, 400, { error: (e as Error).message });
          }
        }

        const enabledMatch = /^\/api\/packs\/([\w-]+)\/enabled$/.exec(path);
        if (enabledMatch && req.method === "POST") {
          const pillar = enabledMatch[1];
          if (!existsSync(join(config.agentsDir, pillar, "department.yaml"))) {
            return json(res, 404, { error: `unknown department: ${pillar}` });
          }
          const body = JSON.parse(await readBody(req)) as { enabled?: boolean };
          updateEnvFile(deps.envPath, packDisableKey(pillar), body.enabled === false ? "1" : "");
          json(res, 200, { ok: true, restarting: true });
          log(`pack ${pillar} ${body.enabled === false ? "disabled" : "enabled"} from UI — restarting`);
          setTimeout(() => process.exit(0), 300);
          return;
        }

        const filesMatch = /^\/api\/packs\/([\w-]+)\/files$/.exec(path);
        if (filesMatch && req.method === "GET") {
          const dept = filesMatch[1];
          const deptDir = join(config.agentsDir, dept);
          const deptYamlPath = join(deptDir, "department.yaml");
          if (!existsSync(deptYamlPath)) return json(res, 404, { error: "unknown department" });
          // Agent files from agents dir
          const out: Array<{ file: string; yaml: string }> = readdirSync(deptDir)
            .filter((f) => /\.ya?ml$/.test(f))
            .map((f) => ({ file: f, yaml: readFileSync(join(deptDir, f), "utf8") }));
          // Playbook files from playbooks dir (per dept.playbooks list)
          const seen = new Set(out.map((x) => x.file));
          try {
            const deptContent = parseYaml(readFileSync(deptYamlPath, "utf8")) as { playbooks?: string[] };
            const pbNames = Array.isArray(deptContent.playbooks) ? deptContent.playbooks : [];
            for (const pb of pbNames) {
              if (!isSafePlaybookName(pb)) continue; // Finding 2: reject unsafe playbook names before any path join
              const pbFile = `${pb}.yaml`;
              if (seen.has(pbFile)) continue;
              for (const pbPath of [
                join(config.playbooksDir, dept, pbFile),
                join(config.playbooksDir, pbFile),
              ]) {
                if (existsSync(pbPath)) {
                  out.push({ file: pbFile, yaml: readFileSync(pbPath, "utf8") });
                  seen.add(pbFile);
                  break;
                }
              }
            }
          } catch (err) {
            // If dept.yaml is corrupted, skip playbook augmentation but still return agent files.
            log(`packs/${dept}/files: playbook augmentation skipped — ${(err as Error).message}`);
          }
          return json(res, 200, out);
        }
        const fileMatch = /^\/api\/packs\/([\w-]+)\/files\/([\w.-]+\.ya?ml)$/.exec(path);
        if (fileMatch && req.method === "PUT") {
          const [, pillar, file] = fileMatch;
          const deptDir = join(config.agentsDir, pillar);
          if (!existsSync(join(deptDir, "department.yaml"))) return json(res, 404, { error: "unknown department" });
          const body = JSON.parse(await readBody(req)) as { yaml: string };
          // Parse department.yaml to get the playbook list for flat-path dept membership guard (fail-closed on error)
          let deptPlaybooks: string[] = [];
          try {
            const raw = parseYaml(readFileSync(join(deptDir, "department.yaml"), "utf8")) as { playbooks?: unknown };
            if (Array.isArray(raw.playbooks)) deptPlaybooks = raw.playbooks.filter((x): x is string => typeof x === "string");
          } catch { /* empty list → flat branch refuses */ }
          const route = resolvePackFilePath(pillar, file, { agentsDir: config.agentsDir, playbooksDir: config.playbooksDir, deptPlaybooks });
          if (!route) return json(res, 404, { error: "file not found in agents or playbooks directory" });
          const v = validatePackFile(file, body.yaml, route.type, pillar);
          if (!v.ok) return json(res, 400, { error: `invalid ${file}: ${v.error}` });
          writeFileSync(route.absPath, body.yaml);
          reloadPacks();
          return json(res, 200, { ok: true, reloaded: true });
        }

        // ---- org ----
        if (path === "/api/org" && req.method === "GET") {
          return json(res, 200, buildOrgView(registry, store, bus));
        }

        const agentMatch = /^\/api\/agents\/([a-z][a-z0-9-]*)$/.exec(path);
        if (agentMatch && req.method === "GET") {
          const profile = buildAgentProfile(agentMatch[1], registry, store, bus);
          if (!profile) return json(res, 404, { error: "unknown agent" });
          return json(res, 200, profile);
        }

        // ---- goals ----
        if (path === "/api/goals" && req.method === "GET") {
          return json(res, 200, buildGoalsView(store, clampLimit(url.searchParams.get("limit"), 50)));
        }

        const goalMatch = /^\/api\/goals\/([\w-]+)$/.exec(path);
        if (goalMatch && req.method === "GET") {
          const detail = buildGoalDetail(store, vault, goalMatch[1]);
          if (!detail) return json(res, 404, { error: "unknown goal" });
          return json(res, 200, detail);
        }

        const goalCtl = /^\/api\/goals\/([\w-]+)\/(pause|resume|abandon)$/.exec(path);
        if (goalCtl && req.method === "POST") {
          const [, ref, verb] = goalCtl;
          const message =
            verb === "pause" ? goals.pauseGoal(ref)
            : verb === "resume" ? goals.resumeGoal(ref)
            : goals.abandonGoal(ref);
          return json(res, 200, { message });
        }

        const reviewCtl = /^\/api\/goals\/([\w-]+)\/review\/([\w-]+)$/.exec(path);
        if (reviewCtl && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { verdict?: string; guidance?: string };
          if (body.verdict !== "accept" && body.verdict !== "retry" && body.verdict !== "abandon") {
            return json(res, 400, { error: "verdict must be accept, retry, or abandon" });
          }
          const message = goals.resolveReview(reviewCtl[1], reviewCtl[2], body.verdict,
            { by: "ui", guidance: body.guidance?.trim() || undefined });
          return json(res, 200, { message });
        }

        if (path === "/api/budget" && req.method === "GET") {
          return json(res, 200, buildBudgetView(deps.spendGuard));
        }

        // ---- schedule: anchors + routines + reminders (spec 2026-07-15) ----
        if (path === "/api/schedule" && req.method === "GET") {
          return json(res, 200, buildScheduleView(store, config, new Date()));
        }

        if (path === "/api/routines" && req.method === "POST") {
          const v = validateRoutineBody(JSON.parse(await readBody(req)), false);
          if (!v.ok) return json(res, 400, { error: v.error });
          const id = store.addRoutine({ name: v.fields.name!, prompt: v.fields.prompt!, recurrence: v.fields.recurrence! });
          return json(res, 200, { id });
        }

        const routineMatch = /^\/api\/routines\/(\d+)$/.exec(path);
        if (routineMatch && req.method === "PATCH") {
          const v = validateRoutineBody(JSON.parse(await readBody(req)), true);
          if (!v.ok) return json(res, 400, { error: v.error });
          if (!store.updateRoutine(Number(routineMatch[1]), v.fields)) return json(res, 404, { error: "unknown routine" });
          return json(res, 200, { ok: true });
        }
        if (routineMatch && req.method === "DELETE") {
          if (!store.deleteRoutine(Number(routineMatch[1]))) return json(res, 404, { error: "unknown routine" });
          return json(res, 200, { ok: true });
        }

        const routineRun = /^\/api\/routines\/(\d+)\/run$/.exec(path);
        if (routineRun && req.method === "POST") {
          const r = store.getRoutine(Number(routineRun[1]));
          if (!r) return json(res, 404, { error: "unknown routine" });
          // Manual fire: same bus event as the clock, no stamping — scheduled cadence unaffected.
          bus.emit({
            type: "routine.due", id: r.id, name: r.name, prompt: r.prompt,
            channel: r.origin_channel ?? "", chatId: r.origin_chat_id ?? "",
          });
          return json(res, 200, { ok: true });
        }

        const anchorPatch = /^\/api\/anchors\/([a-z]+)$/.exec(path);
        if (anchorPatch && req.method === "PATCH") {
          if (!(ANCHOR_NAMES as readonly string[]).includes(anchorPatch[1])) {
            return json(res, 404, { error: "unknown anchor" });
          }
          const body = JSON.parse(await readBody(req)) as { hhmm?: unknown };
          if (!isValidHHMM(body.hhmm)) return json(res, 400, { error: "hhmm must be HH:MM (24h, zero-padded)" });
          store.kvSet(anchorOverrideKey(anchorPatch[1]), body.hhmm);
          return json(res, 200, { ok: true });
        }

        const reminderDel = /^\/api\/reminders\/(\d+)$/.exec(path);
        if (reminderDel && req.method === "DELETE") {
          if (!store.cancelReminder(Number(reminderDel[1]))) return json(res, 404, { error: "unknown or non-pending reminder" });
          return json(res, 200, { ok: true });
        }

        // ---- skills manager (spec 2026-07-15 skills-manager) ----
        const skillsRoot = skillsPluginRoot();

        if (path === "/api/skills" && req.method === "GET") {
          return json(res, 200, buildSkillsView(skillsRoot, registry));
        }

        // Fetch route BEFORE the :name matcher — "fetch" is a reserved skill name.
        if (path === "/api/skills/fetch" && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { url?: unknown };
          if (typeof body.url !== "string") return json(res, 400, { error: "url must be a string" });
          const r = await fetchSkillMd(body.url);
          if (!r.ok) return json(res, 400, { error: r.error });
          return json(res, 200, { md: r.md });
        }

        const skillMatch = /^\/api\/skills\/([a-z][a-z0-9-]*)$/.exec(path);
        if (skillMatch && req.method === "GET") {
          const md = readSkill(skillsRoot, skillMatch[1]);
          if (md === null) return json(res, 404, { error: "unknown skill" });
          return json(res, 200, { md });
        }
        if (skillMatch && req.method === "PUT") {
          if (skillMatch[1] === "fetch") return json(res, 400, { error: '"fetch" is a reserved skill name' });
          let raw: string;
          try { raw = (await readBodyBuffer(req, SKILL_BODY_CAP)).toString("utf8"); }
          catch { return json(res, 413, { error: `skill body exceeds ${SKILL_BODY_CAP} bytes` }); }
          const body = JSON.parse(raw) as { md?: unknown };
          if (typeof body.md !== "string") return json(res, 400, { error: "md must be a string" });
          const v = validateSkillMd(body.md);
          if (!v.ok) return json(res, 400, { error: v.error });
          if (v.name !== skillMatch[1]) {
            return json(res, 400, { error: `frontmatter name "${v.name}" must equal "${skillMatch[1]}"` });
          }
          writeSkill(skillsRoot, skillMatch[1], body.md);
          return json(res, 200, { ok: true });
        }
        if (skillMatch && req.method === "DELETE") {
          const usedBy = skillUsedBy(registry, skillMatch[1]);
          if (usedBy.length > 0 && url.searchParams.get("force") !== "1") {
            return json(res, 409, { error: "skill in use", usedBy });
          }
          if (!deleteSkill(skillsRoot, skillMatch[1])) return json(res, 404, { error: "unknown skill" });
          return json(res, 200, { ok: true });
        }

        const agentSkillsMatch = /^\/api\/agents\/([a-z][a-z0-9-]*)\/skills$/.exec(path);
        if (agentSkillsMatch && req.method === "PATCH") {
          const canonical = registry.agentOf.get(agentSkillsMatch[1].toLowerCase()) ?? agentSkillsMatch[1];
          const def = registry.agents.get(canonical);
          if (!def) return json(res, 404, { error: "unknown agent" });
          const body = JSON.parse(await readBody(req)) as { skills?: unknown };
          if (!Array.isArray(body.skills) || body.skills.some((s) => typeof s !== "string")) {
            return json(res, 400, { error: "skills must be a string array" });
          }
          const known = new Set(buildSkillsView(skillsRoot, registry).map((s) => s.name));
          const unknown = (body.skills as string[]).filter((s) => !known.has(s));
          if (unknown.length > 0) return json(res, 400, { error: `unknown skills: ${unknown.join(", ")}` });
          const yamlPath = agentYamlPath(config.agentsDir, def);
          if (!yamlPath) return json(res, 500, { error: `agent yaml not found for ${canonical}` });
          writeFileSync(yamlPath, rewriteSkillsField(readFileSync(yamlPath, "utf8"), body.skills as string[]));
          reloadPacks();
          return json(res, 200, { ok: true });
        }

        // ---- persona explorer (spec 2026-07-16 persona-explorer) ----
        const agentActivityMatch = /^\/api\/agents\/([a-z][a-z0-9-]*)\/activity$/.exec(path);
        if (agentActivityMatch && req.method === "GET") {
          const a = buildAgentActivity(agentActivityMatch[1], registry, store, bus);
          if (!a) return json(res, 404, { error: "unknown agent" });
          return json(res, 200, a);
        }

        const manifestMatch = /^\/api\/agents\/([a-z][a-z0-9-]*)\/manifest$/.exec(path);
        if (manifestMatch && req.method === "PATCH") {
          const canonical = registry.agentOf.get(manifestMatch[1].toLowerCase()) ?? manifestMatch[1];
          const def = registry.agents.get(canonical);
          if (!def) return json(res, 404, { error: "unknown agent" });
          const body = JSON.parse(await readBody(req)) as { field?: unknown; value?: unknown };
          if (typeof body.field !== "string" || (typeof body.value !== "string" && typeof body.value !== "number")) {
            return json(res, 400, { error: "field (string) and value (string | number) required" });
          }
          const yamlPath = agentYamlPath(config.agentsDir, def);
          if (!yamlPath) return json(res, 500, { error: `agent yaml not found for ${canonical}` });
          let next: string;
          try {
            next = spliceManifestField(readFileSync(yamlPath, "utf8"), body.field, body.value);
          } catch (err) {
            return json(res, 400, { error: (err as Error).message });
          }
          writeFileSync(yamlPath, next);
          reloadPacks(); // registry maps mutate in place; a throw here = 500 but the file is valid yaml
          log(`persona edit: ${canonical}.${body.field}`);
          return json(res, 200, buildAgentProfile(canonical, registry, store, bus));
        }

        // ---- hire/fire (spec 2026-07-20) ----
        if (path === "/api/agents" && req.method === "POST") {
          const v = validateHire(JSON.parse(await readBody(req)), registry);
          if (!v.ok) return json(res, 400, { error: v.error });
          const file = join(config.agentsDir, v.manifest.department, `${v.manifest.name}.yaml`);
          writeFileSync(file, renderAgentYaml(v.manifest));
          try { reloadPacks(); } catch (err) {
            unlinkSync(file); // never leave a file the loader rejects — every future reload would fail
            return json(res, 500, { error: `hire reload failed: ${(err as Error).message}` });
          }
          log(`hired: ${v.manifest.name} (${v.manifest.department}/${v.manifest.kind})`);
          return json(res, 200, buildAgentProfile(v.manifest.name, registry, store, bus));
        }

        const retireMatch = /^\/api\/agents\/([a-z][a-z0-9-]*)$/.exec(path);
        if (retireMatch && req.method === "DELETE") {
          const canonical = registry.agentOf.get(retireMatch[1]) ?? retireMatch[1];
          const def = registry.agents.get(canonical);
          if (!def) return json(res, 404, { error: "unknown agent" });
          const blockers = retireBlockers(canonical, registry);
          if (blockers.length) return json(res, 409, { blockers, error: blockers.join("; ") });
          const yamlPath = agentYamlPath(config.agentsDir, def);
          if (!yamlPath) return json(res, 500, { error: `agent yaml not found for ${canonical}` });
          const archived = join(config.agentsDir, "_retired", `${canonical}.yaml`);
          mkdirSync(join(config.agentsDir, "_retired"), { recursive: true });
          renameSync(yamlPath, archived);
          try { reloadPacks(); } catch (err) {
            renameSync(archived, yamlPath); // compensate — roster must stay reloadable
            return json(res, 500, { error: `retire reload failed: ${(err as Error).message}` });
          }
          log(`retired: ${canonical} → agents/_retired/`);
          return json(res, 200, { ok: true, archived: `agents/_retired/${canonical}.yaml` });
        }

        if (path === "/api/mail/unread" && req.method === "GET") {
          return json(res, 200, buildMailUnread(store));
        }

        if (path === "/api/mail/mine" && req.method === "GET") {
          return json(res, 200, { threads: buildUserThreads(store) });
        }

        if (path === "/api/mail/compose" && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { to?: string; body?: string; threadId?: string; inReplyTo?: string };
          if (!body.to?.trim() || !body.body?.trim()) return json(res, 400, { error: "to and body required" });
          const result = mailbox.sendFromUser({
            to: body.to, body: body.body.slice(0, 4000),
            threadId: body.threadId || undefined, inReplyTo: body.inReplyTo || undefined,
          });
          return json(res, 200, result);
        }

        if (path === "/api/mail" && req.method === "GET") {
          return json(res, 200, buildMailView(store, registry,
            url.searchParams.get("agent") ?? undefined,
            clampLimit(url.searchParams.get("limit"), 50)));
        }

        const threadMatch = /^\/api\/mail\/thread\/([\w-]+)$/.exec(path);
        if (threadMatch && req.method === "GET") {
          return json(res, 200, buildMailThread(store, threadMatch[1]));
        }

        const answerMatch = /^\/api\/mail\/([\w-]+)\/answer$/.exec(path);
        if (answerMatch && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { text?: string };
          if (!body.text?.trim()) return json(res, 400, { error: "text required" });
          const result = goals.answerUserMail(answerMatch[1], body.text);
          return result.ok ? json(res, 200, { resumed: true }) : json(res, 409, { error: result.reason });
        }

        const readMatch = /^\/api\/mail\/([\w-]+)\/read$/.exec(path);
        if (readMatch && req.method === "POST") {
          const m = store.getMail(readMatch[1]);
          if (!m || m.to_agent !== "user") return json(res, 400, { error: "not user mail" });
          mailbox.markDelivered([m.id]);
          return json(res, 200, { ok: true });
        }

        if (path === "/api/permissions" && req.method === "GET") {
          return json(res, 200, buildPermissionsView(store, bus, registry));
        }

        if (path === "/api/permissions/propose" && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { role?: string; tool?: string; action?: string };
          if (body.action !== "grant" && body.action !== "revoke") {
            return json(res, 400, { error: "action must be grant or revoke" });
          }
          if (!body.role || !body.tool) {
            return json(res, 400, { error: "role and tool are required" });
          }
          const tool = body.tool.trim();
          if (!isWellFormedToolName(tool)) {
            return json(res, 400, { error: "tool must be a non-empty name with no spaces" });
          }
          try {
            // Proposal-only: the gate authors the preview and (always-supervised) queues it.
            // Nothing is applied until a human approves — safe despite the unauth-localhost API.
            const row = await gate.propose(
              { type: `permission.${body.action}`, payload: { role: body.role, tool }, preview: "" },
              { channel: "web", chatId: "mission-control" },
            );
            return json(res, 200, { id: row.id, status: row.status });
          } catch (err) {
            return json(res, 400, { error: (err as Error).message });
          }
        }

        return json(res, 404, { error: "not found" });
      }

      // ---- static SPA ----
      const rel = path === "/" ? "/index.html" : path;
      const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
      let filePath = join(deps.uiDist, safe);
      if (!existsSync(filePath)) filePath = join(deps.uiDist, "index.html"); // SPA fallback
      if (!existsSync(filePath)) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        return res.end("UI not built yet — run: cd ui && npm run build");
      }
      const data = readFileSync(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
      return res.end(data);
    } catch (err) {
      log(`web error ${path}: ${(err as Error).message}`);
      return json(res, 500, { error: (err as Error).message });
    }
  });

  server.listen(port, "127.0.0.1", () => log(`mission control: http://localhost:${port}`));
  return server;
}
