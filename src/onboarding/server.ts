// src/onboarding/server.ts — setup-mode HTTP server (spec §1): ui2 static + wizard endpoints.
// Deliberately self-contained: web/server.ts needs the whole booted world; this needs a kv store,
// an env path, and a dist dir. The browser is a thin renderer of this server's state.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { homedir } from "node:os";
import { Wizard, STEPS, type Step, type KvLike } from "./wizard.js";
import { resolveWorkspace, type WorkspaceChoice } from "./workspace.js";
import { verifyToken, sdkPing, type Ping } from "./auth.js";
import { updateEnvFile } from "../web/env-file.js";
import {
  captureTelegramChat, parseAllowedUserIds, singleLine, verifyGemini, verifySlack, verifyTelegram,
  type FetchFn,
} from "./connect.js";
import { listTemplates, loadTemplate } from "./templates.js";
import { grantMediaGen, templateToProposal, type OrgProposal } from "./proposal.js";
import { provision, type ProvisionResult } from "./provision.js";
import { loadRegistry } from "../agents/registry/loader.js";
import {
  buildArchitectContext, interviewTurn, productCapabilities, redraftAgent, sdkArchitect,
  type Architect, type Turn,
} from "./architect.js";
import { listSkills, skillsPluginRoot } from "../web/skills-view.js";
import { buildGoalsForOrigin } from "../web/goals-view.js";
import { vaultSnapshot, newFiles } from "./artifacts.js";
import { loadCapabilities } from "../agents/registry/capabilities.js";
import { CAPABILITIES_FILE } from "./seed.js";
import type { BootedWorld } from "../boot.js";

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
  /** Injected in tests so the interview never touches the network. */
  architect?: Architect;
  /** Injected in tests so channel verification never touches the network. */
  connectFetch?: FetchFn;
  /** Brings the real daemon up in-process once an org exists. Injected so tests never boot. */
  boot?: () => Promise<BootedWorld>;
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

  // The booted daemon, once it exists. Tasks that need the engine read this; `booting` is the
  // in-flight promise so a refresh, a double-click and the retry endpoint cannot make two worlds.
  let world: BootedWorld | null = null;
  let booting: Promise<BootedWorld> | null = null;
  let bootError = "";

  const ensureBooted = async (): Promise<BootedWorld | null> => {
    if (world) return world;
    if (!deps.boot) return null;
    if (!booting) {
      booting = deps.boot()
        .then((w) => { world = w; bootError = ""; log("daemon booted in-process"); return w; })
        .catch((err) => {
          // The org is already on disk and valid — a boot failure is a separate fault, so it is
          // recorded for the UI rather than unwound. Cleared so a retry can try again.
          bootError = (err as Error).message;
          log(`hot boot failed: ${bootError}`);
          throw err;
        })
        .finally(() => { booting = null; });
    }
    return booting.catch(() => null);
  };

  // Connect step: one 409-guard flag for all channel POSTs (the wizard has one user; the
  // Telegram long-poll can hold a request ~25s and must not pile up), the in-memory getUpdates
  // offset, and a kv key for non-secret card metadata so a refresh rehydrates the step.
  let connecting = false;
  let tgOffset = 0;
  const connectFetch = deps.connectFetch ?? fetch;
  const CONNECT_KEY = "onboarding.connect";

  /** Channel keys must reach BOTH stores: .env is the record that survives a restart, and
   *  process.env is what the hot in-process boot actually reads (the workspace step's
   *  precedent — bootNormal calls loadConfig() over process.env). */
  const writeEnv = (key: string, value: string): void => {
    updateEnvFile(deps.envPath, key, value);
    process.env[key] = value;
  };

  type ConnectMeta = { telegram?: { botUsername: string }; slack?: { team: string; botUser: string }; image?: { model?: string } };
  const connectMeta = (): ConnectMeta => {
    try { return JSON.parse(deps.store.kvGet(CONNECT_KEY) ?? "{}") as ConnectMeta; } catch { return {}; }
  };
  const saveConnectMeta = (patch: ConnectMeta): void => {
    deps.store.kvSet(CONNECT_KEY, JSON.stringify({ ...connectMeta(), ...patch }));
  };
  /** Card state, derived from env presence + kv metadata. Never returns a token. */
  const connectStatus = () => {
    const meta = connectMeta();
    return {
      telegram: {
        connected: !!process.env.TELEGRAM_BOT_TOKEN,
        ...(meta.telegram ? { botUsername: meta.telegram.botUsername } : {}),
        ...(process.env.TELEGRAM_ALLOWED_USER_IDS ? { allowedUserIds: process.env.TELEGRAM_ALLOWED_USER_IDS } : {}),
        ...(process.env.AIOS_PRIMARY_CHAT ? { primaryChat: process.env.AIOS_PRIMARY_CHAT } : {}),
      },
      slack: { connected: !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN), ...(meta.slack ?? {}) },
      image: { connected: !!process.env.GEMINI_API_KEY, model: process.env.AIOS_GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image" },
    };
  };
  /** A Gemini key makes image generation real — surface media-gen on the proposal the review
   *  screen shows, where the user can still strip it per agent. */
  const withGrants = (p: OrgProposal): OrgProposal => (process.env.GEMINI_API_KEY ? grantMediaGen(p) : p);

  const PROPOSAL_KEY = "onboarding.proposal";
  const TRANSCRIPT_KEY = "onboarding.transcript";
  const FIRST_JOB_KEY = "onboarding.firstJob";
  // The coordinator answers on a chat like any other caller; this tuple is what makes the
  // goals it spawns findable later without inventing an id registry.
  const JOB_ORIGIN = { channel: "web", chatId: "onboarding" };
  type JobState = {
    status: "running" | "done" | "failed"; request: string; reply?: string; error?: string;
    /** Vault files that appeared while the job ran — see onboarding/artifacts.ts for why. */
    wrote?: string[];
  };
  // In-process on purpose, and never persisted: kv alone cannot tell a live dispatch from one
  // whose process died mid-turn. This flag is what makes that distinction knowable.
  let dispatching = false;
  const jobState = (): JobState | null => {
    const raw = deps.store.kvGet(FIRST_JOB_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as JobState;
    // Reconciled on read rather than written at boot. NOT for a restart: bootMode answers
    // "normal" the moment an org exists and auth is set (mode.ts), so a daemon that dies during
    // the first job comes back as mission control and this wizard is never re-entered. What it
    // is for is a dispatch that ends inside this process without settling — if the done/failed
    // write itself throws (SQLITE_BUSY), `dispatching` still drops in the finally and kv is left
    // on `running` with nothing able to resolve it, and the wizard would spin on it forever.
    if (s.status === "running" && !dispatching) {
      return { ...s, status: "failed", error: "interrupted — try again" };
    }
    return s;
  };
  const setJobState = (s: JobState) => deps.store.kvSet(FIRST_JOB_KEY, JSON.stringify(s));
  const ask = deps.architect ?? sdkArchitect;
  const transcript = (): Turn[] => JSON.parse(deps.store.kvGet(TRANSCRIPT_KEY) ?? "[]") as Turn[];

  /**
   * seedCapabilities plants the catalog in the user's agents dir at PROVISION, but the interview
   * and the review chips both run before that. Reading only agentsDir therefore hands a fresh
   * install an empty catalog — and the Architect drafts every agent with no capabilities, which
   * is to say no tools. Prefer the user's copy once it exists; they may have edited it.
   */
  const capabilityCatalog = (): Array<{ name: string; labels: string[] }> => {
    const user = join(deps.agentsDir, CAPABILITIES_FILE);
    const path = existsSync(user) ? user : join(deps.templatesDir, CAPABILITIES_FILE);
    return [...loadCapabilities(path)].map(([name, def]) => ({ name, labels: def.labels }));
  };

  /** Rebuilt per turn: the catalogues are files on disk and the user may be editing them. */
  const architectContext = (): string => buildArchitectContext({
    capabilities: capabilityCatalog(),
    skills: listSkills(skillsPluginRoot()),
    templates: listTemplates(deps.templatesDir, log)
      .map((t) => loadTemplate(deps.templatesDir, t.name))
      .filter((t): t is NonNullable<typeof t> => Boolean(t)),
  });
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

  /** A rejected transition (stale tab, illegal jump) is the caller's fault — 400, logged either way.
   *  `extra` rides along on the success body for steps that answer with more than the step, and is
   *  spread FIRST: the step is this function's whole contract, and a caller that happened to pass
   *  a `step` key would otherwise silently move the wizard somewhere the server never went. */
  const transition = (res: ServerResponse, path: string, move: () => Step, extra?: Record<string, unknown>): void => {
    try {
      json(res, 200, { ...extra, step: move() });
    } catch (err) {
      log(`setup rejected ${path}: ${(err as Error).message}`);
      json(res, 400, { error: (err as Error).message });
    }
  };

  /** Who the org is, for the done screen. A proposal that will not parse is not worth losing the
   *  handover over — the screen has a line for an org it cannot name. Partial, not OrgProposal:
   *  this is parsed kv, so each half defaults on its own rather than letting one missing key
   *  throw away the other. */
  const roster = (): { departments: string[]; agents: string[] } => {
    try {
      const raw = deps.store.kvGet(PROPOSAL_KEY);
      const p = raw ? (JSON.parse(raw) as Partial<OrgProposal>) : {};
      return {
        departments: (p.departments ?? []).map((d) => d.department),
        agents: (p.agents ?? []).map((a) => a.name),
      };
    } catch {
      return { departments: [], agents: [] };
    }
  };

  /** Where the daemon actually writes, for the done screen. A booted world is the truth — its
   *  VaultWriter already joined the pair and is the object doing the writing. Before one exists
   *  (the user skipped past a failed boot) fall back to what the workspace step put on
   *  process.env, with config.ts's own defaults, which is what a boot would read anyway.
   *  Resolved to one string on purpose: the screen shows a folder, not a pair to re-join. */
  const workspacePath = (): string =>
    world?.vault.root ?? join(
      process.env.AIOS_VAULT_PATH ?? join(homedir(), "AIOS", "workspace"),
      process.env.AIOS_VAULT_SUBDIR ?? "AIOS",
    );

  /** The file list is a nicety; the job is not. Anything that can throw on the way to it — a
   *  world booted without a vault, a workspace the daemon cannot read — must cost the user their
   *  list, never their dispatch, so this swallows and returns nothing rather than propagating
   *  into the handler that is about to run their first job. */
  const snapshotVault = (): Set<string> => {
    try { return vaultSnapshot(workspacePath()); } catch { return new Set(); }
  };

  /**
   * first-job → done is the port handover, and the only place the UI token ever reaches the
   * browser. It rides on THIS response because the moment startWebServer owns the port every
   * /api/ route is behind the token gate — a second round trip to fetch it would have nothing
   * left to ask. The org summary rides along for the same reason: the done screen names the
   * departments, the agents and the folder their work lands in, and by the time it could fetch
   * any of that this server is gone.
   */
  const handover = (res: ServerResponse, path: string): void => {
    let step: Step;
    try {
      step = wizard.advance("first-job");
    } catch (err) {
      log(`setup rejected ${path}: ${(err as Error).message}`);
      return json(res, 400, { error: (err as Error).message });
    }
    json(res, 200, {
      step, uiToken: process.env.AIOS_UI_TOKEN ?? "", ...roster(), workspace: workspacePath(),
    });

    // Which daemon this port is for, decided now but not necessarily known yet. A boot can still
    // be in flight: "skip for now" on the failed-boot screen is deliberately never disabled, so
    // the user can arrive here mid-retry. Reading the `world` latch alone would drop that promise
    // and leave a daemon that boots seconds later, healthy, and never bound to anything.
    const ready: Promise<BootedWorld | null> =
      world ? Promise.resolve(world)
        : booting ? booting.catch(() => null)
          : Promise.resolve(null);

    // Three ways this response can end, and the teardown must run on exactly one of them.
    // `finish` is the ordinary one. `close` fires after it on every healthy response too, which
    // is what the once-flag is for: two teardowns is two mission controls racing for one port.
    // The synchronous check is the one that closes the real hole. Measured on node 23: a socket
    // destroyed while the response is still being written STILL fires `finish`, so `close` alone
    // buys nothing — but a client that goes away while this handler is awaiting the request body
    // has already had `close` emitted before these listeners exist, and `finish` never fires at
    // all. Subscribing alone would wait forever there, and forever means this server holds the
    // port with the daemon running headless beside it, which no reload recovers from.
    let handed = false;
    const handOver = (aborted: boolean): void => {
      if (handed) return;
      handed = true;
      // Worth a line of its own: the token rode on a response that never arrived, so the reload
      // behind "Open AIOS" lands on mission control's token gate rather than the cockpit. Handing
      // the port over anyway is still the better half of a bad situation — the alternative is a
      // setup server owning the port and a done screen looping back to itself — and the gate has
      // a way through, with the token in .env and in the boot log above.
      if (aborted) {
        log("handover response never reached the browser — mission control is taking the port anyway;" +
          " the UI token is in .env as AIOS_UI_TOKEN");
      }
      // Every step of this order is load-bearing. The setImmediate lets the connection go idle,
      // and only inside close()'s callback is the port genuinely free — binding any earlier
      // races the socket this server still holds.
      setImmediate(() => void ready.then((w) => {
        // No daemon at all means nothing is waiting to take the port, and closing anyway would
        // leave the user on a dead one with the wizard gone too. Holding the port is the
        // recoverable half of a bad situation; a restart comes up in normal mode either way.
        if (!w) return void log("no daemon to hand the port to — keeping the setup server up");
        server.close(() => {
          try {
            w.startWeb();
          } catch (err) {
            log(`FATAL: mission control could not take the port: ${(err as Error).message}`);
          }
        });
        // What makes close() actually finish, and not a tidiness measure. close() waits for every
        // open connection, and a browser keeps more than one to an origin — a preconnect, a second
        // tab, the poll this screen was running. Measured: one extra socket that has sent nothing
        // holds close() open indefinitely, so mission control never comes up at all. All of them,
        // not just the idle ones: the wizard is over, so a request still in flight on another
        // connection has nothing left to report and waiting on it only stalls the handover.
        server.closeAllConnections();
      }));
    };
    res.on("finish", () => handOver(false));
    // Kept as insurance rather than for a path reachable today: if a future node stops firing
    // `finish` for a response whose socket died mid-write, this is what keeps the port moving.
    res.on("close", () => handOver(true));
    if (res.destroyed) handOver(true);
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
          return json(res, 200, {
            mode: "setup", step: wizard.current(),
            booted: world !== null,
            ...(bootError ? { bootError } : {}),
          });
        }
        // Retry after a failed hot boot. The org is already provisioned by the time this can
        // matter, so this brings up the engine alone — it never re-runs provisioning.
        if (path === "/api/onboarding/boot" && req.method === "POST") {
          // Booting before an org exists latches `world` to a zero-agent daemon — loadRegistry
          // only throws when there are agents but no coordinator, so an empty dir loads fine —
          // and the provision-time boot would then short-circuit on it, running the first job
          // against an empty registry. There is no valid reason to boot without an org.
          if (!orgExists()) return json(res, 409, { error: "no org yet — provision one first" });
          const w = await ensureBooted();
          return json(res, w ? 200 : 500,
            w ? { booted: true } : { booted: false, error: bootError || "no boot function configured" });
        }
        if (path === "/api/onboarding/advance" && req.method === "POST") {
          const body = await readJson<{ from?: unknown }>(req);
          if (!body) return json(res, 400, { error: "body must be JSON" });
          const from = body.from;
          if (!isStep(from)) return json(res, 400, { error: "from must be a wizard step" });
          // Auth advances only through the auth endpoint (verified token), never generically.
          if (from === "auth") return json(res, 400, { error: "auth step requires a verified token" });
          if (from === "first-job") return handover(res, path);
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
        // ---- Connect step: channels + image generation (all optional, none advance) ----

        if (path === "/api/onboarding/connect" && req.method === "GET") {
          // Read-only and secret-free, so not step-gated — same posture as /templates.
          return json(res, 200, connectStatus());
        }

        if (path.startsWith("/api/onboarding/connect/") && req.method === "POST") {
          const at = wizard.current();
          if (at !== "connect") return json(res, 400, { error: `channels are connected at the connect step, not ${at}` });
          if (connecting) return json(res, 409, { error: "a channel operation is already in flight" });
          connecting = true;
          try {
            if (path === "/api/onboarding/connect/telegram") {
              const body = await readJson<{ token?: unknown; allowedUserIds?: unknown }>(req);
              if (!body) return json(res, 400, { error: "body must be JSON" });
              const token = typeof body.token === "string" ? body.token.trim() : "";
              if (!singleLine(token)) return json(res, 400, { error: "token must be a single non-empty line" });
              let allowed: string | null = null;
              if (typeof body.allowedUserIds === "string" && body.allowedUserIds.trim()) {
                allowed = parseAllowedUserIds(body.allowedUserIds);
                if (allowed === null) return json(res, 400, { error: "allowed user ids must be comma-separated numbers" });
              }
              const v = await verifyTelegram(token, connectFetch);
              if (!v.ok) return json(res, 400, { error: v.error });
              writeEnv("TELEGRAM_BOT_TOKEN", token);
              if (allowed) writeEnv("TELEGRAM_ALLOWED_USER_IDS", allowed);
              saveConnectMeta({ telegram: { botUsername: v.botUsername } });
              tgOffset = 0;
              return json(res, 200, connectStatus());
            }

            if (path === "/api/onboarding/connect/telegram/capture") {
              if (!process.env.TELEGRAM_BOT_TOKEN) return json(res, 400, { error: "connect the bot token first" });
              const r = await captureTelegramChat(process.env.TELEGRAM_BOT_TOKEN, tgOffset, connectFetch);
              if (!r.ok) return json(res, r.conflict ? 409 : 400, { error: r.error });
              tgOffset = r.offset;
              return json(res, 200, { captured: r.captured });
            }

            if (path === "/api/onboarding/connect/telegram/primary") {
              const body = await readJson<{ chatId?: unknown; userId?: unknown }>(req);
              if (!body) return json(res, 400, { error: "body must be JSON" });
              const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
              if (!/^-?\d+$/.test(chatId)) return json(res, 400, { error: "chat id must be a number (groups are negative)" });
              writeEnv("AIOS_PRIMARY_CHAT", `telegram:${chatId}`);
              const userId = typeof body.userId === "string" ? body.userId.trim() : "";
              if (/^\d+$/.test(userId)) {
                const cur = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
                if (!cur.includes(userId)) writeEnv("TELEGRAM_ALLOWED_USER_IDS", [...cur, userId].join(","));
              }
              return json(res, 200, connectStatus());
            }

            if (path === "/api/onboarding/connect/slack") {
              const body = await readJson<{ botToken?: unknown; appToken?: unknown }>(req);
              if (!body) return json(res, 400, { error: "body must be JSON" });
              const bot = typeof body.botToken === "string" ? body.botToken.trim() : "";
              const app = typeof body.appToken === "string" ? body.appToken.trim() : "";
              if (!singleLine(bot) || !singleLine(app)) {
                return json(res, 400, { error: "Slack needs both tokens — AIOS skips Slack when only one is set" });
              }
              const v = await verifySlack(bot, app, connectFetch);
              if (!v.ok) return json(res, 400, { error: v.error });
              writeEnv("SLACK_BOT_TOKEN", bot);
              writeEnv("SLACK_APP_TOKEN", app);
              saveConnectMeta({ slack: { team: v.team, botUser: v.botUser } });
              return json(res, 200, connectStatus());
            }

            if (path === "/api/onboarding/connect/image") {
              const body = await readJson<{ apiKey?: unknown; model?: unknown }>(req);
              if (!body) return json(res, 400, { error: "body must be JSON" });
              const key = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
              if (!singleLine(key)) return json(res, 400, { error: "API key must be a single non-empty line" });
              const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "gemini-2.5-flash-image";
              const v = await verifyGemini(key, model, connectFetch);
              if (!v.ok) return json(res, 400, { error: v.error });
              writeEnv("GEMINI_API_KEY", key);
              // Only pin the model when the user chose one; the config default stays authoritative.
              if (typeof body.model === "string" && body.model.trim()) writeEnv("AIOS_GEMINI_IMAGE_MODEL", model);
              saveConnectMeta({ image: { ...(typeof body.model === "string" && body.model.trim() ? { model } : {}) } });
              return json(res, 200, connectStatus());
            }

            return json(res, 404, { error: "unknown connect endpoint" });
          } finally {
            connecting = false;
          }
        }

        if (path === "/api/onboarding/templates" && req.method === "GET") {
          return json(res, 200, { templates: listTemplates(deps.templatesDir, log) });
        }

        if (path === "/api/onboarding/workspace" && req.method === "POST") {
          if (wizard.current() !== "workspace") {
            return json(res, 400, { error: `the workspace is chosen at the workspace step, not ${wizard.current()}` });
          }
          const body = await readJson<WorkspaceChoice>(req);
          if (!body) return json(res, 400, { error: "body must be JSON" });
          if (body.mode !== "builtin" && body.mode !== "custom") {
            return json(res, 400, { error: "mode must be builtin or custom" });
          }
          const r = resolveWorkspace(body, homedir());
          if (!r.ok) return json(res, 400, { error: r.error });

          // Probe rather than trust: a directory can exist and still be unwritable, and finding
          // that out at the first artifact write means losing the job that produced it. The probe
          // runs in <path>/<subdir>, not the vault root, because that is where the daemon writes
          // (boot.ts:138) — which also makes the filesystem, rather than a hardcoded NAME_MAX we
          // would get wrong on some volume, the judge of whether the subdir is a usable name.
          // Only custom is probed: the builtin path is ours to create, and probing it here would
          // mean this endpoint writing into the real home directory of whoever runs the tests.
          // A directory the probe created is deliberately kept, even when the write then fails or
          // the user backs out of a sync warning: it is the folder we just told them we would use,
          // and unwinding it risks removing one that was already there.
          if (body.mode === "custom") {
            const dir = join(r.path, r.subdir);
            const probe = join(dir, ".aios-write-probe");
            try {
              mkdirSync(dir, { recursive: true });
              writeFileSync(probe, "");
              unlinkSync(probe);
            } catch (err) {
              return json(res, 400, { error: `cannot write to ${dir}: ${(err as Error).message}` });
            }
          }
          // Written for builtin too, though config.ts already defaults to the same path: after a
          // back-navigation these keys may already name a folder the user has just rejected, and
          // "builtin writes nothing" would strand the daemon on it. .env should always name the
          // real workspace — it records the actual choice, it is debuggable, and it stays right
          // if the built-in default in config.ts ever moves.
          updateEnvFile(deps.envPath, "AIOS_VAULT_PATH", r.path);
          updateEnvFile(deps.envPath, "AIOS_VAULT_SUBDIR", r.subdir);
          // bootNormal calls loadConfig() itself, but that reads process.env — which this
          // process already populated at start. Set it here too or the hot boot uses the old path.
          process.env.AIOS_VAULT_PATH = r.path;
          process.env.AIOS_VAULT_SUBDIR = r.subdir;
          return transition(res, path, () => wizard.advance("workspace"),
            r.warning ? { warning: r.warning } : undefined);
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
          deps.store.kvSet(PROPOSAL_KEY, JSON.stringify(withGrants(templateToProposal(template))));
          return transition(res, path, () => wizard.advance("interview"));
        }

        if (path === "/api/onboarding/proposal" && req.method === "GET") {
          const raw = deps.store.kvGet(PROPOSAL_KEY);
          if (!raw) return json(res, 404, { error: "no proposal yet" });
          return json(res, 200, { proposal: JSON.parse(raw) as OrgProposal });
        }

        if (path === "/api/onboarding/catalog" && req.method === "GET") {
          return json(res, 200, {
            capabilities: productCapabilities(capabilityCatalog()),
            skills: listSkills(skillsPluginRoot()).map((s) => s.name),
          });
        }

        if (path === "/api/onboarding/proposal" && req.method === "PATCH") {
          const raw = deps.store.kvGet(PROPOSAL_KEY);
          if (!raw) return json(res, 404, { error: "no proposal yet" });
          const body = await readJson<Record<string, unknown>>(req);
          if (!body) return json(res, 400, { error: "body must be JSON" });
          const proposal = JSON.parse(raw) as OrgProposal;

          if (typeof body.firstJob === "string") {
            if (!body.firstJob.trim()) return json(res, 400, { error: "firstJob required" });
            proposal.firstJob = body.firstJob.trim();
            deps.store.kvSet(PROPOSAL_KEY, JSON.stringify(proposal));
            return json(res, 200, { proposal });
          }

          const agent = proposal.agents.find((a) => a.name === body.agent);
          if (!agent) return json(res, 400, { error: `no agent "${String(body.agent)}" in the proposal` });

          // name and department are deliberately NOT editable: a rename here would orphan the
          // department lead and any playbook role naming this agent, which the user cannot see
          // from this screen. Picking a different template is the way to change structure.
          const PROSE = ["title", "charter", "persona", "prompt"] as const;
          if (typeof body.field === "string") {
            if (!(PROSE as readonly string[]).includes(body.field)) {
              return json(res, 400, { error: `field must be one of ${PROSE.join(", ")}` });
            }
            if (typeof body.value !== "string" || !body.value.trim()) {
              return json(res, 400, { error: `${body.field} required` });
            }
            agent[body.field as (typeof PROSE)[number]] = body.value.trim();
          } else if (Array.isArray(body.capabilities)) {
            if (body.capabilities.some((c) => typeof c !== "string")) {
              return json(res, 400, { error: "capabilities must be strings" });
            }
            agent.capabilities = body.capabilities as string[];
          } else if (Array.isArray(body.skills)) {
            if (body.skills.some((s) => typeof s !== "string")) {
              return json(res, 400, { error: "skills must be strings" });
            }
            agent.skills = body.skills as string[];
          } else {
            return json(res, 400, { error: "nothing to patch" });
          }
          // Unknown capability names are NOT rejected here — provision() re-validates every
          // field and reports them as card errors on this same screen.
          deps.store.kvSet(PROPOSAL_KEY, JSON.stringify(proposal));
          return json(res, 200, { proposal });
        }

        if (path === "/api/onboarding/interview" && req.method === "GET") {
          return json(res, 200, { turns: transcript() });
        }

        if (path === "/api/onboarding/interview/restart" && req.method === "POST") {
          if (wizard.current() !== "interview") {
            return json(res, 400, { error: `the interview runs at the interview step, not ${wizard.current()}` });
          }
          deps.store.kvSet(TRANSCRIPT_KEY, "[]");
          return json(res, 200, { turns: [] });
        }

        if (path === "/api/onboarding/interview" && req.method === "POST") {
          if (wizard.current() !== "interview") {
            return json(res, 400, { error: `the interview runs at the interview step, not ${wizard.current()}` });
          }
          const body = await readJson<{ message?: unknown }>(req);
          if (!body) return json(res, 400, { error: "body must be JSON" });
          const message = typeof body.message === "string" ? body.message.trim() : "";
          if (!message) return json(res, 400, { error: "message required" });

          const turns: Turn[] = [...transcript(), { role: "user", text: message }];
          let turn;
          try {
            turn = await interviewTurn(turns, architectContext(), ask);
          } catch (err) {
            // The user's message is NOT committed on failure: replaying a transcript whose last
            // turn got no answer would ask the model to respond to it twice.
            log(`interview turn failed: ${(err as Error).message}`);
            return json(res, 400, { error: (err as Error).message });
          }
          if (!turn.done) {
            deps.store.kvSet(TRANSCRIPT_KEY, JSON.stringify([...turns, { role: "architect", text: turn.question }]));
            return json(res, 200, { done: false, question: turn.question });
          }
          deps.store.kvSet(TRANSCRIPT_KEY, JSON.stringify(turns));
          deps.store.kvSet(PROPOSAL_KEY, JSON.stringify(withGrants(turn.proposal)));
          return transition(res, path, () => wizard.advance("interview"));
        }

        if (path === "/api/onboarding/redraft" && req.method === "POST") {
          const raw = deps.store.kvGet(PROPOSAL_KEY);
          if (!raw) return json(res, 404, { error: "no proposal yet" });
          const body = await readJson<{ agent?: unknown; note?: unknown }>(req);
          if (!body) return json(res, 400, { error: "body must be JSON" });
          const name = typeof body.agent === "string" ? body.agent : "";
          const note = typeof body.note === "string" ? body.note.trim() : "";
          if (!name) return json(res, 400, { error: "agent required" });
          const proposal = JSON.parse(raw) as OrgProposal;
          let drafted;
          try {
            drafted = await redraftAgent(proposal, name, note || "improve this agent", architectContext(), ask);
          } catch (err) {
            log(`redraft failed: ${(err as Error).message}`);
            return json(res, 400, { error: (err as Error).message });
          }
          proposal.agents = proposal.agents.map((a) => (a.name === name ? drafted : a));
          deps.store.kvSet(PROPOSAL_KEY, JSON.stringify(proposal));
          return json(res, 200, { proposal });
        }

        if (path === "/api/onboarding/regenerate" && req.method === "POST") {
          const turns = transcript();
          if (turns.length === 0) return json(res, 400, { error: "no interview to regenerate from" });
          let turn;
          try {
            turn = await interviewTurn(turns, architectContext(), ask);
          } catch (err) {
            log(`regenerate failed: ${(err as Error).message}`);
            return json(res, 400, { error: (err as Error).message });
          }
          // The Architect already had every answer once, so a question here means it changed its
          // mind about being finished — the user is on the review screen and has nowhere to put
          // a question, so treat it as a failed regenerate rather than reopening the interview.
          if (!turn.done) return json(res, 400, { error: "the Architect asked another question instead of redrafting" });
          deps.store.kvSet(PROPOSAL_KEY, JSON.stringify(withGrants(turn.proposal)));
          return json(res, 200, { proposal: withGrants(turn.proposal) });
        }

        if (path === "/api/onboarding/provision" && req.method === "POST") {
          const at = wizard.current();
          // Resume: a throw between writing the org and the two advances below leaves the wizard
          // here with an org already on disk. Within this process, not across a restart — a
          // restart with an org on disk comes up in normal mode (mode.ts) and never reaches this
          // server at all. Finishing is right; provisioning again would collide.
          if (at === "provision" && orgExists()) {
            await ensureBooted(); // a crash-resume must land on first-job with an engine too
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
          // The org exists either way; a boot failure surfaces through /api/state, not by
          // refusing the provision the user just approved.
          await ensureBooted();
          return json(res, 200, { step: wizard.current(), departments: result.departments, agents: result.agents });
        }

        if (path === "/api/onboarding/first-job" && req.method === "GET") {
          const s = jobState();
          const goals = world ? buildGoalsForOrigin(world.store, JOB_ORIGIN.channel, JOB_ORIGIN.chatId) : [];
          if (!s) return json(res, 200, { status: "idle", goals });
          return json(res, 200, { ...s, goals });
        }

        if (path === "/api/onboarding/first-job" && req.method === "POST") {
          // Same guard as the retry endpoint, for the same reason: booting with no org latches
          // `world` to a zero-agent daemon. Only probed when there is no world to reuse.
          if (!world && !orgExists()) return json(res, 409, { error: "no org yet — provision one first" });
          const w = await ensureBooted();
          if (!w) return json(res, 400, { error: bootError || "the daemon is not running yet" });
          const body = await readJson<{ request?: unknown }>(req);
          if (!body) return json(res, 400, { error: "body must be JSON" });
          const request = typeof body.request === "string" ? body.request.trim() : "";
          if (!request) return json(res, 400, { error: "request required" });

          // Checked and set with no await between the two, so two POSTs that interleave across
          // an await — a double-click, a second tab — cannot both get through. A second dispatch
          // would overwrite the first job's state and then settle onto the second's, reporting
          // `done` with the reply to a request the user has already superseded. Guarded the way
          // this server already guards its other one-at-a-time work: `verifying` on /auth, the
          // `booting` promise on the hot boot.
          // This prose is load-bearing: it shares its status code with the "no org yet" 409 that
          // opens this same handler, so ui2 tells the two apart by matching "first job is already
          // running" in the message — see `dispatchFailed` inside FirstJob in
          // ui2/src/views/Setup.tsx. One is a double-click to adopt, the other a real error to
          // show. Rewording this string silently turns a double-click back into an error the user
          // did not cause. Symbols, not line numbers: the numbers this comment used to carry both
          // rotted within the same branch that added them.
          if (dispatching) return json(res, 409, { error: "a first job is already running" });
          // Written before the flag goes up, and both are synchronous so the check-and-set stays
          // atomic. Order matters: kvSet can throw (SQLITE_BUSY), and raising the flag first would
          // leave it up with nothing dispatched to lower it — POST refusing every retry with 409
          // while GET reports idle, until the process restarts.
          setJobState({ status: "running", request });
          dispatching = true;
          // Taken before the coordinator is handed anything, so the diff on the other side is
          // "what appeared while this ran" and not "what the vault happens to contain".
          const vaultBefore = snapshotVault();
          // Deliberately not awaited: the coordinator can take minutes, and the browser polls GET
          // for progress. Wrapped rather than chained off handle() so a *synchronous* throw takes
          // the same failure path — otherwise it would escape to the 500 handler with kv already
          // on `running`, which is the stale-running wedge by another route.
          void (async () => {
            // moderator.handle() is normally reached through MessageRouter, and it is the ROUTER
            // that emits the billing pair — handle() only rides costUsd out. Calling it directly
            // here therefore bills nobody, which made the user's very first spend invisible on
            // the one screen that is meant to show the org working. Same shape as the standup,
            // planner and hand-off gaps: whoever calls a runner owns its agent.end.
            //
            // Resolved INSIDE the try, and the closing emit is swallowed, so no part of billing
            // can wedge the dispatch: anything thrown out here skips `finally` and leaves
            // `dispatching` up with nothing running, which 409s every retry until a restart.
            let billed: { agent: string; context: string } | undefined;
            try {
              billed = {
                agent: w.registry.coordinator,
                context: `chat:${JOB_ORIGIN.channel}:${JOB_ORIGIN.chatId}`,
              };
              w.bus.emit({ type: "agent.start", ...billed });
              const r = await w.moderator.handle(JOB_ORIGIN.channel, JOB_ORIGIN.chatId, request);
              w.bus.emit({
                type: "agent.end", ...billed, ok: true,
                ...(r.costUsd === undefined ? {} : { costUsd: r.costUsd }),
              });
              setJobState({
                status: "done", request, reply: r.text,
                wrote: newFiles(vaultBefore, snapshotVault()),
              });
            } catch (err) {
              // A throw means no result message arrived, so there is no cost to report — but the
              // pair must still close or the coordinator sticks at "working" in the org view.
              if (billed) {
                try { w.bus.emit({ type: "agent.end", ...billed, ok: false }); }
                catch { /* the ledger is not the job — never let it change the outcome */ }
              }
              log(`first job failed: ${(err as Error).message}`);
              setJobState({ status: "failed", request, error: (err as Error).message });
            } finally {
              // Unconditional: a state write that itself throws (SQLITE_BUSY) must still lower the
              // flag, or every later POST 409s against a job that will never settle.
              dispatching = false;
            }
          })().catch((err) => log(`first job state write failed: ${(err as Error).message}`));
          return json(res, 200, { status: "running" });
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
        // Same caching contract as the cockpit server: hashed assets immutable, the rest
        // revalidates — a stale index.html after a rebuild would resurrect wizard bugs.
        res.writeHead(200, {
          "Content-Type": MIME[extname(target)] ?? "text/html",
          "Cache-Control": target.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        });
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
