// test/static-cache.test.ts — the SPA caching contract on BOTH servers. "A ui2 build is a
// deploy" is only true if the browser refetches: with no Cache-Control at all, heuristic
// caching kept serving a stale index.html (and so the old hashed bundle) after deploys —
// observed live 2026-08-21, a shipped Reader that the owner's browser refused to show.
// index.html (and any unhashed path) must revalidate; hashed /assets/* are immutable.
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Store } from "../src/store/db.js";
import { startWebServer, type WebDeps } from "../src/web/server.js";
import { startSetupServer } from "../src/onboarding/server.js";

function fakeDist(): string {
  const dist = mkdtempSync(join(tmpdir(), "cache-dist-"));
  writeFileSync(join(dist, "index.html"), "<html>app</html>");
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "assets", "index-HASH1234.js"), "console.log(1)");
  return dist;
}

let server: Server;
afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function headers(base: string, path: string, auth?: Record<string, string>) {
  const res = await fetch(`${base}${path}`, { headers: auth });
  expect(res.status).toBe(200);
  return res.headers.get("cache-control");
}

describe("static caching contract", () => {
  it("cockpit server: index revalidates, hashed assets are immutable", async () => {
    const prev = process.env.AIOS_UI_TOKEN;
    process.env.AIOS_UI_TOKEN = "tok-cache";
    try {
      const deps = {
        store: new Store(":memory:"), uiDist: fakeDist(), log: () => {},
        envPath: "", reloadPacks: () => {},
        bus: {}, config: {}, router: {}, gate: {}, voice: {},
      } as unknown as WebDeps;
      server = startWebServer(deps, 0);
      if (!server.listening) await once(server, "listening");
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const auth = { Authorization: "Bearer tok-cache" };
      expect(await headers(base, "/", auth)).toBe("no-cache");
      expect(await headers(base, "/assets/index-HASH1234.js", auth)).toBe("public, max-age=31536000, immutable");
      expect(await headers(base, "/goals", auth)).toBe("no-cache"); // SPA fallback = index
    } finally {
      if (prev === undefined) delete process.env.AIOS_UI_TOKEN; else process.env.AIOS_UI_TOKEN = prev;
    }
  });

  it("setup server: same contract", async () => {
    const dist = fakeDist();
    const m = new Map<string, string>();
    server = startSetupServer({
      store: { kvGet: (k: string) => m.get(k), kvSet: (k: string, v: string) => void m.set(k, v) },
      envPath: join(dist, ".env"), uiDist: dist, port: 0, ping: async () => {},
      agentsDir: join(dist, "agents"), playbooksDir: join(dist, "playbooks"),
      templatesDir: join(process.cwd(), "templates"),
    });
    if (!server.listening) await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await headers(base, "/")).toBe("no-cache");
    expect(await headers(base, "/assets/index-HASH1234.js")).toBe("public, max-age=31536000, immutable");
  });
});
