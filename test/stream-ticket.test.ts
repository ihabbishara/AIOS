// test/stream-ticket.test.ts — SSE auth via a short-lived one-time ticket, not a token in the URL.
import { describe, it, expect } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store/db.js";
import { startWebServer, type WebDeps } from "../src/web/server.js";

const TOKEN = "stream-test-token";

async function startTestServer() {
  const prev = process.env.AIOS_UI_TOKEN;
  process.env.AIOS_UI_TOKEN = TOKEN;
  const store = new Store(":memory:");
  const deps = {
    store, goals: {}, vault: {}, registry: { agents: new Map(), departments: new Map(), agentOf: new Map() },
    reloadPacks: () => {}, envPath: "", uiDist: "", log: () => {},
    bus: { history: () => [], on: () => () => {} }, config: { dbPath: ":memory:" }, router: {}, gate: {},
    voice: { available: () => false }, mailbox: {},
  } as unknown as WebDeps;
  const server = startWebServer(deps, 0);
  if (!server.listening) await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    auth: { Authorization: `Bearer ${TOKEN}` } as Record<string, string>,
    close: async () => {
      server.closeAllConnections?.(); // force-drop any lingering keep-alive/SSE socket
      await new Promise<void>((r) => server.close(() => r()));
      if (prev === undefined) delete process.env.AIOS_UI_TOKEN; else process.env.AIOS_UI_TOKEN = prev;
    },
  };
}

describe("SSE stream ticket", () => {
  it("issues only with header auth, opens the stream once, and rejects the leak/replay paths", async () => {
    const t = await startTestServer();
    try {
      // issuance is header-authed
      expect((await fetch(`${t.base}/api/stream-ticket`)).status).toBe(401);
      const r = await fetch(`${t.base}/api/stream-ticket`, { headers: t.auth });
      expect(r.status).toBe(200);
      const { ticket } = (await r.json()) as { ticket: string };
      expect(ticket).toBeTruthy();

      // the old token-in-URL auth path is gone → a token in the query no longer authenticates
      const leak = await fetch(`${t.base}/api/stream?token=${TOKEN}`);
      expect(leak.status).toBe(401);
      await leak.body?.cancel();

      // a bogus ticket is rejected
      const bogus = await fetch(`${t.base}/api/stream?ticket=not-a-real-ticket`);
      expect(bogus.status).toBe(401);
      await bogus.body?.cancel();

      // spend the ticket by hitting the stream (the gate consumes it synchronously on arrival —
      // aborting the SSE read fast is fine, the ticket is already spent server-side)
      await fetch(`${t.base}/api/stream?ticket=${ticket}`, { signal: AbortSignal.timeout(400) }).catch(() => {});
      // …so a replay with the same ticket is now rejected (single-use)
      const replay = await fetch(`${t.base}/api/stream?ticket=${ticket}`);
      expect(replay.status).toBe(401);
      await replay.body?.cancel();
    } finally {
      await t.close();
    }
  });
});
