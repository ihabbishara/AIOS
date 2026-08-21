// test/onboarding-workspace.test.ts — workspace path resolution and its endpoint (spec §2).
import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join as pjoin } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { Server } from "node:http";
import { resolveWorkspace } from "../src/onboarding/workspace.js";
import { startSetupServer, type SetupDeps } from "../src/onboarding/server.js";

const HOME = "/Users/tester";

describe("resolveWorkspace", () => {
  it("defaults builtin to ~/AIOS/workspace with subdir AIOS", () => {
    const r = resolveWorkspace({ mode: "builtin" }, HOME);
    expect(r).toEqual({ ok: true, path: "/Users/tester/AIOS/workspace", subdir: "AIOS" });
  });

  it("expands a leading tilde in a custom path", () => {
    const r = resolveWorkspace({ mode: "custom", path: "~/Vaults/Brain", subdir: "AIOS" }, HOME);
    expect(r).toMatchObject({ ok: true, path: "/Users/tester/Vaults/Brain", subdir: "AIOS" });
  });

  it("requires a path in custom mode", () => {
    expect(resolveWorkspace({ mode: "custom", subdir: "AIOS" }, HOME))
      .toEqual({ ok: false, error: "a workspace path is required" });
  });

  it("rejects a relative custom path", () => {
    expect(resolveWorkspace({ mode: "custom", path: "notes/vault" }, HOME))
      .toEqual({ ok: false, error: "workspace path must be absolute or start with ~" });
  });

  it("defaults a blank subdir to AIOS rather than writing to the vault root", () => {
    const r = resolveWorkspace({ mode: "custom", path: "/data/vault", subdir: "  " }, HOME);
    expect(r).toMatchObject({ ok: true, subdir: "AIOS" });
  });

  it("rejects a subdir that would escape the vault", () => {
    expect(resolveWorkspace({ mode: "custom", path: "/data/vault", subdir: "../etc" }, HOME))
      .toEqual({ ok: false, error: "subdir must be a single folder name" });
  });

  // The separator clause alone catches "../etc", so these separator-free forms are what prove
  // the guard is an allowlist. "." is the dangerous one: join(vault, ".") is the vault root.
  it("rejects separator-free subdirs that are not a plain folder name", () => {
    for (const subdir of [".", " . ", "..", " .. ", "~", ".hidden", "-flag", "a\0b"]) {
      expect(resolveWorkspace({ mode: "custom", path: "/data/vault", subdir }, HOME))
        .toStrictEqual({ ok: false, error: "subdir must be a single folder name" });
    }
  });

  it("keeps a caller-supplied subdir instead of always writing to AIOS", () => {
    expect(resolveWorkspace({ mode: "custom", path: "/data/vault", subdir: "Brain" }, HOME))
      .toStrictEqual({ ok: true, path: "/data/vault", subdir: "Brain" });
    expect(resolveWorkspace({ mode: "builtin", subdir: "Brain" }, HOME))
      .toStrictEqual({ ok: true, path: "/Users/tester/AIOS/workspace", subdir: "Brain" });
  });

  // "2026-notes" is the one that earns its place: every other name here leads with a letter, so
  // narrowing the leading class to \p{L} alone leaves them all green while a perfectly ordinary
  // dated folder starts being refused.
  it("allows ordinary folder names with spaces, dots, digits and dashes", () => {
    for (const subdir of ["My Vault", "notes-2026", "2026-notes", "v1.2", "AIOS"]) {
      expect(resolveWorkspace({ mode: "custom", path: "/data/vault", subdir }, HOME))
        .toStrictEqual({ ok: true, path: "/data/vault", subdir });
    }
  });

  // The guard is an allowlist for its reject-by-default shape, not because AIOS is ASCII-only:
  // a subdir names a real folder the user has to live with in Finder.
  it("keeps a non-ASCII subdir verbatim", () => {
    for (const subdir of ["メモ", "Übersicht"]) {
      expect(resolveWorkspace({ mode: "custom", path: "/data/vault", subdir }, HOME))
        .toStrictEqual({ ok: true, path: "/data/vault", subdir });
    }
  });

  // macOS normalizes filenames to NFD, so the same name typed into the wizard (NFC) and pasted
  // from a Finder path (NFD) are different strings that look identical. Both must be accepted;
  // rejecting one is invisible to the user. Built with normalize() rather than pasted decomposed
  // bytes, which would be unreadable here and could be silently recomposed by an editor.
  it("accepts a decomposed (NFD) name as readily as its composed form", () => {
    const nfc = "Übersicht".normalize("NFC");
    const nfd = "Übersicht".normalize("NFD");
    expect(nfd).not.toBe(nfc);                       // the test is exercising a real decomposition
    expect(nfd.length).toBeGreaterThan(nfc.length);  // "Ü" split into "U" + combining diaeresis
    for (const subdir of [nfc, nfd]) {
      expect(resolveWorkspace({ mode: "custom", path: "/data/vault", subdir }, HOME))
        .toStrictEqual({ ok: true, path: "/data/vault", subdir });
    }
  });

  // Widening to \p{L}\p{N}\p{M} must not weaken the leading-character rule: "・" is punctuation
  // rather than a letter, and a leading dot is still a leading dot in any script. The bare
  // combining diaeresis is the other half of that widening — written as an escape because a
  // leading mark renders as a stray accent on whatever precedes it in an editor. \p{M} belongs
  // in the trailing class only, and adding it to the leading one is a mutation nothing else here
  // would catch.
  it("still rejects non-ASCII names that are not a letter or digit first", () => {
    for (const subdir of ["・", ".メモ", "\u0308", "\u0308bersicht"]) {
      expect(resolveWorkspace({ mode: "custom", path: "/data/vault", subdir }, HOME))
        .toStrictEqual({ ok: false, error: "subdir must be a single folder name" });
    }
  });

  it("expands a bare tilde to the home directory", () => {
    expect(resolveWorkspace({ mode: "custom", path: "~" }, HOME))
      .toStrictEqual({ ok: true, path: "/Users/tester", subdir: "AIOS" });
  });

  it("refuses ~user forms rather than inventing a path under our own home", () => {
    for (const path of ["~user/foo", "~x", "~~"]) {
      expect(resolveWorkspace({ mode: "custom", path }, HOME))
        .toStrictEqual({ ok: false, error: "only ~/ is supported — write the full path instead" });
    }
  });

  it("warns on cloud-synced paths without blocking them", () => {
    for (const p of [
      "/Users/tester/Library/Mobile Documents/com~apple~CloudDocs/Vault",
      "/Users/tester/Dropbox/Vault",
      "/Users/tester/Google Drive/Vault",
      "/Users/tester/OneDrive/Vault",
      // Since Ventura macOS mounts Drive and Box here; "GoogleDrive-" has no space, so the
      // "Google Drive" alternative alone does not see them.
      "/Users/tester/Library/CloudStorage/GoogleDrive-a@b.com/My Drive/Vault",
      "/Users/tester/Library/CloudStorage/Box-Box/Vault",
    ]) {
      const r = resolveWorkspace({ mode: "custom", path: p }, HOME);
      expect(r.ok).toBe(true);
      expect((r as { warning?: string }).warning).toMatch(/sync/i);
    }
  });

  // toStrictEqual, not toEqual: toEqual ignores undefined-valued keys, so it would pass against
  // `warning: undefined` and fail to pin the "no warning key at all" contract Task 3 reads.
  it("does not warn on an ordinary path", () => {
    const r = resolveWorkspace({ mode: "custom", path: "/Users/tester/Notes" }, HOME);
    expect(r).toStrictEqual({ ok: true, path: "/Users/tester/Notes", subdir: "AIOS" });
  });
});

function kv() {
  const m = new Map<string, string>();
  return { kvGet: (k: string) => m.get(k), kvSet: (k: string, v: string) => void m.set(k, v) };
}

let server: Server;
// Restored, not just closed: the endpoint sets AIOS_VAULT_* on process.env on purpose, and a
// leaked value would be read by loadConfig() in any test sharing this worker. The chmod list
// exists so a deliberately unwritable fixture cannot outlive its test (or block tmp cleanup).
const locked: string[] = [];
const savedEnv = { path: process.env.AIOS_VAULT_PATH, subdir: process.env.AIOS_VAULT_SUBDIR };
afterEach(() => {
  server?.close();
  while (locked.length) chmodSync(locked.pop()!, 0o700);
  for (const [k, v] of [["AIOS_VAULT_PATH", savedEnv.path], ["AIOS_VAULT_SUBDIR", savedEnv.subdir]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** chmod is advisory for root and a no-op on Windows, so the unwritable fixtures would pass
 *  for the wrong reason there — better skipped than green. */
const CAN_LOCK = process.platform !== "win32" && process.getuid?.() !== 0;

/** Makes `dir` read+execute only, so writes inside it fail with EACCES for the duration. */
function lock(dir: string): string {
  chmodSync(dir, 0o500);
  locked.push(dir);
  return dir;
}

async function boot(over: Partial<SetupDeps> = {}) {
  const dir = mkdtempSync(pjoin(tmpdir(), "ws-"));
  const store = kv();
  store.kvSet("onboarding.step", "workspace");
  server = startSetupServer({
    store, envPath: pjoin(dir, ".env"), uiDist: dir, port: 0,
    agentsDir: pjoin(dir, "agents"), playbooksDir: pjoin(dir, "playbooks"),
    templatesDir: pjoin(process.cwd(), "templates"),
    ping: async () => {},
    ...over,
  });
  await new Promise((r) => server.once("listening", r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, dir };
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/api/onboarding/workspace`, { method: "POST", body: JSON.stringify(body) });

const BUILTIN = pjoin(homedir(), "AIOS", "workspace");

describe("POST /api/onboarding/workspace", () => {
  it("advances on builtin, recording the built-in path rather than nothing", async () => {
    const { base, dir } = await boot();
    const r = await post(base, { mode: "builtin" });
    expect(r.status).toBe(200);
    expect(await r.json()).toStrictEqual({ step: "connect" });
    // config.ts already defaults to this path, so the write looks redundant — it is not; see
    // the back-navigation test below, where not writing it strands the daemon on a rejected
    // folder. Nothing is probed or created here: that path belongs to the daemon, and a probe
    // would mkdir in the real home directory of whoever runs this suite.
    const env = readFileSync(pjoin(dir, ".env"), "utf8");
    expect(env).toContain(`AIOS_VAULT_PATH=${BUILTIN}`);
    expect(env).toContain("AIOS_VAULT_SUBDIR=AIOS");
    expect(process.env.AIOS_VAULT_PATH).toBe(BUILTIN);
  });

  // The sequence the review found: a sync warning, "Pick another folder", then the built-in
  // workspace. With the env write gated on custom, .env still named the Dropbox folder the user
  // had just declined, and Task 4's in-process boot would write the org's artifacts into it.
  it("clears a rejected custom path when the user falls back to builtin", async () => {
    const { base, dir } = await boot();
    const synced = pjoin(dir, "Dropbox", "Vault");
    const first = await post(base, { mode: "custom", path: synced, subdir: "Brain" });
    expect((await first.json()).warning).toMatch(/sync/i);
    const back = await fetch(`${base}/api/onboarding/back`, {
      method: "POST", body: JSON.stringify({ to: "workspace" }),
    });
    expect(back.status).toBe(200);
    expect((await post(base, { mode: "builtin" })).status).toBe(200);

    const env = readFileSync(pjoin(dir, ".env"), "utf8");
    expect(env).toContain(`AIOS_VAULT_PATH=${BUILTIN}`);
    expect(env).toContain("AIOS_VAULT_SUBDIR=AIOS");
    expect(env).not.toContain(synced);          // upserted, not appended alongside
    expect(env).not.toContain("Brain");
    expect(process.env.AIOS_VAULT_PATH).toBe(BUILTIN);
    expect(process.env.AIOS_VAULT_SUBDIR).toBe("AIOS");
  });

  it("creates the directory and writes env for a custom path", async () => {
    const { base, dir } = await boot();
    const target = pjoin(dir, "my vault");
    const r = await post(base, { mode: "custom", path: target, subdir: "Brain" });
    expect(r.status).toBe(200);
    expect(await r.json()).toStrictEqual({ step: "connect" }); // no warning key on a plain path
    expect(existsSync(target)).toBe(true);
    const env = readFileSync(pjoin(dir, ".env"), "utf8");
    expect(env).toContain(`AIOS_VAULT_PATH=${target}`);
    expect(env).toContain("AIOS_VAULT_SUBDIR=Brain");
    // The daemon reads process.env, not the file it just wrote (config.ts:208-209), and the
    // hot boot happens in this same process — so the file alone would boot the old path.
    expect(process.env.AIOS_VAULT_PATH).toBe(target);
    expect(process.env.AIOS_VAULT_SUBDIR).toBe("Brain");
  });

  it("leaves no probe file behind", async () => {
    const { base, dir } = await boot();
    const target = pjoin(dir, "probe-check");
    await post(base, { mode: "custom", path: target });
    // The probe runs inside <path>/<subdir> because that is where the daemon writes, so the
    // subdir is the one thing that legitimately remains; the probe file itself must not.
    expect(readdirSync(target)).toEqual(["AIOS"]);
    expect(readdirSync(pjoin(target, "AIOS"))).toEqual([]);
  });

  it("returns the sync warning alongside the step", async () => {
    const { base, dir } = await boot();
    const r = await post(base, { mode: "custom", path: pjoin(dir, "Dropbox", "Vault") });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.step).toBe("connect");
    expect(body.warning).toMatch(/sync/i); // advisory: it advanced anyway
  });

  it.skipIf(!CAN_LOCK)("400s when the workspace cannot be created and does not advance", async () => {
    const { base, dir } = await boot();
    const target = pjoin(lock(mkdtempSync(pjoin(tmpdir(), "ro-"))), "vault");
    const r = await post(base, { mode: "custom", path: target });
    expect(r.status).toBe(400);
    // Pinned to the probe's own message: a bare "400 with some error" would also pass on a
    // rejected body or a wrong-step guard, neither of which is what this test is about.
    // String checks, not a regex: a macOS temp path can contain "+", which is a quantifier.
    const err = (await r.json()).error as string;
    expect(err.startsWith(`cannot write to ${target}`)).toBe(true);
    expect(err).toContain("EACCES");
    expect(existsSync(target)).toBe(false);
    expect((await (await fetch(`${base}/api/state`)).json()).step).toBe("workspace");
    expect(existsSync(pjoin(dir, ".env"))).toBe(false);
  });

  // The case the probe exists for: mkdir on an existing directory succeeds, so only an actual
  // write proves the daemon can put an artifact there.
  it.skipIf(!CAN_LOCK)("400s when the workspace exists but is not writable", async () => {
    const { base } = await boot();
    const target = mkdtempSync(pjoin(tmpdir(), "ro-"));
    mkdirSync(pjoin(target, "AIOS"));
    lock(pjoin(target, "AIOS"));
    const r = await post(base, { mode: "custom", path: target });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/EACCES/);
    expect((await (await fetch(`${base}/api/state`)).json()).step).toBe("workspace");
  });

  // Carried finding O-4: the subdir guard is a shape rule with no length bound, and NAME_MAX
  // stops well short of 1000. The probe is what converts that into a 400 the user can act on
  // rather than an ENAMETOOLONG at the daemon's first write, long after this screen is gone.
  it("400s on a subdir no filesystem can hold, and does not advance", async () => {
    const { base, dir } = await boot();
    const target = pjoin(dir, "vault");
    const r = await post(base, { mode: "custom", path: target, subdir: "a".repeat(1000) });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/ENAMETOOLONG/);
    expect((await (await fetch(`${base}/api/state`)).json()).step).toBe("workspace");
    expect(existsSync(pjoin(dir, ".env"))).toBe(false);
    expect(process.env.AIOS_VAULT_SUBDIR).toBeUndefined();
  });

  // On the message, not just the code, and with a case that carries a path: `{mode:"elsewhere"}`
  // alone 400s through the resolver's "a workspace path is required" even with the mode guard
  // deleted, so a status-only assertion here stays green while `{mode:"elsewhere", path}` quietly
  // becomes a custom workspace and advances.
  it("rejects a body that is not a workspace choice", async () => {
    const { base, dir } = await boot();
    for (const body of [{ mode: "elsewhere" }, { mode: "elsewhere", path: pjoin(dir, "ghost") }, { path: pjoin(dir, "ghost") }]) {
      const r = await post(base, body);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(/mode must be builtin or custom/);
    }
    const raw = await fetch(`${base}/api/onboarding/workspace`, { method: "POST", body: "{" });
    expect(raw.status).toBe(400);
    expect((await raw.json()).error).toMatch(/body must be JSON/);
    expect(existsSync(pjoin(dir, "ghost"))).toBe(false);
    expect(existsSync(pjoin(dir, ".env"))).toBe(false);
    expect((await (await fetch(`${base}/api/state`)).json()).step).toBe("workspace");
  });

  it("refuses when the wizard is not at the workspace step", async () => {
    const { base } = await boot();
    await post(base, { mode: "builtin" });
    const r = await post(base, { mode: "builtin" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/not connect/);
  });
});
