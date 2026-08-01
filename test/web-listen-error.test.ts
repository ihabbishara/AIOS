// test/web-listen-error.test.ts — mission control that cannot bind must say so, not die.
// A listen failure arrives as an asynchronous 'error' event, so a caller's try/catch around
// startWebServer never sees it, and an 'error' event with no listener is thrown by EventEmitter —
// with no uncaughtException handler anywhere in src/, that ends the process. The setup wizard's
// handover (src/onboarding/server.ts) binds this port microseconds after releasing it, which makes
// this the one caller for which a failed bind is an ordinary possibility rather than a theoretical.
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store/db.js";
import { startWebServer, type WebDeps } from "../src/web/server.js";

const waitFor = async (ok: () => boolean, what: string, ms = 3000) => {
  const until = Date.now() + ms;
  while (!ok() && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  if (!ok()) throw new Error(`timed out waiting for ${what}`);
};

describe("startWebServer when the port is already taken", () => {
  it("reports the failure instead of taking the daemon down", async () => {
    const squatter = createServer();
    squatter.listen(0, "127.0.0.1");
    await once(squatter, "listening");
    const port = (squatter.address() as AddressInfo).port;

    const prev = process.env.AIOS_UI_TOKEN;
    process.env.AIOS_UI_TOKEN = "listen-error-token";
    const logs: string[] = [];
    const deps = {
      store: new Store(":memory:"), goals: {}, vault: {},
      registry: { agents: new Map(), departments: new Map(), agentOf: new Map() },
      reloadPacks: () => {}, envPath: "", uiDist: "", log: (m: string) => logs.push(m),
      bus: { history: () => [] }, config: { dbPath: ":memory:" }, router: {}, gate: {},
      voice: { available: () => false }, mailbox: {},
    } as unknown as WebDeps;

    const server = startWebServer(deps, port);
    try {
      // Asserted before this test attaches anything of its own: `once(server, "error")` would
      // register a listener and make the throw go away, so waiting on the event first would pass
      // whether or not the server handles its own failure. The listener has to be the server's.
      expect(server.listenerCount("error")).toBe(1);

      await waitFor(() => logs.some((l) => l.includes("FATAL: mission control could not listen")),
        "the bind failure to be logged");
      expect(logs.some((l) => l.includes("EADDRINUSE"))).toBe(true);
      expect(server.listening).toBe(false);
    } finally {
      server.close();
      squatter.close();
      if (prev === undefined) delete process.env.AIOS_UI_TOKEN;
      else process.env.AIOS_UI_TOKEN = prev;
    }
  });
});
