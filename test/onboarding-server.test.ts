// test/onboarding-server.test.ts — wizard HTTP walk: welcome → auth → workspace (spec §1-2).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { startSetupServer } from "../src/onboarding/server.js";

function kv() {
  const m = new Map<string, string>();
  return { kvGet: (k: string) => m.get(k), kvSet: (k: string, v: string) => void m.set(k, v) };
}

let server: Server;
afterEach(() => server?.close());

async function boot(ping: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "setup-"));
  writeFileSync(join(dir, "index.html"), "<html>wizard</html>");
  const envPath = join(dir, ".env");
  server = startSetupServer({ store: kv(), envPath, uiDist: dir, port: 0, ping });
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, envPath };
}

describe("setup server", () => {
  it("walks welcome → auth → workspace over HTTP, persisting the token", async () => {
    const { base, envPath } = await boot(async () => {});
    let r = await fetch(`${base}/api/state`);
    expect(await r.json()).toEqual({ mode: "setup", step: "welcome" });

    r = await fetch(`${base}/api/onboarding/advance`, {
      method: "POST", body: JSON.stringify({ from: "welcome" }),
    });
    expect((await r.json()).step).toBe("auth");

    r = await fetch(`${base}/api/onboarding/auth`, {
      method: "POST", body: JSON.stringify({ token: "tok-123" }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("workspace");
    expect(readFileSync(envPath, "utf8")).toContain("CLAUDE_CODE_OAUTH_TOKEN=tok-123");
  });

  it("surfaces ping failure as 400 and does not advance or write env", async () => {
    const { base, envPath } = await boot(async () => { throw new Error("401 bad token"); });
    await fetch(`${base}/api/onboarding/advance`, { method: "POST", body: JSON.stringify({ from: "welcome" }) });
    const r = await fetch(`${base}/api/onboarding/auth`, {
      method: "POST", body: JSON.stringify({ token: "bad" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("401 bad token");
    const s = await (await fetch(`${base}/api/state`)).json();
    expect(s.step).toBe("auth");
    expect(() => readFileSync(envPath, "utf8")).toThrow(); // never written
  });

  it("refuses to skip auth via the generic advance", async () => {
    const { base } = await boot(async () => {});
    await fetch(`${base}/api/onboarding/advance`, { method: "POST", body: JSON.stringify({ from: "welcome" }) });
    const r = await fetch(`${base}/api/onboarding/advance`, { method: "POST", body: JSON.stringify({ from: "auth" }) });
    expect(r.status).toBe(400);
  });

  it("serves the SPA with index.html fallback", async () => {
    const { base } = await boot(async () => {});
    expect(await (await fetch(`${base}/`)).text()).toContain("wizard");
    expect(await (await fetch(`${base}/some/route`)).text()).toContain("wizard");
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  // A junk `from`/`to` must be rejected by the route, not by a Wizard throw — the wizard's
  // error is the fallback, not the validation layer.
  it("rejects a body whose step is not a wizard step", async () => {
    const { base } = await boot(async () => {});
    const adv = await fetch(`${base}/api/onboarding/advance`, {
      method: "POST", body: JSON.stringify({ from: "../../etc/passwd" }),
    });
    expect(adv.status).toBe(400);
    expect((await adv.json()).error).toContain("wizard step");
    const back = await fetch(`${base}/api/onboarding/back`, {
      method: "POST", body: JSON.stringify({ to: 7 }),
    });
    expect(back.status).toBe(400);
    expect((await back.json()).error).toContain("wizard step");
  });

  it("goes back to an earlier step", async () => {
    const { base } = await boot(async () => {});
    await fetch(`${base}/api/onboarding/advance`, { method: "POST", body: JSON.stringify({ from: "welcome" }) });
    const r = await fetch(`${base}/api/onboarding/back`, { method: "POST", body: JSON.stringify({ to: "welcome" }) });
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("welcome");
  });

  // verifyToken mutates process-global env, so two verifications must never interleave.
  it("rejects a second concurrent auth with 409 while one is in flight", async () => {
    let enteredPing!: () => void;
    let releasePing!: () => void;
    const entered = new Promise<void>((r) => { enteredPing = r; });
    const released = new Promise<void>((r) => { releasePing = r; });
    const { base } = await boot(async () => { enteredPing(); await released; });

    await fetch(`${base}/api/onboarding/advance`, { method: "POST", body: JSON.stringify({ from: "welcome" }) });
    const first = fetch(`${base}/api/onboarding/auth`, { method: "POST", body: JSON.stringify({ token: "tok-1" }) });
    await entered; // the server is now inside verifyToken

    const second = await fetch(`${base}/api/onboarding/auth`, { method: "POST", body: JSON.stringify({ token: "tok-2" }) });
    expect(second.status).toBe(409);

    releasePing();
    const done = await first;
    expect(done.status).toBe(200);
    expect((await done.json()).step).toBe("workspace");
  });
});
