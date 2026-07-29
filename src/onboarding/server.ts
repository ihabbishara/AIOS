// src/onboarding/server.ts — setup-mode HTTP server (spec §1): ui2 static + wizard endpoints.
// Deliberately self-contained: web/server.ts needs the whole booted world; this needs a kv store,
// an env path, and a dist dir. The browser is a thin renderer of this server's state.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { Wizard, STEPS, type Step, type KvLike } from "./wizard.js";
import { verifyToken, sdkPing, type Ping } from "./auth.js";
import { updateEnvFile } from "../web/env-file.js";

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

export interface SetupDeps {
  store: KvLike;
  envPath: string;
  uiDist: string;
  port: number;
  ping?: Ping;
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

const isStep = (s: unknown): s is Step => (STEPS as readonly string[]).includes(s as string);

export function startSetupServer(deps: SetupDeps): Server {
  const wizard = new Wizard(deps.store);
  const ping = deps.ping ?? sdkPing;
  const log = deps.log ?? (() => {});
  // verifyToken swaps process-global env around the ping, so two verifications must never
  // interleave — a second attempt is refused rather than queued (the wizard has one user).
  let verifying = false;

  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      try {
        if (path === "/api/state" && req.method === "GET") {
          return json(res, 200, { mode: "setup", step: wizard.current() });
        }
        if (path === "/api/onboarding/advance" && req.method === "POST") {
          const { from } = JSON.parse(await readBody(req)) as { from?: unknown };
          if (!isStep(from)) return json(res, 400, { error: "from must be a wizard step" });
          // Auth advances only through the auth endpoint (verified token), never generically.
          if (from === "auth") return json(res, 400, { error: "auth step requires a verified token" });
          return json(res, 200, { step: wizard.advance(from) });
        }
        if (path === "/api/onboarding/back" && req.method === "POST") {
          const { to } = JSON.parse(await readBody(req)) as { to?: unknown };
          if (!isStep(to)) return json(res, 400, { error: "to must be a wizard step" });
          return json(res, 200, { step: wizard.goBack(to) });
        }
        if (path === "/api/onboarding/auth" && req.method === "POST") {
          if (verifying) return json(res, 409, { error: "a token verification is already in flight" });
          verifying = true;
          try {
            const { token } = JSON.parse(await readBody(req)) as { token?: unknown };
            const v = await verifyToken(typeof token === "string" ? token : "", ping);
            if (!v.ok) return json(res, 400, { error: v.error });
            updateEnvFile(deps.envPath, "CLAUDE_CODE_OAUTH_TOKEN", (token as string).trim());
            return json(res, 200, { step: wizard.advance("auth") });
          } finally {
            verifying = false;
          }
        }
        if (path.startsWith("/api/")) return json(res, 404, { error: "not found" });

        // Static SPA: exact file if present, index.html otherwise.
        const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
        const file = join(deps.uiDist, safe);
        const target = existsSync(file) && statSync(file).isFile() ? file : join(deps.uiDist, "index.html");
        if (!existsSync(target)) {
          res.writeHead(503, { "Content-Type": "text/plain" });
          return res.end("UI not built yet — run: cd ui2 && npm run build");
        }
        // Read before writeHead: a failed read after the head is sent cannot be answered.
        const body = readFileSync(target);
        res.writeHead(200, { "Content-Type": MIME[extname(target)] ?? "text/html" });
        res.end(body);
      } catch (err) {
        fail(res, 400, (err as Error).message);
      }
    })().catch((err) => fail(res, 500, (err as Error).message));
  });

  // Loopback only, like mission control: this server takes an unauthenticated token POST.
  server.listen(deps.port, "127.0.0.1", () => log(`setup wizard listening on :${deps.port}`));
  return server;
}
