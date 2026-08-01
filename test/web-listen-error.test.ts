// test/web-listen-error.test.ts — what happens when mission control cannot take its port.
// A listen failure arrives as an asynchronous 'error' event, so a caller's try/catch around
// startWebServer never sees it, and an 'error' event with no listener is thrown by EventEmitter —
// with no uncaughtException handler anywhere in src/, that ends the process.
//
// The two callers need opposite outcomes, which is what these pin. At startup a taken port means
// another daemon already owns this install: there is no pidfile or lockfile anywhere, so exiting
// is the only thing keeping a second, headless daemon off the same database. The setup wizard's
// handover (src/onboarding/server.ts) is the reverse — it binds a port it released microseconds
// earlier, and a failure there must not kill the process the user is still talking to.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store/db.js";
import { startWebServer, exitOnListenError, type WebDeps } from "../src/web/server.js";

afterEach(() => vi.restoreAllMocks());

const waitFor = async (ok: () => boolean, what: string, ms = 3000) => {
  const until = Date.now() + ms;
  while (!ok() && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  if (!ok()) throw new Error(`timed out waiting for ${what}`);
};

function fakeDeps(log: (m: string) => void): WebDeps {
  return {
    store: new Store(":memory:"), goals: {}, vault: {},
    registry: { agents: new Map(), departments: new Map(), agentOf: new Map() },
    reloadPacks: () => {}, envPath: "", uiDist: "", log,
    bus: { history: () => [] }, config: { dbPath: ":memory:" }, router: {}, gate: {},
    voice: { available: () => false }, mailbox: {},
  } as unknown as WebDeps;
}

/** A port nobody else can have, held for the length of the test. */
async function takenPort() {
  const squatter = createServer();
  squatter.listen(0, "127.0.0.1");
  await once(squatter, "listening");
  return { port: (squatter.address() as AddressInfo).port, release: () => squatter.close() };
}

describe("startWebServer when the port is already taken", () => {
  it("logs and leaves the process alive when no handler is given", async () => {
    const { port, release } = await takenPort();
    const logs: string[] = [];
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const server = startWebServer(fakeDeps((m) => logs.push(m)), port);
    try {
      // Asserted before this test attaches anything of its own: `once(server, "error")` would
      // register a listener and make the throw go away, so waiting on the event first would pass
      // whether or not the server handles its own failure. The listener has to be the server's.
      expect(server.listenerCount("error")).toBe(1);

      await waitFor(() => logs.some((l) => l.includes("could not listen")), "the bind failure");
      expect(logs.some((l) => l.includes("FATAL") && l.includes("EADDRINUSE"))).toBe(true);
      expect(server.listening).toBe(false);
      // The handover's requirement: mission control is down, the wizard's process is not.
      expect(exit).not.toHaveBeenCalled();
    } finally {
      server.close();
      release();
    }
  });

  it("exits when the startup owner's handler is given", async () => {
    const { port, release } = await takenPort();
    const logs: string[] = [];
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const server = startWebServer(
      fakeDeps((m) => logs.push(m)), port, exitOnListenError((m) => logs.push(m)),
    );
    try {
      await waitFor(() => exit.mock.calls.length > 0, "the daemon to exit");
      expect(exit).toHaveBeenCalledWith(1);
      // The reason, not just the exit: this is the only "another daemon is already running"
      // signal the product has, and it is what someone reads out of the launchd log.
      expect(logs.some((l) => l.includes("already holding that port"))).toBe(true);
      expect(logs.some((l) => l.includes("run headless against the same database"))).toBe(true);
    } finally {
      server.close();
      release();
    }
  });

  it("does not mistake a post-bind error for a bind failure, or exit on one", async () => {
    const logs: string[] = [];
    const onListenError = vi.fn();
    const server = startWebServer(fakeDeps((m) => logs.push(m)), 0, onListenError);
    await once(server, "listening");
    try {
      // Synthetic, because http.Server rarely emits one — but the handler is registered for the
      // server's whole life, so anything arriving after the bind reaches it. Reporting that as
      // "could not listen" would be wrong, and handing it to the startup owner's handler would
      // take a healthy daemon down over an error that has nothing to do with the port.
      server.emit("error", new Error("boom"));
      expect(logs.some((l) => l.includes("after bind") && l.includes("boom"))).toBe(true);
      expect(logs.some((l) => l.includes("could not listen"))).toBe(false);
      expect(onListenError).not.toHaveBeenCalled();
      expect(server.listening).toBe(true);
    } finally {
      server.close();
    }
  });
});
