#!/usr/bin/env node
// src/index.ts — mode branch only. The normal-mode boot lives in boot.ts so the
// onboarding wizard can call it in-process after provisioning an org.
import { loadConfig } from "./config.js";
import { Store } from "./store/db.js";
import { bootMode } from "./onboarding/mode.js";
import { startSetupServer } from "./onboarding/server.js";
import { bootNormal, log } from "./boot.js";

async function main(): Promise<void> {
  // The one process-level net. Node exits on an unhandled rejection, and a library's
  // fire-and-forget promise can reject for reasons nothing in this codebase can catch:
  // @slack/socket-mode's reconnect attempts did exactly that (reason `undefined`) and took
  // the daemon down three times. An always-on daemon that logs a bug beats one that restarts
  // and hides it — and launchd's restart disabled the very channel that was reconnecting.
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    log(`UNHANDLED REJECTION (daemon continues): ${detail}`);
  });

  const config = loadConfig();

  // Setup mode (onboarding spec §1): no auth or no org → wizard only.
  // Nothing that assumes an org may start — no channels, heartbeat, senses, or packs.
  // The wizard boots the rest in-process once it has provisioned one (see boot.ts).
  // Deliberately unguarded: countAgentManifests already skips entries it cannot read, so a
  // throw here means agentsDir itself is unreadable. Crashing restarts (and gets noticed);
  // falling back to the wizard would hand a live install to onboarding until someone looks.
  const mode = bootMode(process.env, config.agentsDir);
  if (mode === "setup") {
    const store = new Store(config.dbPath);
    startSetupServer({
      store, envPath: config.envPath, uiDist: config.uiDist, port: config.uiPort,
      agentsDir: config.agentsDir, playbooksDir: config.playbooksDir, templatesDir: config.templatesDir,
      boot: () => bootNormal({ startWeb: false }),
      log,
    });
    log(`setup mode: open http://localhost:${config.uiPort} to begin onboarding`);
    return;
  }

  await bootNormal({ startWeb: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
