# Value Path — Workspace, First Job, Library — Implementation Plan

> ## ⛔ DO NOT EXECUTE — COMPLETE
>
> All nine tasks were executed on 2026-08-01 (branch `worktree-value-path-first-job`, 22 commits from `09ad6a9`). Merged state, final review verdict READY. **This file is a record, not a work item.**
>
> **The code snippets below are wrong in at least fifteen places, deliberately left un-back-edited.** Executing this plan would re-introduce defects the execution found and fixed. Read the "Execution outcome" section at the bottom for what actually shipped and why it differs.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the onboarding wizard actually run the org's first job, so a new user reaches the locked aha — first job completes end to end — without ever restarting the daemon.

**Architecture:** `main()`'s normal-mode body is extracted verbatim into a callable `bootNormal()` that returns a `BootedWorld` handle with a deferred `startWeb()`. After the wizard provisions an org it calls `bootNormal({ startWeb: false })` in-process, dispatches the first job through `moderator.handle` (the coordinator picks its own tool), and keeps serving :4280 unauthenticated until the `done` step hands the browser the UI token and yields the port to the real web server.

**Tech Stack:** TypeScript (ESM, NodeNext), Node's built-in `node:http` and `node:sqlite`, vitest, React 19 + Vite + Tailwind in `ui2/`.

**Spec:** `docs/superpowers/specs/2026-08-01-value-path-first-job-design.md`

## Global Constraints

- **Subscription auth only.** `CLAUDE_CODE_OAUTH_TOKEN`, never `ANTHROPIC_API_KEY`. Do not run `claude setup-token` — that is user-only.
- **Read the "Tests" line, never exit codes.** `npx vitest run` can exit non-zero on unrelated noise. Baseline before this plan: **210 files / 1721 pass + 2 skipped**.
- **Also check for an `Errors` line.** An unhandled rejection leaves the `Tests` line fully green and reports separately as `Errors 1 error`. Found the hard way in Task 5: dropping a `.catch` was invisible to the Tests line alone. A green `Tests` line with an `Errors` line is a failure.
- **Anchor mutation edits uniquely.** A `perl -0pi -e 's/…/…/'` substitutes only the first match in the file, which is often not the code under test — and a mutation that never landed reports green, indistinguishable from one the tests failed to catch. Match on two lines, or confirm the intended line changed before re-running.
- **Typecheck is two commands:** `npx tsc --noEmit` at the repo root AND `cd ui2 && npm run typecheck`. Both must be clean. (`cd ui2 && npm run build` is `vite build` and does NOT typecheck — never use it as verification.)
- **There are TWO test suites.** `npx vitest run` at the root does NOT include ui2's. `cd ui2 && npm test` runs a separate jsdom suite (16 files / 59 tests as of Task 6). Any task touching `ui2/` must run and report both.
- **Never run a second normal-mode daemon from this checkout** — it steals Telegram updates from the live one. Scratch daemons use `AIOS_AGENTS_DIR` / `AIOS_PLAYBOOKS_DIR` / `AIOS_DATA_DIR` overrides and a free port. **Check the port is free first: `lsof -ti:PORT`.**
- **Never restart or kill the daemon on :4280 without asking the user.**
- **Do not `git add ui2/dist`** (gitignored) or `agents/_retired/` (the user's privacy deferral).
- **Never set `maxTurns` on a structured-output SDK call** — `maxTurns: 1` fails every one with `error_max_turns`.
- No test in `vitest` may make a real model call.
- Files under `src/web/*-view.ts` are pure builders — no HTTP, no `res`. Keep that boundary.

---

## File Structure

**Created:**
- `src/boot.ts` — `bootNormal()`, `BootedWorld`, and the shared `log`. Owns the entire normal-mode boot sequence.
- `src/onboarding/workspace.ts` — pure `resolveWorkspace()`. No I/O beyond the writability probe it is handed.
- `src/web/library-view.ts` — pure `libraryTree()` / `libraryRead()` plus the containment rule.
- `ui2/src/views/Library.tsx` — read-only workspace browser.
- `test/onboarding-workspace.test.ts`, `test/library-view.test.ts`, `test/onboarding-first-job.test.ts`

**Modified:**
- `src/index.ts` — shrinks to a mode branch (~25 lines).
- `src/onboarding/server.ts` — `boot` dep, workspace/first-job/retry endpoints, `booted` in `/api/state`, token in the `done` advance.
- `src/web/goals-view.ts` — adds `buildGoalsForOrigin()`.
- `src/web/server.ts` — adds the two library endpoints.
- `src/web/dto.ts` — `StateInfo` gains `booted` / `bootError`; new `LibraryNode`, `FirstJobStatus`.
- `ui2/src/views/Setup.tsx` — real `workspace`, `first-job`, `done` screens.
- `ui2/src/api.ts` — client methods for the new endpoints.
- `ui2/src/App.tsx` — registers the Library view.

---

### Task 1: Extract `bootNormal` from `main()`

Purely mechanical. The riskiest possible bug here is a **reordered** boot — `main()` contains forward-referencing closures (`infoPolicy`, `scheduleEmbed`, and `goals` inside `mailbox`'s `onQueued`) that only work because of statement order. Move the body verbatim; do not tidy, reorder, or "improve" anything.

**Files:**
- Create: `src/boot.ts`
- Modify: `src/index.ts` (replace lines 1-897 wholesale)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const log: (line: string) => void`
  - `export interface BootedWorld { store: Store; bus: EventBus; goals: GoalEngine; moderator: Moderator; registry: LoadedRegistry; vault: VaultWriter; startWeb: () => void; shutdown: () => Promise<void> }`
  - `export async function bootNormal(opts?: { startWeb?: boolean }): Promise<BootedWorld>`

- [ ] **Step 1: Record the baseline**

Run: `npx vitest run 2>&1 | grep -E "^ *Tests|^ *Test Files"`

Write the two numbers down. This task's only real gate is that they do not change.

- [ ] **Step 2: Create `src/boot.ts` by moving the body**

Move **every** import currently in `src/index.ts` except `loadConfig`, `Store`, `bootMode` and `startSetupServer` into `src/boot.ts`. Move `const log = ...` (currently `index.ts:74`). Then move the body of `main()` from `assertAuth();` (line 95) through `log("aios daemon running");` (line 890) into `bootNormal`, unchanged.

Three edits to that moved body, and only three:

```ts
// src/boot.ts
export const log = (line: string) => console.log(`[aios ${new Date().toISOString()}] ${line}`);

export interface BootedWorld {
  store: Store;
  bus: EventBus;
  goals: GoalEngine;
  moderator: Moderator;
  registry: LoadedRegistry;
  vault: VaultWriter;
  startWeb: () => void;
  shutdown: () => Promise<void>;
}

export async function bootNormal(opts: { startWeb?: boolean } = {}): Promise<BootedWorld> {
  // EDIT 1: config is loaded HERE, not passed in. The workspace step writes
  // AIOS_VAULT_PATH to .env after the process-start load, so a captured config
  // would send every artifact to the wrong directory.
  const config = loadConfig();

  assertAuth();
  ensureUiToken(resolve(".env"), log);

  /* ...lines 98-868 of the old main(), verbatim... */

  // EDIT 2: the startWebServer call (old lines 869-872) becomes a closure.
  const startWeb = () => {
    startWebServer(
      { store, bus, goals, spendGuard, vault, config, router, gate, voice, registry, mailbox,
        senses: sensesStatus, reloadPacks: reloadRegistry, envPath: config.envPath,
        uiDist: config.uiDist, log, attachments: attachmentRegistry },
      config.uiPort,
    );
    log(`ready — mission control listening on 127.0.0.1:${config.uiPort}`);
  };
  if (opts.startWeb !== false) startWeb();

  const resumed = goals.resumeUnfinished();
  if (resumed) log(`resumed ${resumed} unfinished job(s)`);

  const shutdown = async () => {
    log("shutting down");
    stops.forEach((s) => s());
    for (const ch of channels.values()) await ch.stop().catch(() => {});
    clock.stop();
    triage.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log("aios daemon running");

  // EDIT 3: return the handle instead of falling off the end.
  return { store, bus, goals, moderator, registry, vault, startWeb, shutdown };
}
```

`process.argv.includes("--cli")` (old line 512) moves with the body and needs no change. Note the consequence: a wizard started via `npm run dev` (which passes `--cli`) will start the interactive CLI channel on stdin at hot boot. That is pre-existing dev behavior, not a regression.

- [ ] **Step 3: Rewrite `src/index.ts`**

```ts
// src/index.ts — mode branch only. The normal-mode boot lives in boot.ts so the
// onboarding wizard can call it in-process after provisioning an org.
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { Store } from "./store/db.js";
import { bootMode } from "./onboarding/mode.js";
import { startSetupServer } from "./onboarding/server.js";
import { bootNormal, log } from "./boot.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Setup mode (onboarding spec §1): no auth or no org → wizard only.
  // Nothing that assumes an org may start. The wizard boots the rest in-process
  // once it has provisioned one — see boot.ts.
  const mode = bootMode(process.env, config.agentsDir);
  if (mode === "setup") {
    const store = new Store(config.dbPath);
    startSetupServer({
      store, envPath: config.envPath, uiDist: config.uiDist, port: config.uiPort,
      agentsDir: config.agentsDir, playbooksDir: config.playbooksDir,
      templatesDir: config.templatesDir,
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
```

`resolve` is imported here only if `index.ts` still needs it after the move — if nothing references it, drop the import rather than leaving it unused (`tsc` is configured to complain).

`boot` is not yet a field on `SetupDeps`; Task 4 adds it. Until then TypeScript will reject that property. **Comment the `boot:` line out for this task and uncomment it in Task 4 Step 3.**

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. Unused-import errors are the expected failure mode here — fix by deleting the import, never by widening the config.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run 2>&1 | grep -E "^ *Tests|^ *Test Files"`
Expected: **identical** to the Step 1 baseline (210 files / 1721 pass + 2 skipped). Any change means the move was not verbatim.

- [ ] **Step 6: Prove the setup branch still starts, on a scratch install**

Do NOT touch :4280, and do NOT start a second normal-mode daemon from this checkout — it steals Telegram updates from the live one.

```bash
lsof -ti:4293 || echo "4293 free"
rm -rf /tmp/aios-boot && mkdir -p /tmp/aios-boot/{agents,playbooks,data}
AIOS_AGENTS_DIR=/tmp/aios-boot/agents AIOS_PLAYBOOKS_DIR=/tmp/aios-boot/playbooks \
AIOS_DATA_DIR=/tmp/aios-boot/data AIOS_UI_PORT=4293 npm run dev
```

Expected: `setup mode: open http://localhost:4293 to begin onboarding`. That proves `index.ts`'s branch survived and that nothing in the moved import graph throws at load. Ctrl-C, then `rm -rf /tmp/aios-boot`.

**The normal-mode boot is deliberately NOT verified here.** Templates in `templates/orgs/` are single `org.yaml` files, not ready-made `agents/` directories, so there is no scratch org to boot against until the wizard provisions one — and provisioning against the repo's real `agents/` would be that forbidden second daemon. Normal mode is proven end-to-end in Task 9 Step 8, and again when the user restarts the live daemon after merge. Do not fake a check here; the unchanged suite in Step 5 is this task's real gate.

- [ ] **Step 7: Commit**

```bash
git add src/boot.ts src/index.ts
git commit -m "refactor(boot): extract bootNormal so the wizard can boot in-process

Moves main()'s normal-mode body verbatim into src/boot.ts behind
bootNormal({ startWeb }), returning a BootedWorld handle. index.ts
becomes a mode branch. startWebServer is deferred behind startWeb()
so the setup server can keep the port during onboarding.

No behavior change: same order, same wiring, same suite."
```

---

### Task 2: `resolveWorkspace` — pure path validation

**Files:**
- Create: `src/onboarding/workspace.ts`
- Test: `test/onboarding-workspace.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface WorkspaceChoice { mode: "builtin" | "custom"; path?: string; subdir?: string }
  export type WorkspaceResult =
    | { ok: true; path: string; subdir: string; warning?: string }
    | { ok: false; error: string };
  export function resolveWorkspace(choice: WorkspaceChoice, home: string): WorkspaceResult;
  export const SYNC_HINTS: RegExp;
  ```
  `resolveWorkspace` does **no** filesystem work — it only expands and classifies. The writability probe lives in the endpoint (Task 3), which is what makes this function testable without a temp dir.

- [ ] **Step 1: Write the failing test**

```ts
// test/onboarding-workspace.test.ts — workspace path resolution (spec §2).
import { describe, it, expect } from "vitest";
import { resolveWorkspace } from "../src/onboarding/workspace.js";

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

  it("warns on cloud-synced paths without blocking them", () => {
    for (const p of [
      "/Users/tester/Library/Mobile Documents/com~apple~CloudDocs/Vault",
      "/Users/tester/Dropbox/Vault",
      "/Users/tester/Google Drive/Vault",
      "/Users/tester/OneDrive/Vault",
    ]) {
      const r = resolveWorkspace({ mode: "custom", path: p }, HOME);
      expect(r.ok).toBe(true);
      expect((r as { warning?: string }).warning).toMatch(/sync/i);
    }
  });

  it("does not warn on an ordinary path", () => {
    const r = resolveWorkspace({ mode: "custom", path: "/Users/tester/Notes" }, HOME);
    expect(r).toEqual({ ok: true, path: "/Users/tester/Notes", subdir: "AIOS" });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/onboarding-workspace.test.ts`
Expected: FAIL — `Failed to resolve import "../src/onboarding/workspace.js"`.

- [ ] **Step 3: Implement**

```ts
// src/onboarding/workspace.ts — workspace choice → a resolved vault path (spec §2).
// Pure: no filesystem access. The endpoint owns the writability probe, which is what
// lets every branch here be tested without a temp dir.
import { isAbsolute, join, normalize } from "node:path";

export interface WorkspaceChoice { mode: "builtin" | "custom"; path?: string; subdir?: string }
export type WorkspaceResult =
  | { ok: true; path: string; subdir: string; warning?: string }
  | { ok: false; error: string };

/** Directories a sync client rewrites underneath us. Warn, never block — it is the user's disk. */
export const SYNC_HINTS = /(?:Library\/Mobile Documents|iCloud|Dropbox|Google Drive|OneDrive)/i;

const DEFAULT_SUBDIR = "AIOS";

export function resolveWorkspace(choice: WorkspaceChoice, home: string): WorkspaceResult {
  const subdirRaw = (choice.subdir ?? "").trim();
  const subdir = subdirRaw || DEFAULT_SUBDIR;
  // A subdir is joined onto the vault root, so anything with a separator or a dot-dot
  // segment escapes it. One plain folder name is the whole contract.
  if (subdir !== normalize(subdir) || /[\\/]/.test(subdir) || subdir === "..") {
    return { ok: false, error: "subdir must be a single folder name" };
  }

  if (choice.mode === "builtin") {
    return { ok: true, path: join(home, "AIOS", "workspace"), subdir };
  }

  const raw = (choice.path ?? "").trim();
  if (!raw) return { ok: false, error: "a workspace path is required" };
  const path = raw.startsWith("~") ? join(home, raw.slice(1)) : raw;
  if (!isAbsolute(path)) return { ok: false, error: "workspace path must be absolute or start with ~" };

  return SYNC_HINTS.test(path)
    ? { ok: true, path, subdir, warning: "This folder looks like it is cloud-synced. Sync clients rewrite files underneath the daemon, which can corrupt artifacts mid-write." }
    : { ok: true, path, subdir };
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npx vitest run test/onboarding-workspace.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/workspace.ts test/onboarding-workspace.test.ts
git commit -m "feat(onboarding): resolve a workspace choice to a vault path

Pure resolver: tilde expansion, absolute-path and subdir-escape checks,
and a warning (never a block) for cloud-synced directories."
```

---

### Task 3: Workspace endpoint + screen

**Files:**
- Modify: `src/onboarding/server.ts`
- Modify: `ui2/src/api.ts`
- Modify: `ui2/src/views/Setup.tsx`
- Test: `test/onboarding-workspace.test.ts` (append an HTTP block)

**Interfaces:**
- Consumes: `resolveWorkspace`, `WorkspaceChoice` from Task 2.
- Produces: `POST /api/onboarding/workspace` → `{ step, warning? }` on success, `{ error }` on 400. Client method `api.onboardingWorkspace(choice)`.

- [ ] **Step 1: Write the failing test**

Append to `test/onboarding-workspace.test.ts`:

```ts
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join as pjoin } from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "vitest";
import type { Server } from "node:http";
import { startSetupServer, type SetupDeps } from "../src/onboarding/server.js";

function kv() {
  const m = new Map<string, string>();
  return { kvGet: (k: string) => m.get(k), kvSet: (k: string, v: string) => void m.set(k, v) };
}

let server: Server;
afterEach(() => server?.close());

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

describe("POST /api/onboarding/workspace", () => {
  it("advances on builtin without writing env", async () => {
    const { base, dir } = await boot();
    const r = await fetch(`${base}/api/onboarding/workspace`, {
      method: "POST", body: JSON.stringify({ mode: "builtin" }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("interview");
    expect(existsSync(pjoin(dir, ".env"))).toBe(false);
  });

  it("creates the directory and writes env for a custom path", async () => {
    const { base, dir } = await boot();
    const target = pjoin(dir, "my vault");
    const r = await fetch(`${base}/api/onboarding/workspace`, {
      method: "POST", body: JSON.stringify({ mode: "custom", path: target, subdir: "Brain" }),
    });
    expect(r.status).toBe(200);
    expect(existsSync(target)).toBe(true);
    const env = readFileSync(pjoin(dir, ".env"), "utf8");
    expect(env).toContain(`AIOS_VAULT_PATH=${target}`);
    expect(env).toContain("AIOS_VAULT_SUBDIR=Brain");
  });

  it("leaves no probe file behind", async () => {
    const { base, dir } = await boot();
    const target = pjoin(dir, "probe-check");
    await fetch(`${base}/api/onboarding/workspace`, {
      method: "POST", body: JSON.stringify({ mode: "custom", path: target }),
    });
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(target)).toEqual([]);
  });

  it("400s on an unwritable path and does not advance", async () => {
    const { base } = await boot();
    const r = await fetch(`${base}/api/onboarding/workspace`, {
      method: "POST", body: JSON.stringify({ mode: "custom", path: "/proc/aios-nope" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBeTruthy();
    const s = await (await fetch(`${base}/api/state`)).json();
    expect(s.step).toBe("workspace");
  });

  it("refuses when the wizard is not at the workspace step", async () => {
    const { base } = await boot();
    await fetch(`${base}/api/onboarding/workspace`, { method: "POST", body: JSON.stringify({ mode: "builtin" }) });
    const r = await fetch(`${base}/api/onboarding/workspace`, {
      method: "POST", body: JSON.stringify({ mode: "builtin" }),
    });
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/onboarding-workspace.test.ts`
Expected: FAIL — the new block 404s (`not found`) because the route does not exist; the Task 2 tests still pass.

- [ ] **Step 3: Add the endpoint**

In `src/onboarding/server.ts`, add to the imports:

```ts
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolveWorkspace, type WorkspaceChoice } from "./workspace.js";
```

Insert this handler immediately after the `/api/onboarding/templates` GET block:

```ts
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
  // that out at the first artifact write means losing the job that produced it.
  if (body.mode === "custom") {
    const probe = join(r.path, ".aios-write-probe");
    try {
      mkdirSync(r.path, { recursive: true });
      writeFileSync(probe, "");
      unlinkSync(probe);
    } catch (err) {
      return json(res, 400, { error: `cannot write to ${r.path}: ${(err as Error).message}` });
    }
    updateEnvFile(deps.envPath, "AIOS_VAULT_PATH", r.path);
    updateEnvFile(deps.envPath, "AIOS_VAULT_SUBDIR", r.subdir);
    // bootNormal calls loadConfig() itself, but that reads process.env — which this
    // process already populated at start. Set it here too or the hot boot uses the old path.
    process.env.AIOS_VAULT_PATH = r.path;
    process.env.AIOS_VAULT_SUBDIR = r.subdir;
  }
  const step = wizard.advance("workspace");
  return json(res, 200, { step, ...(r.warning ? { warning: r.warning } : {}) });
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npx vitest run test/onboarding-workspace.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Add the client method**

In `ui2/src/api.ts`, next to `onboardingAdvance`:

```ts
  onboardingWorkspace: (choice: { mode: "builtin" | "custom"; path?: string; subdir?: string }) =>
    request<{ step: string; warning?: string }>("/api/onboarding/workspace", {
      method: "POST", body: JSON.stringify(choice),
    }),
```

- [ ] **Step 6: Replace the workspace placeholder**

In `ui2/src/views/Setup.tsx`, remove `"workspace"` from the placeholder branch's condition and its `SkipStep`, then add:

```tsx
function Workspace({ onNext }: { onNext: (s: string) => void }) {
  const [mode, setMode] = useState<"builtin" | "custom">("builtin");
  const [path, setPath] = useState("");
  const [subdir, setSubdir] = useState("AIOS");
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = (force = false) => {
    setBusy(true); setError("");
    api.onboardingWorkspace(mode === "builtin" ? { mode } : { mode, path, subdir })
      .then((r) => {
        // A warning is advisory: the server already advanced, so honour that and move on.
        if (r.warning && !force) setWarning(r.warning);
        onNext(r.step);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const radio = (v: "builtin" | "custom", label: string, hint: string) => (
    <label className="flex items-start gap-2 cursor-pointer">
      <input type="radio" name="ws" checked={mode === v} onChange={() => setMode(v)} className="mt-1" />
      <span>
        <span className="text-strong">{label}</span>
        <span className="block text-[12px] text-dim leading-relaxed">{hint}</span>
      </span>
    </label>
  );

  return (
    <div className="panel w-full max-w-md p-6 flex flex-col gap-4">
      <div className="text-strong text-[15px]">Where should your files live?</div>
      <p className="leading-relaxed">
        Briefs, reports and notes are written as plain markdown. You can read them in AIOS —
        Obsidian is a bonus viewer, not a requirement.
      </p>
      {radio("builtin", "Built-in workspace", "~/AIOS/workspace — created for you.")}
      {radio("custom", "Use my own folder", "An existing Obsidian vault, or any folder you like.")}
      {mode === "custom" && (
        <div className="flex flex-col gap-2">
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/Documents/MyVault"
            className="w-full bg-bg border border-line rounded-md px-3 py-2 text-fg outline-none focus:border-dim" />
          <input value={subdir} onChange={(e) => setSubdir(e.target.value)} placeholder="AIOS"
            className="w-full bg-bg border border-line rounded-md px-3 py-2 text-fg outline-none focus:border-dim" />
          <span className="text-[11px] text-dim">AIOS writes only inside that subfolder.</span>
        </div>
      )}
      {warning && <div className="text-[12px] text-dim leading-relaxed">{warning}</div>}
      {error && <div className="text-[12px] text-err">{error}</div>}
      <Button variant="primary" disabled={busy || (mode === "custom" && !path.trim())}
        onClick={() => submit()}>{busy ? "Checking…" : "Continue"}</Button>
    </div>
  );
}
```

Register it: `{step === "workspace" && <Workspace onNext={onStepChange} />}`.

The warning uses `text-dim`, not a warning colour: this codebase defines no `text-warn` tone, and the sync warning is advisory rather than an error (`text-err` would overstate it).

- [ ] **Step 7: Typecheck both trees**

Run: `npx tsc --noEmit && cd ui2 && npm run typecheck && cd ..`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src/onboarding/server.ts ui2/src/api.ts ui2/src/views/Setup.tsx test/onboarding-workspace.test.ts
git commit -m "feat(onboarding): real workspace step

Built-in default or a typed path, validated by a write probe before
anything advances. Cloud-sync paths warn rather than block. Writes
AIOS_VAULT_PATH/SUBDIR to .env and to process.env, so the in-process
hot boot reads the chosen path rather than the one loaded at startup."
```

---

### Task 4: Wire hot boot into the setup server

**Files:**
- Modify: `src/onboarding/server.ts`
- Modify: `src/index.ts` (uncomment the `boot:` line from Task 1 Step 3)
- Modify: `src/web/dto.ts`
- Test: `test/onboarding-server.test.ts` (append)

**Interfaces:**
- Consumes: `BootedWorld` from Task 1.
- Produces:
  - `SetupDeps.boot?: () => Promise<BootedWorld>`
  - `GET /api/state` → `{ mode: "setup", step, booted: boolean, bootError?: string }`
  - `POST /api/onboarding/boot` — retry after a failed boot.
  - Module-local `world: BootedWorld | null` that Tasks 5 and 9 read.

- [ ] **Step 1: Write the failing test**

Append to `test/onboarding-server.test.ts`:

```ts
import type { BootedWorld } from "../src/boot.js";

/** Minimum shape the setup server actually touches. Cast once, here, so the tests below
 *  read as real usage rather than as a pile of `as any`. */
function fakeWorld(over: Partial<BootedWorld> = {}): BootedWorld {
  return {
    moderator: { handle: async () => ({ text: "done", attachments: [] }) },
    store: { listGoals: () => [], listNodes: () => [] },
    startWeb: () => {},
    ...over,
  } as unknown as BootedWorld;
}

describe("hot boot", () => {
  it("boots after a successful provision and reports booted", async () => {
    let booted = 0;
    const { base } = await boot(async () => {}, {
      provisionFn: () => ({ ok: true, departments: ["ops"], agents: ["nova"], playbooks: [] }),
      boot: async () => { booted++; return fakeWorld(); },
    }, "review");

    const r = await fetch(`${base}/api/onboarding/provision`, { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("first-job");
    expect(booted).toBe(1);

    const s = await (await fetch(`${base}/api/state`)).json();
    expect(s).toMatchObject({ mode: "setup", step: "first-job", booted: true });
  });

  it("keeps the provisioned org when boot throws, and reports the error", async () => {
    const { base } = await boot(async () => {}, {
      provisionFn: () => ({ ok: true, departments: ["ops"], agents: ["nova"], playbooks: [] }),
      boot: async () => { throw new Error("registry exploded"); },
    }, "review");

    const r = await fetch(`${base}/api/onboarding/provision`, { method: "POST", body: "{}" });
    // The org IS created — boot failing is a separate fault and must not roll it back.
    expect(r.status).toBe(200);
    expect((await r.json()).step).toBe("first-job");

    const s = await (await fetch(`${base}/api/state`)).json();
    expect(s.booted).toBe(false);
    expect(s.bootError).toContain("registry exploded");
  });

  it("retries a failed boot through /api/onboarding/boot", async () => {
    let attempts = 0;
    const { base } = await boot(async () => {}, {
      provisionFn: () => ({ ok: true, departments: ["ops"], agents: ["nova"], playbooks: [] }),
      boot: async () => {
        attempts++;
        if (attempts === 1) throw new Error("first attempt fails");
        return fakeWorld();
      },
    }, "review");

    await fetch(`${base}/api/onboarding/provision`, { method: "POST", body: "{}" });
    const r = await fetch(`${base}/api/onboarding/boot`, { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    expect((await r.json()).booted).toBe(true);
    expect(attempts).toBe(2);
  });

  it("never boots twice when provision and retry race", async () => {
    let attempts = 0;
    const { base } = await boot(async () => {}, {
      provisionFn: () => ({ ok: true, departments: ["ops"], agents: ["nova"], playbooks: [] }),
      boot: async () => {
        attempts++;
        await new Promise((r) => setTimeout(r, 20));
        return fakeWorld();
      },
    }, "review");

    await Promise.all([
      fetch(`${base}/api/onboarding/provision`, { method: "POST", body: "{}" }),
      fetch(`${base}/api/onboarding/boot`, { method: "POST", body: "{}" }),
    ]);
    expect(attempts).toBe(1);
  });
});
```

The existing `boot()` helper in this file takes `(ping, over, step)` — it already forwards `over` into `startSetupServer`, so `provisionFn` and the new `boot` dep pass straight through unchanged.

Note the name collision: the test file's local helper is called `boot`, and the new `SetupDeps` field is also called `boot`. That is fine — the field is written as an object property inside the `over` argument — but do not rename either one, or the appended tests in Task 9 will not match.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/onboarding-server.test.ts`
Expected: FAIL — `boot` is not a known property of `SetupDeps`, and `/api/state` has no `booted`.

- [ ] **Step 3: Implement**

In `src/onboarding/server.ts`, add to `SetupDeps`:

```ts
  /** Brings the real daemon up in-process once an org exists. Injected so tests never boot. */
  boot?: () => Promise<BootedWorld>;
```

with `import type { BootedWorld } from "../boot.js";`.

Inside `startSetupServer`, next to the `verifying` latch:

```ts
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
```

Change `/api/state`:

```ts
if (path === "/api/state" && req.method === "GET") {
  return json(res, 200, {
    mode: "setup", step: wizard.current(),
    booted: world !== null,
    ...(bootError ? { bootError } : {}),
  });
}
```

Add the retry endpoint next to it:

```ts
if (path === "/api/onboarding/boot" && req.method === "POST") {
  const w = await ensureBooted();
  return json(res, w ? 200 : 500, w ? { booted: true } : { booted: false, error: bootError || "no boot function configured" });
}
```

In the provision handler, after `wizard.advance("provision")` and the success log, before the response:

```ts
          wizard.advance("review");    // → provision
          wizard.advance("provision"); // → first-job
          log(`org provisioned: ${result.agents.join(", ")}`);
          // The org exists either way; a boot failure surfaces through /api/state, not by
          // refusing the provision the user just approved.
          await ensureBooted();
          return json(res, 200, { step: wizard.current(), departments: result.departments, agents: result.agents });
```

Also extend the resume branch (`at === "provision" && orgExists()`) to `await ensureBooted()` before advancing, so a crash-resume lands with an engine.

In `src/web/dto.ts`, extend `StateInfo`:

```ts
  /** Setup mode only: has the daemon been booted in-process yet? */
  booted?: boolean;
  /** Setup mode only: why the in-process boot failed, when it did. */
  bootError?: string;
```

Finally uncomment the `boot: () => bootNormal({ startWeb: false }),` line in `src/index.ts`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/onboarding-server.test.ts`
Expected: PASS — the four new tests plus every pre-existing one in the file.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/onboarding/server.ts src/index.ts src/web/dto.ts test/onboarding-server.test.ts
git commit -m "feat(onboarding): boot the daemon in-process after provisioning

Provision now brings the real engine up without a restart. A boot
failure never rolls back the org — it surfaces on /api/state as
bootError with a retry endpoint. A booting latch makes a double
provision or a raced retry produce exactly one world."
```

---

### Task 5: First-job dispatch endpoints

**Files:**
- Modify: `src/web/goals-view.ts`
- Modify: `src/web/dto.ts`
- Modify: `src/onboarding/server.ts`
- Test: `test/onboarding-first-job.test.ts`

**Interfaces:**
- Consumes: `world` and `ensureBooted` from Task 4; `GoalView` from `dto.ts`.
- Produces:
  - `export function buildGoalsForOrigin(store: Store, channel: string, chatId: string): GoalView[]`
  - `export interface FirstJobStatus { status: "idle" | "running" | "done" | "failed"; request?: string; reply?: string; error?: string; goals: GoalView[] }`
  - `POST /api/onboarding/first-job` → `{ status: "running" }`; `GET` → `FirstJobStatus`.
  - Origin constants: channel `"web"`, chatId `"onboarding"`.

- [ ] **Step 1: Write the failing test**

```ts
// test/onboarding-first-job.test.ts — first-job dispatch through the coordinator (spec §3).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { startSetupServer, type SetupDeps } from "../src/onboarding/server.js";
import type { BootedWorld } from "../src/boot.js";

function kv() {
  const m = new Map<string, string>();
  return { kvGet: (k: string) => m.get(k), kvSet: (k: string, v: string) => void m.set(k, v) };
}

let server: Server;
afterEach(() => server?.close());

const PROPOSAL = JSON.stringify({
  source: { kind: "interview" },
  departments: [{ department: "ops", mission: "m", memoDomain: "d", capabilities: [], playbooks: [] }],
  agents: [{ name: "nova", department: "ops", kind: "coordinator", title: "t", charter: "c",
             persona: "p", prompt: "pr", capabilities: [], skills: [] }],
  firstJob: "Draft a chaser email for the oldest unpaid invoice.",
});

async function boot(world: Partial<BootedWorld>, over: Partial<SetupDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fj-"));
  const store = kv();
  store.kvSet("onboarding.step", "first-job");
  store.kvSet("onboarding.proposal", PROPOSAL);
  server = startSetupServer({
    store, envPath: join(dir, ".env"), uiDist: dir, port: 0, ping: async () => {},
    agentsDir: join(dir, "agents"), playbooksDir: join(dir, "playbooks"),
    templatesDir: join(process.cwd(), "templates"),
    boot: async () => ({ store: { listGoals: () => [] }, startWeb: () => {}, ...world } as unknown as BootedWorld),
    ...over,
  });
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await fetch(`${base}/api/onboarding/boot`, { method: "POST", body: "{}" });
  return { base };
}

/** Poll until the dispatch settles — handle() resolves on its own clock. */
async function settle(base: string) {
  for (let i = 0; i < 50; i++) {
    const s = await (await fetch(`${base}/api/onboarding/first-job`)).json();
    if (s.status !== "running") return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("first job never settled");
}

describe("first job", () => {
  it("is idle before anything is dispatched", async () => {
    const { base } = await boot({});
    const s = await (await fetch(`${base}/api/onboarding/first-job`)).json();
    expect(s).toMatchObject({ status: "idle", goals: [] });
  });

  it("hands the request to the coordinator and stores the reply", async () => {
    const seen: string[] = [];
    const { base } = await boot({
      moderator: {
        handle: async (_ch: string, _id: string, text: string) => {
          seen.push(text);
          return { text: "I drafted it.", attachments: [] };
        },
      } as unknown as BootedWorld["moderator"],
    });
    const r = await fetch(`${base}/api/onboarding/first-job`, {
      method: "POST", body: JSON.stringify({ request: "Draft the chaser." }),
    });
    expect(r.status).toBe(200);
    const s = await settle(base);
    expect(seen).toEqual(["Draft the chaser."]);
    expect(s).toMatchObject({ status: "done", reply: "I drafted it." });
  });

  it("records a coordinator failure without wedging the wizard", async () => {
    const { base } = await boot({
      moderator: { handle: async () => { throw new Error("model unavailable"); } } as unknown as BootedWorld["moderator"],
    });
    await fetch(`${base}/api/onboarding/first-job`, {
      method: "POST", body: JSON.stringify({ request: "go" }),
    });
    const s = await settle(base);
    expect(s.status).toBe("failed");
    expect(s.error).toContain("model unavailable");
  });

  it("returns only goals whose origin is the onboarding chat", async () => {
    const rows = [
      { id: "g1", slug: "mine", title: "Mine", request: "", department: "ops", lead: "nova",
        origin_channel: "web", origin_chat_id: "onboarding", status: "running", project_dir: null,
        goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, spawned_by_mail: null,
        created_at: "t", updated_at: "t" },
      { id: "g2", slug: "other", title: "Other", request: "", department: "ops", lead: "nova",
        origin_channel: "telegram", origin_chat_id: "123", status: "running", project_dir: null,
        goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, spawned_by_mail: null,
        created_at: "t", updated_at: "t" },
    ];
    const { base } = await boot({
      moderator: { handle: async () => ({ text: "ok", attachments: [] }) } as unknown as BootedWorld["moderator"],
      store: { listGoals: () => rows, listNodes: () => [] } as unknown as BootedWorld["store"],
    });
    await fetch(`${base}/api/onboarding/first-job`, { method: "POST", body: JSON.stringify({ request: "go" }) });
    const s = await settle(base);
    expect(s.goals.map((g: { slug: string }) => g.slug)).toEqual(["mine"]);
  });

  it("400s when the daemon is not booted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fj-"));
    const store = kv();
    store.kvSet("onboarding.step", "first-job");
    server = startSetupServer({
      store, envPath: join(dir, ".env"), uiDist: dir, port: 0, ping: async () => {},
      agentsDir: join(dir, "agents"), playbooksDir: join(dir, "playbooks"),
      templatesDir: join(process.cwd(), "templates"),
      boot: async () => { throw new Error("nope"); },
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const r = await fetch(`${base}/api/onboarding/first-job`, {
      method: "POST", body: JSON.stringify({ request: "go" }),
    });
    expect(r.status).toBe(400);
  });

  it("refuses an empty request", async () => {
    const { base } = await boot({
      moderator: { handle: async () => ({ text: "ok", attachments: [] }) } as unknown as BootedWorld["moderator"],
    });
    const r = await fetch(`${base}/api/onboarding/first-job`, {
      method: "POST", body: JSON.stringify({ request: "   " }),
    });
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/onboarding-first-job.test.ts`
Expected: FAIL — every request 404s (`not found`).

- [ ] **Step 3: Add the goals builder**

In `src/web/goals-view.ts`, after `buildGoalsView`:

```ts
/** Goals originating from one chat. The origin tuple the engine already persists is the
 *  correlation key, so the wizard needs no job-id registry of its own — and a coordinator
 *  that spawns several goals from one request is covered for free. */
export function buildGoalsForOrigin(store: Store, channel: string, chatId: string, limit = 50): GoalView[] {
  return store.listGoals(limit)
    .filter((g) => g.origin_channel === channel && g.origin_chat_id === chatId)
    .map((g) => goalView(g, store));
}
```

In `src/web/dto.ts`:

```ts
/** Wizard first-job step: what the coordinator is doing with the suggested job. */
export interface FirstJobStatus {
  status: "idle" | "running" | "done" | "failed";
  request?: string;
  reply?: string;
  error?: string;
  goals: GoalView[];
}
```

- [ ] **Step 4: Add the endpoints**

In `src/onboarding/server.ts`, import `buildGoalsForOrigin` from `../web/goals-view.js` and add near the other kv keys:

```ts
  const FIRST_JOB_KEY = "onboarding.firstJob";
  // The coordinator answers on a chat like any other caller; this tuple is what makes the
  // goals it spawns findable later without inventing an id registry.
  const JOB_ORIGIN = { channel: "web", chatId: "onboarding" };
  type JobState = { status: "running" | "done" | "failed"; request: string; reply?: string; error?: string };
  const jobState = (): JobState | null => {
    const raw = deps.store.kvGet(FIRST_JOB_KEY);
    return raw ? (JSON.parse(raw) as JobState) : null;
  };
  const setJobState = (s: JobState) => deps.store.kvSet(FIRST_JOB_KEY, JSON.stringify(s));
```

Then the handlers, after the provision block:

```ts
if (path === "/api/onboarding/first-job" && req.method === "GET") {
  const s = jobState();
  const goals = world ? buildGoalsForOrigin(world.store, JOB_ORIGIN.channel, JOB_ORIGIN.chatId) : [];
  if (!s) return json(res, 200, { status: "idle", goals });
  return json(res, 200, { ...s, goals });
}

if (path === "/api/onboarding/first-job" && req.method === "POST") {
  const w = await ensureBooted();
  if (!w) return json(res, 400, { error: bootError || "the daemon is not running yet" });
  const body = await readJson<{ request?: unknown }>(req);
  if (!body) return json(res, 400, { error: "body must be JSON" });
  const request = typeof body.request === "string" ? body.request.trim() : "";
  if (!request) return json(res, 400, { error: "request required" });

  setJobState({ status: "running", request });
  // Deliberately not awaited: the coordinator can take minutes, and the browser polls GET
  // for progress. Errors land in kv, so there is no unhandled rejection either way.
  void w.moderator.handle(JOB_ORIGIN.channel, JOB_ORIGIN.chatId, request)
    .then((r) => setJobState({ status: "done", request, reply: r.text }))
    .catch((err) => {
      log(`first job failed: ${(err as Error).message}`);
      setJobState({ status: "failed", request, error: (err as Error).message });
    });
  return json(res, 200, { status: "running" });
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/onboarding-first-job.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/onboarding/server.ts src/web/goals-view.ts src/web/dto.ts test/onboarding-first-job.test.ts
git commit -m "feat(onboarding): dispatch the first job through the coordinator

moderator.handle on a web:onboarding origin — the coordinator picks
its own tool, so there is no wizard-only execution path. Dispatch is
fire-and-forget with state in kv; the browser polls. Goals are
correlated by origin rather than by a new id registry."
```

---

### Task 6: First-job screen

**Files:**
- Modify: `ui2/src/api.ts`
- Modify: `ui2/src/views/Setup.tsx`

**Interfaces:**
- Consumes: `FirstJobStatus` from Task 5; `MiniDag` from `./MiniDag.js`.
- Produces: the `first-job` screen; `api.firstJobStatus()`, `api.runFirstJob(request)`.

- [ ] **Step 1: Add the client methods**

In `ui2/src/api.ts` (and add `FirstJobStatus` to the type re-export block at the top of the file):

```ts
  firstJobStatus: () => request<FirstJobStatus>("/api/onboarding/first-job"),
  runFirstJob: (request_: string) =>
    request<{ status: string }>("/api/onboarding/first-job", {
      method: "POST", body: JSON.stringify({ request: request_ }),
    }),
  onboardingBoot: () =>
    request<{ booted: boolean; error?: string }>("/api/onboarding/boot", { method: "POST", body: "{}" }),
```

- [ ] **Step 2: Replace the first-job placeholder**

In `ui2/src/views/Setup.tsx`, remove `"first-job"` from the placeholder branch and add:

```tsx
function FirstJob({ onNext }: { onNext: (s: string) => void }) {
  const [request, setRequest] = useState("");
  const [job, setJob] = useState<FirstJobStatus | null>(null);
  const [booted, setBooted] = useState(true);
  const [bootError, setBootError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Seed the box from the proposal the user already approved.
  useEffect(() => {
    api.onboardingProposal().then((r) => setRequest(r.proposal.firstJob)).catch(() => {});
    api.state().then((s) => { setBooted(s.booted !== false); setBootError(s.bootError ?? ""); }).catch(() => {});
  }, []);

  // Poll only while something is actually in flight — an idle wizard should not tick forever.
  useEffect(() => {
    const tick = () => api.firstJobStatus().then(setJob).catch(() => {});
    void tick();
    if (job && job.status !== "running") return;
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, [job?.status]);

  const run = () => {
    setBusy(true); setError("");
    api.runFirstJob(request.trim())
      .then(() => api.firstJobStatus().then(setJob))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const retryBoot = () => {
    setBusy(true); setError("");
    api.onboardingBoot()
      .then((r) => { setBooted(r.booted); setBootError(r.error ?? ""); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (!booted) {
    return (
      <div className="panel w-full max-w-md p-6 flex flex-col gap-3">
        <div className="text-strong text-[15px]">Your org was created</div>
        <p className="leading-relaxed">
          The agents are on disk, but the daemon could not start. Nothing is lost — try again.
        </p>
        <div className="text-[12px] text-err">{bootError}</div>
        {error && <div className="text-[12px] text-err">{error}</div>}
        <Button variant="primary" disabled={busy} onClick={retryBoot}>{busy ? "Starting…" : "Try again"}</Button>
      </div>
    );
  }

  const running = job?.status === "running";
  return (
    <div className="panel w-full max-w-2xl p-6 flex flex-col gap-4">
      <div className="text-strong text-[15px]">Give your org its first job</div>
      <p className="leading-relaxed">
        This is what your team suggested. Change it to anything you like — it goes to your
        coordinator exactly as if you had typed it in chat.
      </p>
      <textarea value={request} onChange={(e) => setRequest(e.target.value)} rows={3} disabled={running}
        className="w-full bg-bg border border-line rounded-md px-3 py-2 text-fg text-[13px] leading-relaxed outline-none focus:border-dim resize-y disabled:opacity-60" />
      {error && <div className="text-[12px] text-err">{error}</div>}

      {job && job.status !== "idle" && (
        <div className="border border-line rounded-md p-3 flex flex-col gap-3">
          <div className="text-[11px] uppercase tracking-[0.12em] text-dim">
            {job.status === "running" ? "Working…" : job.status === "failed" ? "Did not finish" : "Result"}
          </div>
          {job.reply && <div className="text-[13px] leading-relaxed whitespace-pre-wrap">{job.reply}</div>}
          {job.error && <div className="text-[12px] text-err">{job.error}</div>}
          {job.goals.map((g) => (
            <div key={g.id} className="flex flex-col gap-1">
              <div className="text-[12px]"><span className="text-strong">{g.title}</span>
                <span className="text-dim"> — {g.status}</span></div>
              {g.nodes.length > 0 && <MiniDag nodes={g.nodes} />}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={busy || running || !request.trim()} onClick={run}>
          {running ? "Running…" : job?.status === "failed" ? "Try again" : "Run it"}
        </Button>
        {/* Always enabled: a first job that flops must never trap the user in the wizard. */}
        <Button className="ml-auto" onClick={() => {
          api.onboardingAdvance("first-job").then((r) => onNext(r.step)).catch(() => {});
        }}>{job?.status === "done" ? "Continue" : "Skip for now"}</Button>
      </div>
    </div>
  );
}
```

Add the imports it needs at the top of `Setup.tsx`: `MiniDag` from `./MiniDag.js` and the `FirstJobStatus` type from `../api.js`. Register the screen: `{step === "first-job" && <FirstJob onNext={onStepChange} />}`.

- [ ] **Step 3: Typecheck the UI**

Run: `cd ui2 && npm run typecheck && cd ..`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui2/src/api.ts ui2/src/views/Setup.tsx
git commit -m "feat(ui2): first-job screen with live goal pipelines

Prefilled editable request, polled status, and MiniDag per spawned
goal — reusing the cockpit's DAG rather than drawing a second one.
Continue is always enabled, and a failed hot boot gets its own retry
screen instead of a dead end."
```

---

### Task 7: `library-view` — tree, read, and containment

Path escape is the entire risk surface of the Library, which is why the rule lives in a pure function reachable without HTTP.

**Files:**
- Create: `src/web/library-view.ts`
- Modify: `src/web/dto.ts`
- Test: `test/library-view.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface LibraryNode { name: string; path: string; dir: boolean; size: number; children?: LibraryNode[] }
  export function libraryTree(root: string, maxDepth?: number): LibraryNode[]
  export function libraryRead(root: string, rel: string): { mime: string; body: Buffer }
  ```
  `libraryRead` throws on any path that resolves outside `root`.

- [ ] **Step 1: Write the failing test**

```ts
// test/library-view.test.ts — read-only workspace browser (spec §4).
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { libraryTree, libraryRead } from "../src/web/library-view.js";

let root: string;
let outside: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "lib-"));
  root = join(base, "vault");
  outside = join(base, "secrets");
  mkdirSync(join(root, "goals", "2026-08-01-chaser"), { recursive: true });
  mkdirSync(join(root, "knowledge"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "goals", "2026-08-01-chaser", "report.md"), "# Chaser\n\nbody");
  writeFileSync(join(root, "knowledge", "note.md"), "note");
  writeFileSync(join(root, "logo.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(join(outside, "id_rsa"), "PRIVATE KEY");
});

describe("libraryTree", () => {
  it("lists directories before files, each sorted by name", () => {
    const t = libraryTree(root);
    expect(t.map((n) => n.name)).toEqual(["goals", "knowledge", "logo.png"]);
    expect(t[0].dir).toBe(true);
    expect(t[2].dir).toBe(false);
  });

  it("nests children with vault-relative paths", () => {
    const goals = libraryTree(root).find((n) => n.name === "goals")!;
    const dir = goals.children![0];
    expect(dir.path).toBe("goals/2026-08-01-chaser");
    expect(dir.children![0].path).toBe("goals/2026-08-01-chaser/report.md");
  });

  it("reports file sizes", () => {
    const png = libraryTree(root).find((n) => n.name === "logo.png")!;
    expect(png.size).toBe(8);
  });

  it("stops at maxDepth instead of walking forever", () => {
    const goals = libraryTree(root, 1).find((n) => n.name === "goals")!;
    expect(goals.children).toBeUndefined();
  });

  it("returns an empty list for a root that does not exist", () => {
    expect(libraryTree(join(root, "nope"))).toEqual([]);
  });
});

describe("libraryRead", () => {
  it("reads a markdown file with a text mime", () => {
    const r = libraryRead(root, "knowledge/note.md");
    expect(r.mime).toBe("text/markdown");
    expect(r.body.toString()).toBe("note");
  });

  it("types images by extension", () => {
    expect(libraryRead(root, "logo.png").mime).toBe("image/png");
  });

  it("rejects a dot-dot escape", () => {
    expect(() => libraryRead(root, "../secrets/id_rsa")).toThrow(/escapes/i);
  });

  it("rejects an absolute path", () => {
    expect(() => libraryRead(root, join(outside, "id_rsa"))).toThrow(/escapes/i);
  });

  it("rejects a symlink pointing outside the vault rather than following it", () => {
    symlinkSync(join(outside, "id_rsa"), join(root, "leak.md"));
    expect(() => libraryRead(root, "leak.md")).toThrow(/escapes/i);
  });

  it("rejects a path whose prefix merely looks like the root", () => {
    // `<root>evil` startsWith `<root>` — the separator is what makes containment correct.
    mkdirSync(`${root}evil`, { recursive: true });
    writeFileSync(join(`${root}evil`, "x.md"), "x");
    expect(() => libraryRead(root, "../vaultevil/x.md")).toThrow(/escapes/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/library-view.test.ts`
Expected: FAIL — `Failed to resolve import "../src/web/library-view.js"`.

- [ ] **Step 3: Implement**

```ts
// src/web/library-view.ts — pure builders behind /api/library (spec §4). Read-only.
// Containment is the whole risk surface here, so it lives in one function with no HTTP
// around it: resolve the real path (following symlinks) and require it under the root.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { LibraryNode } from "./dto.js";

export type { LibraryNode } from "./dto.js";

const MIME: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain",
  ".json": "application/json", ".csv": "text/csv", ".yaml": "text/yaml", ".yml": "text/yaml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
};

const DEFAULT_DEPTH = 6;

/** Resolve `rel` against `root` and prove it stays inside. Symlinks are resolved BEFORE the
 *  check, so a link out of the vault is rejected rather than followed. The `+ sep` is what
 *  stops a sibling named `<root>evil` from passing a bare startsWith. */
function contained(root: string, rel: string): string {
  const base = realpathSync(resolve(root));
  const target = resolve(base, rel);
  const real = existsSync(target) ? realpathSync(target) : target;
  if (real !== base && !real.startsWith(base + sep)) throw new Error(`path escapes the workspace: ${rel}`);
  return real;
}

export function libraryTree(root: string, maxDepth = DEFAULT_DEPTH): LibraryNode[] {
  if (!existsSync(root)) return [];
  const base = realpathSync(resolve(root));

  const walk = (abs: string, rel: string, depth: number): LibraryNode[] => {
    let entries: string[];
    // An unreadable subdirectory is a bad folder, not a bad vault — skip it, keep the tree.
    try { entries = readdirSync(abs); } catch { return []; }
    const nodes: LibraryNode[] = [];
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try { st = statSync(childAbs); } catch { continue; }
      const node: LibraryNode = { name, path: childRel, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size };
      if (node.dir && depth < maxDepth) node.children = walk(childAbs, childRel, depth + 1);
      nodes.push(node);
    }
    // Directories first, then files, each alphabetical — a stable shape the UI can rely on.
    return nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  };

  return walk(base, "", 1);
}

export function libraryRead(root: string, rel: string): { mime: string; body: Buffer } {
  const abs = contained(root, rel);
  if (!existsSync(abs) || statSync(abs).isDirectory()) throw new Error(`not a file: ${rel}`);
  return { mime: MIME[extname(abs).toLowerCase()] ?? "application/octet-stream", body: readFileSync(abs) };
}
```

In `src/web/dto.ts`:

```ts
/** One entry in the read-only workspace browser. `path` is vault-relative. */
export interface LibraryNode {
  name: string; path: string; dir: boolean; size: number; children?: LibraryNode[];
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/library-view.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/web/library-view.ts src/web/dto.ts test/library-view.test.ts
git commit -m "feat(web): library-view tree and read with hard containment

Symlinks resolve before the containment check rather than after, and
the check requires root + separator so a sibling named <root>evil
cannot pass a bare startsWith. Both are covered by tests."
```

---

### Task 8: Library endpoints + view

**Files:**
- Modify: `src/web/server.ts`
- Modify: `ui2/src/api.ts`
- Create: `ui2/src/views/Library.tsx`
- Modify: `ui2/src/App.tsx`

**Interfaces:**
- Consumes: `libraryTree`, `libraryRead`, `LibraryNode` from Task 7; `vault.root` from `VaultWriter`.
- Produces: `GET /api/library/tree` → `{ nodes: LibraryNode[] }`; `GET /api/library/file?path=` → raw bytes with the file's MIME. Client: `api.libraryTree()`, `api.libraryFileUrl(path)`.

- [ ] **Step 1: Add the endpoints**

In `src/web/server.ts`, import `{ libraryTree, libraryRead } from "./library-view.js"` and add alongside the other `/api/` routes (inside the token gate, which they inherit automatically):

```ts
        if (path === "/api/library/tree" && req.method === "GET") {
          return json(res, 200, { nodes: libraryTree(vault.root) });
        }

        if (path === "/api/library/file" && req.method === "GET") {
          const rel = url.searchParams.get("path") ?? "";
          try {
            const f = libraryRead(vault.root, rel);
            res.writeHead(200, { "Content-Type": f.mime, "Content-Length": f.body.length });
            return res.end(f.body);
          } catch (err) {
            // Containment failures and missing files are both the caller's problem, and
            // distinguishing them in the response would confirm what exists outside the vault.
            return json(res, 404, { error: (err as Error).message });
          }
        }
```

`vault` is already destructured from `deps` at `web/server.ts:136`. Confirm `VaultWriter.root` is public — it is declared `readonly root: string` at `vault/writer.ts:30`.

- [ ] **Step 2: Add the client methods**

In `ui2/src/api.ts` (re-export `LibraryNode` from `dto.js` in the type block at the top):

```ts
  libraryTree: () => request<{ nodes: LibraryNode[] }>("/api/library/tree"),
  /** An <img>/<embed> src cannot send a bearer header, so text is fetched through request()
   *  and binaries are fetched here as a blob URL the browser can point an element at. */
  libraryBlobUrl: async (path: string): Promise<string> => {
    const res = await fetch(`/api/library/file?path=${encodeURIComponent(path)}`, {
      headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return URL.createObjectURL(await res.blob());
  },
```

- [ ] **Step 3: Create the view**

```tsx
// ui2/src/views/Library.tsx — read-only workspace browser (spec §4). Obsidian is a bonus
// viewer, not infrastructure: everything the org writes must be readable here.
import { useEffect, useState } from "react";
import { api, getToken, type LibraryNode } from "../api.js";

const isText = (p: string) => /\.(md|markdown|txt|json|csv|ya?ml)$/i.test(p);
const isImage = (p: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(p);
const isPdf = (p: string) => /\.pdf$/i.test(p);

function Tree({ nodes, onPick, active }: {
  nodes: LibraryNode[]; onPick: (p: string) => void; active: string;
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {nodes.map((n) => (
        <li key={n.path}>
          {n.dir ? (
            <details open>
              <summary className="cursor-pointer text-dim hover:text-fg">{n.name}</summary>
              <div className="pl-3 border-l border-line ml-1 mt-0.5">
                {n.children && <Tree nodes={n.children} onPick={onPick} active={active} />}
              </div>
            </details>
          ) : (
            <button onClick={() => onPick(n.path)}
              className={`text-left w-full truncate ${n.path === active ? "text-strong" : "text-dim hover:text-fg"}`}>
              {n.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function Library() {
  const [nodes, setNodes] = useState<LibraryNode[]>([]);
  const [path, setPath] = useState("");
  const [text, setText] = useState("");
  const [blob, setBlob] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.libraryTree().then((r) => setNodes(r.nodes))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!path) return;
    setText(""); setBlob(""); setError("");
    // `url` is a local, not the `blob` state: a cleanup that closed over state would capture
    // the value from the render that CREATED the effect — empty — and leak every object URL.
    let url = "";
    let cancelled = false;
    const fail = (e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); };
    if (isText(path)) {
      fetch(`/api/library/file?path=${encodeURIComponent(path)}`, {
        headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
      }).then((r) => r.text())
        .then((t) => { if (!cancelled) setText(t); })
        .catch(fail);
    } else {
      api.libraryBlobUrl(path)
        .then((u) => {
          // A selection that changed while the fetch was in flight still owns a URL to free.
          if (cancelled) return void URL.revokeObjectURL(u);
          url = u;
          setBlob(u);
        })
        .catch(fail);
    }
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [path]);

  return (
    <div className="h-full flex gap-4 p-4 overflow-hidden">
      <div className="w-56 shrink-0 overflow-y-auto text-[12px]">
        {nodes.length === 0 && !error && <div className="text-dim">Nothing here yet.</div>}
        <Tree nodes={nodes} onPick={setPath} active={path} />
      </div>
      <div className="flex-1 overflow-y-auto panel p-4">
        {error && <div className="text-[12px] text-err">{error}</div>}
        {!path && !error && <div className="text-dim">Pick a file.</div>}
        {text && <pre className="whitespace-pre-wrap text-[13px] leading-relaxed font-sans">{text}</pre>}
        {blob && isImage(path) && <img src={blob} alt={path} className="max-w-full" />}
        {blob && isPdf(path) && <embed src={blob} type="application/pdf" className="w-full h-[80vh]" />}
        {blob && !isImage(path) && !isPdf(path) && (
          <a href={blob} download={path.split("/").pop()} className="underline underline-offset-2">Download</a>
        )}
      </div>
    </div>
  );
}
```

The markdown is rendered as preformatted text, not parsed to HTML. That is deliberate: pulling in a markdown renderer to inject workspace content — written by agents — into `dangerouslySetInnerHTML` is an XSS path this view does not need. If rich rendering is wanted later it needs a sanitizer, and that is its own decision.

- [ ] **Step 4: Register the view**

Navigation is data-driven off one array, so a new section is four small edits — miss any one and the view is either unreachable or renders without a tab.

`ui2/src/lib/router.ts:6` — add the section (order here is the tab order):

```ts
export const SECTIONS = ["home", "goals", "staff", "mail", "schedule", "skills", "library", "system"] as const;
```

`ui2/src/components/BottomTabs.tsx:4` — add an icon, or the phone tab renders blank:

```ts
const ICONS: Record<string, string> = { home: "◉", goals: "◎", staff: "▤", mail: "✉", schedule: "◷", skills: "✦", library: "▦", system: "⚙" };
```

`ui2/src/App.tsx:21` — add the `g`-chord shortcut (`l` is free):

```ts
const JUMPS: Record<string, string> = { h: "home", g: "goals", s: "staff", m: "mail", r: "schedule", k: "skills", l: "library", y: "system" };
```

`ui2/src/App.tsx` — import `Library` and add its row beside the others (after the `skills` row, matching the `SECTIONS` order):

```tsx
      <div className={show("library")}><Library /></div>
```

- [ ] **Step 5: Typecheck both trees**

Run: `npx tsc --noEmit && cd ui2 && npm run typecheck && cd ..`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/web/server.ts ui2/src/api.ts ui2/src/views/Library.tsx ui2/src/App.tsx
git commit -m "feat(ui2): read-only Library view over the workspace

Tree plus content pane behind the existing UI-token gate. Markdown
renders as preformatted text rather than parsed HTML — agent-written
files are not trusted input for dangerouslySetInnerHTML."
```

---

### Task 9: Done screen and the port handover

The last step, and the only place the UI token is ever handed to the browser.

**Files:**
- Modify: `src/onboarding/server.ts`
- Modify: `ui2/src/api.ts`
- Modify: `ui2/src/views/Setup.tsx`
- Test: `test/onboarding-server.test.ts` (append)

**Interfaces:**
- Consumes: `world.startWeb()` from Task 1; `setToken` from `ui2/src/api.ts`.
- Produces: `POST /api/onboarding/advance { from: "first-job" }` → `{ step: "done", uiToken }`.

- [ ] **Step 1: Write the failing test**

Append to `test/onboarding-server.test.ts`:

```ts
describe("done handover", () => {
  it("returns the UI token and starts the web server when advancing to done", async () => {
    let started = 0;
    process.env.AIOS_UI_TOKEN = "tok-ui-abc";
    const { base } = await boot(async () => {}, {
      provisionFn: () => ({ ok: true, departments: ["ops"], agents: ["nova"], playbooks: [] }),
      boot: async () => fakeWorld({ startWeb: () => { started++; } }),
    }, "review");

    await fetch(`${base}/api/onboarding/provision`, { method: "POST", body: "{}" });
    const r = await fetch(`${base}/api/onboarding/advance`, {
      method: "POST", body: JSON.stringify({ from: "first-job" }),
    });
    const body = await r.json();
    expect(body.step).toBe("done");
    expect(body.uiToken).toBe("tok-ui-abc");

    // The port is handed over only after the setup server has actually let go of it.
    await new Promise((r2) => setTimeout(r2, 50));
    expect(started).toBe(1);
    delete process.env.AIOS_UI_TOKEN;
  });

  it("does not hand out a token on any other advance", async () => {
    const { base } = await boot(async () => {}, {}, "welcome");
    const r = await fetch(`${base}/api/onboarding/advance`, {
      method: "POST", body: JSON.stringify({ from: "welcome" }),
    });
    expect(await r.json()).toEqual({ step: "auth" });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/onboarding-server.test.ts`
Expected: FAIL — the advance response has no `uiToken` and `startWeb` is never called.

- [ ] **Step 3: Implement the handover**

Replace the generic advance handler in `src/onboarding/server.ts` with:

```ts
        if (path === "/api/onboarding/advance" && req.method === "POST") {
          const body = await readJson<{ from?: unknown }>(req);
          if (!body) return json(res, 400, { error: "body must be JSON" });
          const from = body.from;
          if (!isStep(from)) return json(res, 400, { error: "from must be a wizard step" });
          if (from === "auth") return json(res, 400, { error: "auth step requires a verified token" });

          // first-job → done is the handover: the browser gets the UI token in THIS response
          // (an endpoint fetched afterwards would already be gated), then the setup server
          // lets go of the port and the real web server takes it.
          if (from === "first-job") {
            let step: Step;
            try {
              step = wizard.advance("first-job");
            } catch (err) {
              log(`setup rejected ${path}: ${(err as Error).message}`);
              return json(res, 400, { error: (err as Error).message });
            }
            const uiToken = process.env.AIOS_UI_TOKEN ?? "";
            json(res, 200, { step, uiToken });
            // Bind only once the port is genuinely free — startWeb inside close()'s callback,
            // never before it, or the rebind races the socket we are still holding.
            const w = world;
            res.on("finish", () => {
              server.close(() => {
                try {
                  w?.startWeb();
                } catch (err) {
                  log(`FATAL: mission control could not take the port: ${(err as Error).message}`);
                }
              });
            });
            return;
          }

          return transition(res, path, () => wizard.advance(from));
        }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/onboarding-server.test.ts`
Expected: PASS — the two new tests plus everything already in the file.

- [ ] **Step 5: Add the done screen**

In `ui2/src/api.ts`, widen the advance return type so the token is typed rather than cast:

```ts
  onboardingAdvance: (from: string) =>
    request<{ step: string; uiToken?: string }>("/api/onboarding/advance", {
      method: "POST", body: JSON.stringify({ from }),
    }),
```

In `ui2/src/views/Setup.tsx`, import `setToken` from `../api.js`, drop `"done"` from the placeholder branch, and add:

```tsx
function Done() {
  const [agents, setAgents] = useState<string[]>([]);
  useEffect(() => {
    api.onboardingProposal().then((r) => setAgents(r.proposal.agents.map((a) => a.name))).catch(() => {});
  }, []);
  return (
    <div className="panel w-full max-w-md p-6 flex flex-col gap-4 text-center">
      <div className="text-bright text-[19px] font-bold tracking-tight">You're set up</div>
      <p className="leading-relaxed">
        {agents.length > 0 ? `${agents.join(", ")} are on duty.` : "Your org is on duty."}{" "}
        Everything they write lands in your workspace, readable right here in the Library.
      </p>
      <p className="leading-relaxed text-dim text-[12px]">
        Next: connect Telegram or email so your team can reach you, or just ask for something in chat.
      </p>
      <Button variant="primary" onClick={() => window.location.reload()}>Open AIOS</Button>
    </div>
  );
}
```

The token must be stored the moment the advance resolves — before the reload, because the setup server is gone by then. In `FirstJob`'s continue handler (Task 6), change the call to:

```tsx
          api.onboardingAdvance("first-job").then((r) => {
            if (r.uiToken) setToken(r.uiToken);
            onNext(r.step);
          }).catch(() => {});
```

Register: `{step === "done" && <Done />}`. The placeholder branch at the top of `Setup` should now be unreachable for every step — delete it along with `SkipStep`.

- [ ] **Step 6: Typecheck both trees**

Run: `npx tsc --noEmit && cd ui2 && npm run typecheck && cd ..`
Expected: both clean.

- [ ] **Step 7: Full suite**

Run: `npx vitest run 2>&1 | grep -E "^ *Tests|^ *Test Files"`
Expected: baseline plus the new tests (roughly 213 files / ~1755 pass). No pre-existing test may fail.

- [ ] **Step 8: End-to-end walk on a scratch install**

Do NOT touch :4280.

```bash
lsof -ti:4294 || echo "4294 free"
rm -rf /tmp/aios-vp && mkdir -p /tmp/aios-vp/{agents,playbooks,data}
AIOS_AGENTS_DIR=/tmp/aios-vp/agents AIOS_PLAYBOOKS_DIR=/tmp/aios-vp/playbooks \
AIOS_DATA_DIR=/tmp/aios-vp/data AIOS_UI_PORT=4294 npm run dev
```

Then in a browser at `http://localhost:4294`: welcome → auth (paste the token from the repo `.env`; **never echo it into the transcript**) → workspace (pick a custom path under `/tmp/aios-vp/vault` and confirm it is created) → interview or the template gallery → review → create → **first job**.

Confirm, in order: the log shows `daemon booted in-process`; the first-job screen is reachable and prefilled; running it produces either a reply or a live DAG; Continue reaches `done`; clicking **Open AIOS** loads the cockpit authenticated; the Library lists the workspace and opens a markdown file. Then `rm -rf /tmp/aios-vp`.

- [ ] **Step 9: Commit**

```bash
git add src/onboarding/server.ts ui2/src/api.ts ui2/src/views/Setup.tsx test/onboarding-server.test.ts
git commit -m "feat(onboarding): done screen and the port handover

Advancing from first-job returns the UI token in the same response —
an endpoint fetched afterwards would already be gated — then closes
the setup server and starts mission control inside close()'s callback
so the rebind cannot race the socket."
```

---

## Verification

After Task 9, all of the following must hold:

- `npx vitest run` — every pre-existing test still passes; ~34 new tests added across four files.
- `npx tsc --noEmit` — clean.
- `cd ui2 && npm run typecheck` — clean.
- A scratch install walks welcome → done with no daemon restart, and the first job produces a visible result.
- The live daemon on :4280 is untouched throughout.

---

# Execution outcome (2026-08-01)

Executed via `superpowers:subagent-driven-development` in an isolated worktree. 22 commits from `09ad6a9`. Every task got a fresh implementer, a task review, and a scoped re-review of each fix round; the branch then got a whole-branch review, a fix wave, and a final scoped re-review.

**Result:** final verdict **READY**. Root suite 210 files / 1721 → **215 / 1831**. ui2 suite 15 / ~55 → **17 / 74**. Both typechecks clean. A live end-to-end walk passed on an isolated scratch daemon.

## The live walk (the verification that mattered)

Isolated scratch daemon on :4294, separate agents/playbooks/data dirs, channel tokens blanked, `ui2/dist` rebuilt. Setup mode → auth against the real API → workspace step (created the vault) → template → provision → **hot boot in-process** → first job dispatched to the coordinator, which **wrote `welcome.md` into the vault in ~20s** → handover returned `uiToken` + roster → mission control bound the port → 401 without the token, `mode: normal` with it → Library served the file, refused `.env` (404) and `../../../etc/passwd` (`path escapes the workspace`) → **a second daemon on the same port exited 1** with the singleton FATAL message. The user's live daemon on :4280 was untouched throughout.

## Where the plan was wrong

The plan's own code and tests were the main source of defects. Roughly a dozen assertions were found that passed while exercising nothing — several of them written into this file. The most consequential:

1. **The `close()` teardown hangs (Task 9).** `close()` inside `finish` fires ~3s later (keep-alive), and with one extra socket open it **never fires** — mission control would never bind. The plan's own 50 ms test would have gone red. Fixed with `setImmediate` + `closeAllConnections()`.
2. **`libraryTree` leaked outside the vault (Task 7).** Containment was applied only in `libraryRead`, and `statSync` follows symlinks — so `leakdir -> ~/.ssh` enumerated filenames and sizes into the JSON served to the UI.
3. **`libraryRead` ignored the dotfile policy `libraryTree` enforced (Task 8).** Read back a token from `.env` and a password-bearing URL from `.git/config` in a vault whose tree listed neither.
4. **The writability probe validated the wrong path (Task 3).** It probed `r.path`, but the daemon writes to `join(r.path, r.subdir)`, so an over-long subdir returned 200 and would have failed at the first artifact write.
5. **The hot-boot tests were vacuous (Task 4).** All four started at `review` with an empty store and 400'd on "no proposal" before reaching the boot path — including the race test guarding against double-booting the daemon, which passed vacuously.
6. **The polling effect keyed on a value it writes (Task 6)**, tearing down and rebuilding its interval on every status change; and a dispatch was watched only if a *second* request succeeded.
7. **`subdir: "."` reached the vault root (Task 2).** Denylist guard; replaced with an allowlist, which then had to be widened twice (Unicode, then combining marks for macOS NFD).
8. **`ui2 npm run build` does not typecheck.** It is `vite build`. Six tasks' UI would have shipped unverified. There are also **two** test suites; the root run does not include ui2's.

## Deliberate deviations from the spec

- **§2** — builtin now always writes `AIOS_VAULT_PATH`/`SUBDIR` (spec said "writes nothing"). Human-ruled: back-navigation would otherwise strand the daemon on a folder the user just rejected.
- **§4** — markdown renders as **preformatted text, not parsed HTML**. Agent-written files are untrusted model output; `dangerouslySetInnerHTML` without a sanitizer is a real XSS path. The user sees `# heading` literally. `.svg` was also dropped from the image MIME map (stored XSS).
- **§7** — no single E2E smoke test. Covered by segment tests plus the manual live walk above.

## Scope creep, both justified

`exitOnListenError` + the listen-error handler in `src/web/server.ts`, and the builtin `.env` write. The first is notable: adding the error listener **silently removed the daemon's only single-instance guard** (the unhandled `EADDRINUSE` *was* the singleton — there is no pidfile), so a second daemon would have run headless forever against the same DB. Restored with a required `fatal` flag, then confirmed live.

## Known-open, deliberately not fixed

- `BootedWorld.shutdown` exits the process and clears no timers, despite `() => Promise<void>`.
- `bootNormal` has no partial-teardown path, and **no test ever runs it** — the boot sequence's guarantees rest on reading and on the live walk.
- Done screen's `workspacePath()` fallback duplicates `config.ts` defaults as literals.
- Interrupting the daemon between provision and `done` strands the user at mission control's token gate (the token ships only on the `done` advance). Recoverable — it is in `.env` and the boot log — but this branch widens that window by putting a multi-minute step inside it.
