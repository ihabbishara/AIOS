import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { roles } from "../agents/roles/index.js";
import { playbookSchema } from "../engine/playbook.js";
import { parse as parseYaml } from "yaml";
import type { Store } from "../store/db.js";
import type { EventBus, AiosEvent } from "../events.js";
import type { JobManager } from "../engine/jobs.js";
import type { VaultWriter } from "../vault/writer.js";
import type { Config } from "../config.js";
import type { MessageRouter } from "../router.js";
import type { ActionGate } from "../kernel/gate.js";
import type { VoiceService } from "../voice/index.js";
import { buildPermissionsView, isWellFormedToolName } from "./permissions-view.js";
import { buildPacksView, validateRunRequest, packDisableKey, validatePackFile, resolvePackFilePath, isSafePlaybookName } from "./packs-view.js";

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
 * Returns true when the web UI `target` field should be routed to the Chief of Staff (Rami).
 * Accepts the legacy "moderator" sentinel (transition window — some UI builds may still send it)
 * and the current "rami" name, as well as undefined/empty (default path).
 */
export function isChiefOfStaff(target?: string): boolean {
  return !target || target === "moderator" || target === "rami";
}

export interface WebDeps {
  store: Store;
  bus: EventBus;
  jobs: JobManager;
  vault: VaultWriter;
  config: Config;
  router: MessageRouter;
  gate: ActionGate;
  voice: VoiceService;
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

function updateEnvFile(envPath: string, key: string, value: string): void {
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n") : [];
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(envPath, lines.join("\n").replace(/\n*$/, "\n"));
}

export function startWebServer(deps: WebDeps, port: number): void {
  const { store, bus, jobs, vault, config, router, gate, voice, reloadPacks, log = () => {} } = deps;
  const token = process.env.AIOS_UI_TOKEN;
  const startedAt = Date.now();

  const jobDirName = (job: { slug: string; created_at: string }) =>
    `${job.created_at.slice(0, 10)}-${job.slug}`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    try {
      if (path.startsWith("/api/")) {
        if (token) {
          const auth = req.headers.authorization ?? url.searchParams.get("token") ?? "";
          if (auth !== `Bearer ${token}` && auth !== token) {
            return json(res, 401, { error: "unauthorized" });
          }
        }

        // ---- read endpoints ----
        if (path === "/api/state" && req.method === "GET") {
          return json(res, 200, {
            uptimeMs: Date.now() - startedAt,
            voice: deps.voice.available(),
            agents: [
              {
                name: "rami", kind: "moderator",
                description: "Chief of Staff — discusses, routes, runs playbooks, hands off, reports.",
                tools: ["run_playbook", "hand_off", "job_status", "vault"], guarded: false,
              },
              ...Object.values(roles).map((r) => ({
                name: r.name, kind: "specialist", description: r.description,
                tools: r.allowedTools, permissionMode: r.permissionMode,
                skills: r.skills ?? [], guarded: !!r.toolChecks, cwd: r.cwd,
              })),
            ],
            playbooks: jobs.listPlaybooks(),
            bindings: [...config.chatBindings.entries()].map(([chatKey, b]) => ({ chatKey, ...b })),
          });
        }

        if (path === "/api/jobs" && req.method === "GET") {
          const rows = store.listJobs(Number(url.searchParams.get("limit") ?? 50));
          return json(res, 200, rows.map((j) => ({ ...j, stages: store.listStages(j.id) })));
        }

        const jobMatch = /^\/api\/jobs\/([0-9a-f-]+)$/.exec(path);
        if (jobMatch && req.method === "GET") {
          const job = store.getJob(jobMatch[1]);
          if (!job) return json(res, 404, { error: "no such job" });
          const dir = jobDirName(job);
          const files = vault.listNotes(`jobs/${dir}`).map((rel) => {
            const file = rel.split("/").pop()!;
            return { file, content: vault.readJobArtifact(dir, file) ?? "" };
          });
          return json(res, 200, { ...job, stages: store.listStages(job.id), artifacts: files, vaultDir: `jobs/${dir}` });
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
          req.on("close", () => { off(); clearInterval(ping); });
          return;
        }

        if (path === "/api/costs" && req.method === "GET") {
          const byAgent: Record<string, number> = {};
          const byDay: Record<string, number> = {};
          for (const e of bus.history(0, 5000)) {
            if (e.event.type !== "agent.end" || !e.event.costUsd) continue;
            byAgent[e.event.agent] = (byAgent[e.event.agent] ?? 0) + e.event.costUsd;
            const day = e.ts.slice(0, 10);
            byDay[day] = (byDay[day] ?? 0) + e.event.costUsd;
          }
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
          return json(res, 200, store.listTrust());
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
          const text = body.target && !isChiefOfStaff(body.target) ? `@${body.target} ${body.text}` : body.text;
          const reply = (await router.handle({ channel: "web", chatId: "ui", text, sender: { name: "UI" } }))?.text ?? null;
          return json(res, 200, { reply });
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
            const text = target && !isChiefOfStaff(target) ? `@${target} ${transcript}` : transcript;
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
            const job = jobs.createJob({
              playbook: body.playbook,
              title: `${body.playbook}: ${v.projectDir ?? "new workspace"}`,
              request: `Run ${body.playbook} from the Packs view${v.projectDir ? ` on ${v.projectDir}` : ""}.`,
              projectDir: v.projectDir,
              channel: "web", chatId: "packs-view",
            });
            return json(res, 200, { id: job.id });
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
          } catch {
            // If dept.yaml is corrupted, skip playbook augmentation but still return agent files
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

        if (path === "/api/permissions" && req.method === "GET") {
          return json(res, 200, buildPermissionsView(store, bus));
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
}
