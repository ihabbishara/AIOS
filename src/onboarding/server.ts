// src/onboarding/server.ts — setup-mode HTTP server (spec §1): ui2 static + wizard endpoints.
// Deliberately self-contained: web/server.ts needs the whole booted world; this needs a kv store,
// an env path, and a dist dir. The browser is a thin renderer of this server's state.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { Wizard, STEPS, type Step, type KvLike } from "./wizard.js";
import { verifyToken, sdkPing, type Ping } from "./auth.js";
import { updateEnvFile } from "../web/env-file.js";
import { listTemplates, loadTemplate } from "./templates.js";
import { templateToProposal, type OrgProposal } from "./proposal.js";
import { provision, type ProvisionResult } from "./provision.js";
import { loadRegistry } from "../agents/registry/loader.js";

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

export interface SetupDeps {
  store: KvLike;
  envPath: string;
  uiDist: string;
  port: number;
  agentsDir: string;
  playbooksDir: string;
  templatesDir: string;
  ping?: Ping;
  /** Injected in tests so provisioning can be exercised without writing an org. */
  provisionFn?: (proposal: OrgProposal) => ProvisionResult;
  /** Resume probe: did a previous run already write the org? */
  orgExists?: () => boolean;
  log?: (line: string) => void;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

/** Error path: throwing here (double writeHead) would surface as an unhandled rejection. */
function fail(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return void res.end();
  json(res, status, { error: message });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** undefined = malformed body, which is the caller's fault, not a server fault. */
async function readJson<T>(req: IncomingMessage): Promise<T | undefined> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * No Origin (curl, address-bar navigation) passes; a browser page's Origin must be our own.
 * Nothing authenticates this server, so without this any open page could no-cors POST a token
 * of its choosing to /api/onboarding/auth and have it verified and written to .env.
 */
function sameOrigin(origin: string | undefined, port: number): boolean {
  return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

const isStep = (s: unknown): s is Step => (STEPS as readonly string[]).includes(s as string);

export function startSetupServer(deps: SetupDeps): Server {
  const wizard = new Wizard(deps.store);
  const ping = deps.ping ?? sdkPing;
  const log = deps.log ?? (() => {});
  // verifyToken swaps process-global env around the ping, so two verifications must never
  // interleave — a second attempt is refused rather than queued (the wizard has one user).
  let verifying = false;

  const PROPOSAL_KEY = "onboarding.proposal";
  const doProvision = deps.provisionFn ?? ((p: OrgProposal) => provision(p, {
    agentsDir: deps.agentsDir, playbooksDir: deps.playbooksDir, templatesDir: deps.templatesDir,
    loadRegistry, log,
  }));
  // Resume probe: a crash between "org written" and "step advanced" must not provision twice.
  const orgExists = deps.orgExists ?? (() => {
    try { return loadRegistry(deps.agentsDir, deps.playbooksDir).agents.size > 0; }
    catch { return false; }
  });

  // Read at request time, not from deps: port 0 (tests) is only resolved once bound.
  const boundPort = (): number => {
    const addr = server.address();
    return typeof addr === "object" && addr !== null ? addr.port : deps.port;
  };

  /** A rejected transition (stale tab, illegal jump) is the caller's fault — 400, logged either way. */
  const transition = (res: ServerResponse, path: string, move: () => Step): void => {
    try {
      json(res, 200, { step: move() });
    } catch (err) {
      log(`setup rejected ${path}: ${(err as Error).message}`);
      json(res, 400, { error: (err as Error).message });
    }
  };

  const server = createServer((req, res) => {
    // llhttp accepts request targets `new URL` rejects ("GET //[" is the shortest). This runs
    // in the request listener, where a throw is an uncaughtException — a silently dead daemon.
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return void fail(res, 400, "bad request target");
    }
    // Never silent: an unexpected fault is the daemon's, and setup has no other operator view.
    const oops = (err: unknown): void => {
      log(`setup error ${path}: ${(err as Error).message}`);
      fail(res, 500, (err as Error).message);
    };
    void (async () => {
      try {
        if (path.startsWith("/api/") && !sameOrigin(req.headers.origin, boundPort())) {
          return json(res, 403, { error: "cross-origin request refused" });
        }
        if (path === "/api/state" && req.method === "GET") {
          return json(res, 200, { mode: "setup", step: wizard.current() });
        }
        if (path === "/api/onboarding/advance" && req.method === "POST") {
          const body = await readJson<{ from?: unknown }>(req);
          if (!body) return json(res, 400, { error: "body must be JSON" });
          const from = body.from;
          if (!isStep(from)) return json(res, 400, { error: "from must be a wizard step" });
          // Auth advances only through the auth endpoint (verified token), never generically.
          if (from === "auth") return json(res, 400, { error: "auth step requires a verified token" });
          return transition(res, path, () => wizard.advance(from));
        }
        if (path === "/api/onboarding/back" && req.method === "POST") {
          const body = await readJson<{ to?: unknown }>(req);
          if (!body) return json(res, 400, { error: "body must be JSON" });
          const to = body.to;
          if (!isStep(to)) return json(res, 400, { error: "to must be a wizard step" });
          return transition(res, path, () => wizard.goBack(to));
        }
        if (path === "/api/onboarding/auth" && req.method === "POST") {
          // A retry or double-submit must not re-verify and rewrite .env: the step it would
          // land on is already reached, so answer with where the wizard actually is.
          const at = wizard.current();
          if (at !== "auth") return json(res, 409, { step: at });
          if (verifying) return json(res, 409, { error: "a token verification is already in flight" });
          verifying = true;
          try {
            const body = await readJson<{ token?: unknown }>(req);
            if (!body) return json(res, 400, { error: "body must be JSON" });
            const v = await verifyToken(typeof body.token === "string" ? body.token : "", ping);
            if (!v.ok) return json(res, 400, { error: v.error });
            updateEnvFile(deps.envPath, "CLAUDE_CODE_OAUTH_TOKEN", (body.token as string).trim());
            return transition(res, path, () => wizard.advance("auth"));
          } finally {
            verifying = false;
          }
        }
        if (path === "/api/onboarding/templates" && req.method === "GET") {
          return json(res, 200, { templates: listTemplates(deps.templatesDir, log) });
        }

        if (path === "/api/onboarding/template" && req.method === "POST") {
          if (wizard.current() !== "interview") {
            return json(res, 400, { error: `templates are chosen at the interview step, not ${wizard.current()}` });
          }
          const body = await readJson<{ name?: unknown }>(req);
          if (!body) return json(res, 400, { error: "body must be JSON" });
          const name = typeof body.name === "string" ? body.name : "";
          let template;
          try {
            template = loadTemplate(deps.templatesDir, name);
          } catch (err) {
            return json(res, 400, { error: `template "${name}" is invalid: ${(err as Error).message}` });
          }
          if (!template) return json(res, 400, { error: `unknown template "${name}"` });
          // Stored, not written: nothing touches disk until the user approves on the review screen.
          deps.store.kvSet(PROPOSAL_KEY, JSON.stringify(templateToProposal(template)));
          return transition(res, path, () => wizard.advance("interview"));
        }

        if (path === "/api/onboarding/proposal" && req.method === "GET") {
          const raw = deps.store.kvGet(PROPOSAL_KEY);
          if (!raw) return json(res, 404, { error: "no proposal yet" });
          return json(res, 200, { proposal: JSON.parse(raw) as OrgProposal });
        }

        if (path === "/api/onboarding/provision" && req.method === "POST") {
          const at = wizard.current();
          // Resume: a crash between writing the org and advancing leaves the wizard here with
          // an org already on disk. Finishing is right; provisioning again would collide.
          if (at === "provision" && orgExists()) {
            return transition(res, path, () => wizard.advance("provision"));
          }
          if (at !== "review") return json(res, 400, { error: `provisioning happens at the review step, not ${at}` });
          const raw = deps.store.kvGet(PROPOSAL_KEY);
          if (!raw) return json(res, 400, { error: "no proposal to provision" });
          const result = doProvision(JSON.parse(raw) as OrgProposal);
          if (!result.ok) {
            const summary = result.errors.map((e) => `${e.name ?? e.scope}: ${e.error}`).join("; ");
            log(`provision rejected: ${summary}`);
            // Both keys on purpose: `errors` drives the per-card highlighting, `error` is what
            // ui2's shared request() helper reads off a failed response (api.ts:43). Without it
            // a rejected provision would surface to the user as a bare "HTTP 400".
            return json(res, 400, { error: summary, errors: result.errors });
          }
          wizard.advance("review");    // → provision
          wizard.advance("provision"); // → first-job
          log(`org provisioned: ${result.agents.join(", ")}`);
          return json(res, 200, { step: wizard.current(), departments: result.departments, agents: result.agents });
        }

        if (path.startsWith("/api/")) return json(res, 404, { error: "not found" });

        // Static SPA: exact file if present, index.html otherwise.
        const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
        const file = join(deps.uiDist, safe);
        const target = existsSync(file) && statSync(file).isFile() ? file : join(deps.uiDist, "index.html");
        if (!existsSync(target)) {
          res.writeHead(503, { "Content-Type": "text/plain" });
          // npm install too: this fires on a fresh clone, where ui2's deps (vite) are missing.
          return res.end("UI not built yet — run: cd ui2 && npm install && npm run build");
        }
        // Read before writeHead: a failed read after the head is sent cannot be answered.
        const body = readFileSync(target);
        res.writeHead(200, { "Content-Type": MIME[extname(target)] ?? "text/html" });
        res.end(body);
      } catch (err) {
        oops(err);
      }
    })().catch(oops);
  });

  // Loopback only, like mission control: this server takes an unauthenticated token POST.
  server.listen(deps.port, "127.0.0.1", () => log(`setup wizard listening on :${deps.port}`));
  return server;
}
