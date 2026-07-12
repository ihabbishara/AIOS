// test/health-endpoint.test.ts
import { describe, it, expect } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store/db.js";
import { startWebServer, type WebDeps } from "../src/web/server.js";

const TOKEN = "health-test-token";

async function startTestServer(extra: Partial<WebDeps>) {
  const prev = process.env.AIOS_UI_TOKEN;
  process.env.AIOS_UI_TOKEN = TOKEN;
  const store = new Store(":memory:");
  const deps = {
    store, goals: {}, vault: {}, registry: { agents: new Map(), departments: new Map(), agentOf: new Map() },
    reloadPacks: () => {}, envPath: "", uiDist: "", log: () => {},
    bus: {}, config: { dbPath: ":memory:" }, router: {}, gate: {},
    voice: { available: () => false }, mailbox: {},
    ...extra,
  } as unknown as WebDeps;
  const server = startWebServer(deps, 0);
  if (!server.listening) await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    auth: { Authorization: `Bearer ${TOKEN}` } as Record<string, string>,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      if (prev === undefined) delete process.env.AIOS_UI_TOKEN; else process.env.AIOS_UI_TOKEN = prev;
    },
  };
}

describe("GET /api/health", () => {
  it("serves uptime, voice, senses, sse count, db size", async () => {
    const t = await startTestServer({
      senses: () => [
        { name: "gmail:personal", ok: true },
        { name: "bunq", ok: false, reason: "re-auth needed" },
      ],
    });
    try {
      const res = await fetch(`${t.base}/api/health`, { headers: t.auth });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(body.voice).toBe(false);
      expect(body.senses).toEqual([
        { name: "gmail:personal", ok: true },
        { name: "bunq", ok: false, reason: "re-auth needed" },
      ]);
      expect(body.sseClients).toBe(0);
      expect(body.dbBytes).toBeGreaterThanOrEqual(0);
    } finally {
      await t.close();
    }
  });

  it("omitted senses provider → empty array", async () => {
    const t = await startTestServer({});
    try {
      const body = await (await fetch(`${t.base}/api/health`, { headers: t.auth })).json();
      expect(body.senses).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("is token-gated like every /api route", async () => {
    const t = await startTestServer({});
    try {
      const res = await fetch(`${t.base}/api/health`);
      expect(res.status).toBe(401);
    } finally {
      await t.close();
    }
  });
});
