# Onboarding Foundation Implementation Plan (1/4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Daemon boots into a resumable browser setup wizard when no auth/org exists — welcome + auth steps working end-to-end — and personal constants leave the code.

**Architecture:** A `bootMode()` check at the top of `main()` short-circuits into a minimal setup HTTP server (`src/onboarding/`) that serves the ui2 bundle plus wizard endpoints; wizard state is a pure state machine persisted in the existing `kv` table; token verification is one minimal SDK call behind an injectable ping. De-personalization gates halalo behind `AIOS_HALALO_DIR`, drops the IDAMA default, and moves the vault default to `~/AIOS/workspace`.

**Tech Stack:** TypeScript, node:http, node:sqlite (existing `Store.kvGet/kvSet`), `@anthropic-ai/claude-agent-sdk` `query()`, vitest, React (ui2).

Spec: `docs/superpowers/specs/2026-07-29-onboarding-product-design.md` (Sections 1, 2, 7).

## Global Constraints

- No new npm dependencies.
- Subscription auth only: `CLAUDE_CODE_OAUTH_TOKEN`, never `ANTHROPIC_API_KEY` prompts (memory: subscription-auth-not-api).
- Wizard step order (spec §1): `welcome → auth → workspace → interview → review → provision → first-job → done`. This plan implements welcome + auth; later steps render a placeholder card.
- Setup mode starts ONLY web server + onboarding module — no channels, heartbeat, senses, packs.
- Routes stay thin and untested; pure modules carry the tests (repo convention from the hire/fire ship).
- RED tests must assert behavior, not just that an import exists (memory: vacuous-import-test).
- Existing install must keep working: local `.env` gets explicit values BEFORE defaults change (Task 7 order matters).
- Plan-level deviations from spec, both deliberate: (1) step persistence uses the existing `kv` table (`onboarding.step` key), not a new `onboarding` table — same SQLite durability, zero migration; (2) boot check tests token *presence* only — *validity* is the auth step's SDK ping (boot can't afford a network call).
- Deferred to plan 2/4 (noted in spec): `agents/` leaving git + test-fixture re-anchoring (needs templates as the new QA baseline); moving `_capabilities.yaml` out of `agents/`; the Connect card that renders the launchd template; runtime-401 banner.
- Commits end with the repo trailers (Co-Authored-By + Claude-Session).

---

## File Structure

- **Create** `src/web/env-file.ts` — `updateEnvFile` extracted from server.ts (auth step + config PUT share it).
- **Create** `src/onboarding/mode.ts` — `bootMode`, `countAgentManifests`.
- **Create** `src/onboarding/wizard.ts` — step list + state machine over a kv interface.
- **Create** `src/onboarding/auth.ts` — `verifyToken` with injectable ping; `sdkPing` default.
- **Create** `src/onboarding/server.ts` — setup-mode HTTP server (static + 4 endpoints).
- **Modify** `src/index.ts` — setup-mode short-circuit at top of `main()`.
- **Modify** `src/web/server.ts` — import `updateEnvFile`; add `mode: "normal"` to `/api/state`.
- **Modify** `src/web/dto.ts` — `StateInfo.mode`.
- **Modify** `src/config.ts` — vault default → `~/AIOS/workspace`; `financeCompany` default → `""`.
- **Modify** `src/agents/registry/extras.ts` — `HALALO_DIR` from env only; halalo extras conditional.
- **Modify** `src/agents/guards/index.ts` — `halaloDir` optional; guard throws clear error if invoked unset.
- **Create** `launchd/aios.plist.template` (replaces tracked `launchd/com.ihab.aios.plist`).
- **Modify** `ui2/src/api.ts`, `ui2/src/App.tsx`; **Create** `ui2/src/views/Setup.tsx`.
- **Tests:** `test/env-file.test.ts`, `test/onboarding-mode.test.ts`, `test/onboarding-wizard.test.ts`, `test/onboarding-auth.test.ts`, `test/onboarding-server.test.ts`; extend `test/config.test.ts`.

---

### Task 1: Extract `updateEnvFile` to `src/web/env-file.ts`

**Files:**
- Create: `src/web/env-file.ts`
- Modify: `src/web/server.ts:134-140` (delete local fn, import instead)
- Test: `test/env-file.test.ts`

**Interfaces:**
- Produces: `updateEnvFile(envPath: string, key: string, value: string): void` — upserts `KEY=value` line, preserves other lines, single trailing newline. Tasks 5 and 7 consume it.

- [ ] **Step 1: Write the failing test**

```typescript
// test/env-file.test.ts — updateEnvFile: upsert semantics on a real temp file.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updateEnvFile } from "../src/web/env-file.js";

describe("updateEnvFile", () => {
  it("replaces an existing key in place and appends a new one", () => {
    const dir = mkdtempSync(join(tmpdir(), "envf-"));
    const p = join(dir, ".env");
    writeFileSync(p, "A=1\nB=2\n");
    updateEnvFile(p, "A", "9");
    updateEnvFile(p, "C", "3");
    expect(readFileSync(p, "utf8")).toBe("A=9\nB=2\nC=3\n");
  });

  it("creates the file when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "envf-"));
    const p = join(dir, ".env");
    updateEnvFile(p, "TOKEN", "abc");
    expect(readFileSync(p, "utf8")).toBe("TOKEN=abc\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/env-file.test.ts`
Expected: FAIL — cannot resolve `../src/web/env-file.js`. Read the vitest "Tests" line, never piped exit codes.

- [ ] **Step 3: Create `src/web/env-file.ts`**

Move the function body verbatim from `src/web/server.ts:134-140`:

```typescript
// src/web/env-file.ts — .env upsert shared by the config PUT and the onboarding auth step.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export function updateEnvFile(envPath: string, key: string, value: string): void {
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n") : [];
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(envPath, lines.join("\n").replace(/\n*$/, "\n"));
}
```

In `src/web/server.ts`: delete the local `function updateEnvFile` (lines 134-140) and add to the imports near the top:

```typescript
import { updateEnvFile } from "./env-file.js";
```

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run test/env-file.test.ts` → PASS.
Run: `npm run build` → clean (server.ts import resolves).

- [ ] **Step 5: Commit**

```bash
git add src/web/env-file.ts src/web/server.ts test/env-file.test.ts
git commit -m "refactor(web): extract updateEnvFile for onboarding reuse"
```

---

### Task 2: Boot mode decision — `src/onboarding/mode.ts`

**Files:**
- Create: `src/onboarding/mode.ts`
- Test: `test/onboarding-mode.test.ts`

**Interfaces:**
- Produces: `bootMode(env: NodeJS.ProcessEnv, agentsDir: string): "setup" | "normal"` and `countAgentManifests(agentsDir: string): number`. Task 6 (index.ts wiring) consumes `bootMode`.
- Rules: setup when no `CLAUDE_CODE_OAUTH_TOKEN` **and** no `ANTHROPIC_API_KEY`, or when zero agent manifests. Agent manifest = any `*.yaml` in a non-`_`-prefixed subdirectory of `agentsDir`, excluding `department.yaml`. A missing `agentsDir` counts as zero.

- [ ] **Step 1: Write the failing test**

```typescript
// test/onboarding-mode.test.ts — bootMode: token presence × org presence (spec §1).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootMode, countAgentManifests } from "../src/onboarding/mode.js";

function orgDir(withAgent: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "mode-"));
  mkdirSync(join(dir, "ops"));
  writeFileSync(join(dir, "ops", "department.yaml"), "department: ops\n");
  writeFileSync(join(dir, "_capabilities.yaml"), "web: { tools: [WebSearch] }\n");
  mkdirSync(join(dir, "_retired"));
  writeFileSync(join(dir, "_retired", "old.yaml"), "name: old\n");
  if (withAgent) writeFileSync(join(dir, "ops", "neo.yaml"), "name: neo\n");
  return dir;
}
const TOKEN = { CLAUDE_CODE_OAUTH_TOKEN: "tok" } as NodeJS.ProcessEnv;
const NO_TOKEN = {} as NodeJS.ProcessEnv;

describe("countAgentManifests", () => {
  it("counts agent yamls only — not department.yaml, _capabilities.yaml, or _retired/", () => {
    expect(countAgentManifests(orgDir(true))).toBe(1);
    expect(countAgentManifests(orgDir(false))).toBe(0);
    expect(countAgentManifests(join(tmpdir(), "does-not-exist-xyz"))).toBe(0);
  });
});

describe("bootMode", () => {
  it("setup when token missing, regardless of org", () => {
    expect(bootMode(NO_TOKEN, orgDir(true))).toBe("setup");
  });
  it("setup when org empty, despite token", () => {
    expect(bootMode(TOKEN, orgDir(false))).toBe("setup");
  });
  it("normal when token present and org non-empty", () => {
    expect(bootMode(TOKEN, orgDir(true))).toBe("normal");
  });
  it("ANTHROPIC_API_KEY also counts as auth (matches assertAuth)", () => {
    expect(bootMode({ ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv, orgDir(true))).toBe("normal");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onboarding-mode.test.ts`
Expected: FAIL — cannot resolve `../src/onboarding/mode.js`.

- [ ] **Step 3: Implement**

```typescript
// src/onboarding/mode.ts — first-run detection (onboarding spec §1).
// Presence check only: token *validity* is the auth step's SDK ping, not boot's job.
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Agent yamls in non-underscore subdirs, excluding department.yaml (mirrors loader's walk). */
export function countAgentManifests(agentsDir: string): number {
  if (!existsSync(agentsDir)) return 0;
  let n = 0;
  for (const entry of readdirSync(agentsDir)) {
    if (entry.startsWith("_")) continue;
    const sub = join(agentsDir, entry);
    if (!statSync(sub).isDirectory()) continue;
    for (const f of readdirSync(sub)) {
      if (f.endsWith(".yaml") && f !== "department.yaml") n++;
    }
  }
  return n;
}

export function bootMode(env: NodeJS.ProcessEnv, agentsDir: string): "setup" | "normal" {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY) return "setup";
  return countAgentManifests(agentsDir) > 0 ? "normal" : "setup";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/onboarding-mode.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/mode.ts test/onboarding-mode.test.ts
git commit -m "feat(onboarding): bootMode first-run detection"
```

---

### Task 3: Wizard state machine — `src/onboarding/wizard.ts`

**Files:**
- Create: `src/onboarding/wizard.ts`
- Test: `test/onboarding-wizard.test.ts`

**Interfaces:**
- Consumes: a kv duck (`kvGet(key): string | undefined`, `kvSet(key, value): void`) — `Store` already satisfies it (`src/store/db.ts:1149-1156`).
- Produces (Tasks 5+ and plans 2/3 consume):
  - `STEPS: readonly ["welcome","auth","workspace","interview","review","provision","first-job","done"]`, `type Step`
  - `class Wizard { constructor(kv); current(): Step; advance(from: Step): Step; goBack(to: Step): Step }`
  - `advance` throws unless `from` equals current (stale-client guard); `done` never advances. `goBack` throws unless target is strictly earlier than current. Both persist under kv key `"onboarding.step"`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/onboarding-wizard.test.ts — linear resumable step machine (spec §1).
import { describe, it, expect } from "vitest";
import { Wizard, STEPS } from "../src/onboarding/wizard.js";

function kv() {
  const m = new Map<string, string>();
  return { kvGet: (k: string) => m.get(k), kvSet: (k: string, v: string) => void m.set(k, v) };
}

describe("Wizard", () => {
  it("starts at welcome and advances in spec order", () => {
    const w = new Wizard(kv());
    expect(w.current()).toBe("welcome");
    expect(w.advance("welcome")).toBe("auth");
    expect(w.current()).toBe("auth");
  });

  it("rejects advance from a stale step", () => {
    const w = new Wizard(kv());
    w.advance("welcome");
    expect(() => w.advance("welcome")).toThrow(/current step is auth/);
  });

  it("resumes from persisted state (new instance, same kv)", () => {
    const store = kv();
    new Wizard(store).advance("welcome");
    expect(new Wizard(store).current()).toBe("auth");
  });

  it("goes back only to earlier steps", () => {
    const w = new Wizard(kv());
    w.advance("welcome");
    expect(w.goBack("welcome")).toBe("welcome");
    expect(() => w.goBack("review")).toThrow(/cannot go back/);
  });

  it("done is terminal", () => {
    const store = kv();
    store.kvSet("onboarding.step", "done");
    expect(() => new Wizard(store).advance("done")).toThrow(/terminal/);
  });

  it("ignores garbage persisted values", () => {
    const store = kv();
    store.kvSet("onboarding.step", "bogus");
    expect(new Wizard(store).current()).toBe("welcome");
  });

  it("step list matches the spec exactly", () => {
    expect([...STEPS]).toEqual(["welcome", "auth", "workspace", "interview", "review", "provision", "first-job", "done"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onboarding-wizard.test.ts`
Expected: FAIL — cannot resolve `../src/onboarding/wizard.js`.

- [ ] **Step 3: Implement**

```typescript
// src/onboarding/wizard.ts — server-side wizard state machine (spec §1).
// The browser is a thin renderer; every transition is validated here and persisted
// in the existing kv table so refresh/crash resumes in place.

export const STEPS = ["welcome", "auth", "workspace", "interview", "review", "provision", "first-job", "done"] as const;
export type Step = (typeof STEPS)[number];

export interface KvLike {
  kvGet(key: string): string | undefined;
  kvSet(key: string, value: string): void;
}

const KEY = "onboarding.step";

export class Wizard {
  constructor(private kv: KvLike) {}

  current(): Step {
    const raw = this.kv.kvGet(KEY);
    return (STEPS as readonly string[]).includes(raw ?? "") ? (raw as Step) : "welcome";
  }

  /** Advance one step; `from` must match current so a stale browser tab cannot double-advance. */
  advance(from: Step): Step {
    const cur = this.current();
    if (from !== cur) throw new Error(`stale advance from "${from}" — current step is ${cur}`);
    if (cur === "done") throw new Error("wizard is terminal (done)");
    const next = STEPS[STEPS.indexOf(cur) + 1];
    this.kv.kvSet(KEY, next);
    return next;
  }

  /** Back-navigation to any completed (strictly earlier) step. */
  goBack(to: Step): Step {
    const cur = this.current();
    if (STEPS.indexOf(to) >= STEPS.indexOf(cur)) throw new Error(`cannot go back to "${to}" from ${cur}`);
    this.kv.kvSet(KEY, to);
    return to;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/onboarding-wizard.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/wizard.ts test/onboarding-wizard.test.ts
git commit -m "feat(onboarding): resumable wizard state machine"
```

---

### Task 4: Token verification — `src/onboarding/auth.ts`

**Files:**
- Create: `src/onboarding/auth.ts`
- Test: `test/onboarding-auth.test.ts`

**Interfaces:**
- Produces (Task 5 consumes):
  - `type Ping = () => Promise<void>`
  - `sdkPing: Ping` — real one-shot SDK call (untested; exercised in production).
  - `verifyToken(token: string, ping?: Ping): Promise<{ ok: true } | { ok: false; error: string }>` — sets `process.env.CLAUDE_CODE_OAUTH_TOKEN` for the ping; **restores the previous value on failure** so a bad paste can't poison the process.
- Pattern reference: minimal `query()` call shape is `src/heartbeat/triage.ts:130` (`modelClassifier`).

- [ ] **Step 1: Write the failing test**

```typescript
// test/onboarding-auth.test.ts — verifyToken: env set/restore + error surfacing (spec §2).
import { describe, it, expect, afterEach } from "vitest";
import { verifyToken } from "../src/onboarding/auth.js";

const ORIG = process.env.CLAUDE_CODE_OAUTH_TOKEN;
afterEach(() => {
  if (ORIG === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIG;
});

describe("verifyToken", () => {
  it("rejects an empty token without pinging", async () => {
    let pinged = false;
    const r = await verifyToken("  ", async () => { pinged = true; });
    expect(r).toEqual({ ok: false, error: "token required" });
    expect(pinged).toBe(false);
  });

  it("keeps the env token on success", async () => {
    const r = await verifyToken("good-tok", async () => {});
    expect(r).toEqual({ ok: true });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("good-tok");
  });

  it("surfaces the ping error and restores the previous env value", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "old-tok";
    const r = await verifyToken("bad-tok", async () => { throw new Error("401 invalid x-api-key"); });
    expect(r).toEqual({ ok: false, error: "401 invalid x-api-key" });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("old-tok");
  });

  it("removes the env var on failure when none was set before", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    await verifyToken("bad-tok", async () => { throw new Error("nope"); });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onboarding-auth.test.ts`
Expected: FAIL — cannot resolve `../src/onboarding/auth.js`.

- [ ] **Step 3: Implement**

```typescript
// src/onboarding/auth.ts — token verification via one minimal SDK call (spec §2).
// The ping is injectable so tests never touch the network; sdkPing is the production default.
import { query } from "@anthropic-ai/claude-agent-sdk";

export type Ping = () => Promise<void>;

/** One-shot, no tools, no session — the cheapest call that proves the token works. */
export const sdkPing: Ping = async () => {
  const q = query({
    prompt: "ping",
    options: { allowedTools: [], maxTurns: 1, settingSources: [], persistSession: false },
  });
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype === "success") return;
      throw new Error(`auth check failed: ${msg.subtype}`);
    }
  }
  throw new Error("auth check failed: no result from SDK");
};

export async function verifyToken(
  token: string, ping: Ping = sdkPing,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = token.trim();
  if (!t) return { ok: false, error: "token required" };
  const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = t;
  try {
    await ping();
    return { ok: true };
  } catch (err) {
    if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
    return { ok: false, error: (err as Error).message };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/onboarding-auth.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/auth.ts test/onboarding-auth.test.ts
git commit -m "feat(onboarding): token verification with injectable SDK ping"
```

---

### Task 5: Setup server + boot wiring

**Files:**
- Create: `src/onboarding/server.ts`
- Modify: `src/index.ts` (short-circuit right after `loadConfig()`, before `assertAuth()`)
- Test: `test/onboarding-server.test.ts` (integration over real HTTP — the one exception to "routes untested", because this server IS the deliverable)

**Interfaces:**
- Consumes: `Wizard`/`STEPS` (Task 3), `verifyToken`/`Ping` (Task 4), `updateEnvFile` (Task 1), `bootMode` (Task 2), `Store` (kv duck).
- Produces: `startSetupServer(deps: SetupDeps): Server` where

```typescript
export interface SetupDeps {
  store: { kvGet(k: string): string | undefined; kvSet(k: string, v: string): void };
  envPath: string;
  uiDist: string;
  port: number;          // 0 = ephemeral (tests)
  ping?: Ping;           // test seam; defaults to sdkPing
  log?: (line: string) => void;
}
```

- Endpoints:
  - `GET /api/state` → `200 { mode: "setup", step: Step }`
  - `POST /api/onboarding/advance` body `{ from: Step }` → `200 { step }` | `400 { error }` (auth cannot be skipped this way: `from: "auth"` is rejected — only the auth endpoint advances past auth)
  - `POST /api/onboarding/back` body `{ to: Step }` → `200 { step }` | `400 { error }`
  - `POST /api/onboarding/auth` body `{ token: string }` → verify → `updateEnvFile` → advance → `200 { step }`; failure `400 { error }` with the real SDK error
  - anything else under `/api/` → `404`; everything else → static file from `uiDist` with index.html fallback (SPA)

- [ ] **Step 1: Write the failing test**

```typescript
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onboarding-server.test.ts`
Expected: FAIL — cannot resolve `../src/onboarding/server.js`.

- [ ] **Step 3: Implement `src/onboarding/server.ts`**

```typescript
// src/onboarding/server.ts — setup-mode HTTP server (spec §1): ui2 static + wizard endpoints.
// Deliberately self-contained: web/server.ts needs the whole booted world; this needs a kv store,
// an env path, and a dist dir. The browser is a thin renderer of this server's state.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { Wizard, STEPS, type Step, type KvLike } from "./wizard.js";
import { verifyToken, sdkPing, type Ping } from "./auth.js";
import { updateEnvFile } from "../web/env-file.js";

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

export interface SetupDeps {
  store: KvLike;
  envPath: string;
  uiDist: string;
  port: number;
  ping?: Ping;
  log?: (line: string) => void;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const isStep = (s: unknown): s is Step => (STEPS as readonly string[]).includes(s as string);

export function startSetupServer(deps: SetupDeps): Server {
  const wizard = new Wizard(deps.store);
  const ping = deps.ping ?? sdkPing;
  const log = deps.log ?? (() => {});

  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      try {
        if (path === "/api/state" && req.method === "GET") {
          return json(res, 200, { mode: "setup", step: wizard.current() });
        }
        if (path === "/api/onboarding/advance" && req.method === "POST") {
          const { from } = JSON.parse(await readBody(req)) as { from?: unknown };
          if (!isStep(from)) return json(res, 400, { error: "from must be a wizard step" });
          // Auth advances only through the auth endpoint (verified token), never generically.
          if (from === "auth") return json(res, 400, { error: "auth step requires a verified token" });
          return json(res, 200, { step: wizard.advance(from) });
        }
        if (path === "/api/onboarding/back" && req.method === "POST") {
          const { to } = JSON.parse(await readBody(req)) as { to?: unknown };
          if (!isStep(to)) return json(res, 400, { error: "to must be a wizard step" });
          return json(res, 200, { step: wizard.goBack(to) });
        }
        if (path === "/api/onboarding/auth" && req.method === "POST") {
          const { token } = JSON.parse(await readBody(req)) as { token?: unknown };
          const v = await verifyToken(typeof token === "string" ? token : "", ping);
          if (!v.ok) return json(res, 400, { error: v.error });
          updateEnvFile(deps.envPath, "CLAUDE_CODE_OAUTH_TOKEN", (token as string).trim());
          return json(res, 200, { step: wizard.advance("auth") });
        }
        if (path.startsWith("/api/")) return json(res, 404, { error: "not found" });

        // Static SPA: exact file if present, index.html otherwise.
        const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
        const file = join(deps.uiDist, safe);
        const target = existsSync(file) && statSync(file).isFile() ? file : join(deps.uiDist, "index.html");
        res.writeHead(200, { "Content-Type": MIME[extname(target)] ?? "text/html" });
        res.end(readFileSync(target));
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    })().catch((err) => json(res, 500, { error: (err as Error).message }));
  });

  server.listen(deps.port, () => log(`setup wizard listening on :${deps.port}`));
  return server;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/onboarding-server.test.ts` → PASS.

- [ ] **Step 5: Wire into `src/index.ts`**

In `main()`, immediately after `const config = loadConfig();` and BEFORE `assertAuth();` (src/index.ts:76-78), insert:

```typescript
  // Setup mode (onboarding spec §1): no auth or no org → wizard only.
  // Nothing that assumes an org may start — no channels, heartbeat, senses, or packs.
  if (bootMode(process.env, config.agentsDir) === "setup") {
    const store = new Store(config.dbPath);
    startSetupServer({
      store, envPath: config.envPath, uiDist: config.uiDist, port: config.uiPort, log,
    });
    log(`setup mode: open http://localhost:${config.uiPort} to begin onboarding`);
    return; // restart after onboarding completes boots normal mode
  }
```

Add imports at the top of index.ts:

```typescript
import { bootMode } from "./onboarding/mode.js";
import { startSetupServer } from "./onboarding/server.js";
```

- [ ] **Step 6: Full test suite + build**

Run: `npm run build` → clean. Run: `npx vitest run` → all pass (read the "Tests" summary line).

- [ ] **Step 7: Commit**

```bash
git add src/onboarding/server.ts src/index.ts test/onboarding-server.test.ts
git commit -m "feat(onboarding): setup-mode HTTP server + boot short-circuit"
```

---

### Task 6: Wizard UI — Setup view + mode branch

**Files:**
- Modify: `src/web/server.ts` (`/api/state` gains `mode: "normal"`, `src/web/server.ts:193`)
- Modify: `src/web/dto.ts` (`StateInfo.mode`, `src/web/dto.ts:16`)
- Modify: `ui2/src/api.ts` (setup calls)
- Modify: `ui2/src/App.tsx` (early-return branch)
- Create: `ui2/src/views/Setup.tsx`
- Check: `cd ui2 && npm run build` (ui2 has no route tests; build is the gate, matching the hire/fire ship)

**Interfaces:**
- Consumes: Task 5's endpoints.
- Produces: `StateInfo` gains `mode?: "setup" | "normal"` and `step?: string`. `App` renders `<Setup/>` full-screen when `state.mode === "setup"`.

- [ ] **Step 1: Server + dto**

In `src/web/server.ts` `/api/state` handler (line 193), add `mode: "normal",` as the first property of the response object.

In `src/web/dto.ts` `StateInfo`, add:

```typescript
  /** "setup" while the onboarding wizard owns the UI; "normal" for the cockpit. */
  mode?: "setup" | "normal";
  /** Current wizard step when mode === "setup". */
  step?: string;
```

- [ ] **Step 2: ui2 api calls**

In `ui2/src/api.ts`, next to `state: () => request<StateInfo>("/api/state"),` add:

```typescript
  onboardingAdvance: (from: string) =>
    request<{ step: string }>("/api/onboarding/advance", { method: "POST", body: JSON.stringify({ from }) }),
  onboardingBack: (to: string) =>
    request<{ step: string }>("/api/onboarding/back", { method: "POST", body: JSON.stringify({ to }) }),
  onboardingAuth: (token: string) =>
    request<{ step: string }>("/api/onboarding/auth", { method: "POST", body: JSON.stringify({ token }) }),
```

(Match the file's existing `request` helper signature — check how other POSTs in that file pass options and copy that shape exactly.)

- [ ] **Step 3: Create `ui2/src/views/Setup.tsx`**

Follow ui2 idiom (check `ui2/src/views/Staff.tsx` for Button/input class conventions and reuse its patterns; Tailwind classes below are indicative — match the file's tokens):

```tsx
// ui2/src/views/Setup.tsx — onboarding wizard shell (spec §1-2): welcome + auth live,
// later steps placeholder until the org/workspace phases ship.
import { useState } from "react";
import { api } from "../api.js";

const STEPS = ["welcome", "auth", "workspace", "interview", "review", "provision", "first-job", "done"];
const LABELS: Record<string, string> = {
  welcome: "Welcome", auth: "Claude account", workspace: "Workspace", interview: "Interview",
  review: "Review org", provision: "Provision", "first-job": "First job", done: "Done",
};

export function Setup({ step, onStepChange }: { step: string; onStepChange: (s: string) => void }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-6">
      <ol className="flex gap-2 text-xs opacity-70">
        {STEPS.map((s) => (
          <li key={s} className={s === step ? "font-bold underline" : ""}>{LABELS[s]}</li>
        ))}
      </ol>
      {step === "welcome" && <Welcome onNext={onStepChange} />}
      {step === "auth" && <Auth onNext={onStepChange} />}
      {!["welcome", "auth"].includes(step) && (
        <div className="max-w-md text-center opacity-80">
          <h2 className="text-lg mb-2">Almost there</h2>
          <p>Org setup ({LABELS[step]}) arrives in the next phase. Restart the daemon after adding
            agents manually, or wait for the org wizard.</p>
        </div>
      )}
    </div>
  );
}

function Welcome({ onNext }: { onNext: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="max-w-md text-center flex flex-col gap-4">
      <h1 className="text-2xl">AIOS</h1>
      <p>Your always-on team of AI specialists. A few steps: connect your Claude
        subscription, pick a workspace, and build your org.</p>
      <button disabled={busy} onClick={() => {
        setBusy(true);
        void api.onboardingAdvance("welcome").then((r) => onNext(r.step)).finally(() => setBusy(false));
      }}>Get started</button>
    </div>
  );
}

function Auth({ onNext }: { onNext: (s: string) => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [noCli, setNoCli] = useState(false);
  const submit = async () => {
    setBusy(true); setError(undefined);
    try {
      const r = await api.onboardingAuth(token);
      onNext(r.step);
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <div className="max-w-md flex flex-col gap-3">
      <h2 className="text-lg">Connect your Claude subscription</h2>
      <p>AIOS runs on your Claude plan — no API key, no per-token billing. In a terminal, run:</p>
      <code className="p-2 rounded bg-black/20 select-all">claude setup-token</code>
      <button className="text-xs underline self-start" onClick={() => setNoCli(!noCli)}>
        I don't have the claude command
      </button>
      {noCli && <code className="p-2 rounded bg-black/20 select-all">npm i -g @anthropic-ai/claude-code</code>}
      <p>Log in with your normal Claude account, then paste the token:</p>
      <input type="password" placeholder="paste token" value={token} onChange={(e) => setToken(e.target.value)} />
      {error && <p className="text-red-400 text-sm">{error}</p>}
      <button disabled={busy || !token.trim()} onClick={() => void submit()}>
        {busy ? "Verifying…" : "Verify & continue"}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Branch in `ui2/src/App.tsx`**

After the `useFetch(() => api.state(), [])` line (App.tsx:25), add local step state + early return before the cockpit shell renders (before the TokenGate/TopBar JSX):

```tsx
  const [setupStep, setSetupStep] = useState<string>();
  if (state?.mode === "setup") {
    return <Setup step={setupStep ?? state.step ?? "welcome"} onStepChange={setSetupStep} />;
  }
```

Import: `import { Setup } from "./views/Setup.js";`

- [ ] **Step 5: Build both**

Run: `npm run build` (root) → clean. Run: `cd ui2 && npm run build` → clean.

- [ ] **Step 6: Manual smoke (proof, not vibes)**

In a scratch dir: `AIOS_AGENTS_DIR=/tmp/empty-agents AIOS_DATA_DIR=/tmp/aios-setup-smoke npx tsx src/index.ts` with `CLAUDE_CODE_OAUTH_TOKEN` unset → expect the log line `setup mode: open http://localhost:4280`; `curl localhost:4280/api/state` → `{"mode":"setup","step":"welcome"}`. Kill it. (Real-token auth walk happens in Task 8's verification.)

- [ ] **Step 7: Commit**

```bash
git add src/web/server.ts src/web/dto.ts ui2/src/api.ts ui2/src/App.tsx ui2/src/views/Setup.tsx
git commit -m "feat(ui2): onboarding wizard shell — welcome + auth steps"
```

---

### Task 7: De-personalization — env-gate halalo, drop IDAMA, move vault default

**Files:**
- Modify: **local `.env` FIRST** (not tracked — protects the existing install before defaults change)
- Modify: `src/agents/registry/extras.ts:9-10, 24-31`
- Modify: `src/agents/guards/index.ts:11, 24`
- Modify: `src/config.ts:206, 229`
- Test: extend `test/config.test.ts`; run full suite for regressions (org-golden holds tool lists only — these changes don't touch tools, so NO golden regen expected; a golden diff means something went wrong)

**Interfaces:**
- Produces: `HALALO_DIR: string | undefined` (env-only); `GuardConfig.halaloDir?: string`; `buildExtras` omits the `halalo` entry when unset; `buildConfig` vault default `~/AIOS/workspace`, `financeCompany` default `""`.

- [ ] **Step 1: Protect the existing install — append to local `.env`**

Add these lines to `/Users/ihabbishara/projects/AIOS/.env` (values that today come from defaults about to change):

```
AIOS_VAULT_PATH=/Users/ihabbishara/Desktop/AI-Vault
AIOS_FINANCE_COMPANY=IDAMA
AIOS_HALALO_DIR=/Users/ihabbishara/projects/halalo-php-source/halalo
```

Check first with Read that they aren't already set; skip any that are.

- [ ] **Step 2: Write the failing tests** (append to `test/config.test.ts`)

```typescript
describe("de-personalized defaults", () => {
  const SAVED: Record<string, string | undefined> = {};
  const KEYS = ["AIOS_VAULT_PATH", "AIOS_FINANCE_COMPANY", "AIOS_HALALO_DIR"];
  beforeEach(() => { for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

  it("vault defaults to ~/AIOS/workspace, finance company to empty", () => {
    const c = buildConfig(process.env, "/tmp/aios-root");
    expect(c.vaultPath.endsWith("/AIOS/workspace")).toBe(true);
    expect(c.vaultPath.includes("Desktop")).toBe(false);
    expect(c.financeCompany).toBe("");
  });
});
```

Add the imports the file is missing (`beforeEach`, `afterEach` from vitest, `buildConfig` from `../src/config.js`). Note `buildConfig` reads `process.env` directly for several keys (src/config.ts:201-229) — that's why the test scrubs the real env, not a passed object.

And a new file section in `test/agents-admin.test.ts`-style location — put it in `test/config.test.ts` too:

```typescript
describe("halalo env gating", () => {
  it("buildExtras omits halalo when AIOS_HALALO_DIR is unset", async () => {
    const prev = process.env.AIOS_HALALO_DIR;
    delete process.env.AIOS_HALALO_DIR;
    try {
      // dynamic import AFTER scrubbing env: HALALO_DIR is module-level
      const { buildExtras } = await import("../src/agents/registry/extras.js");
      const x = buildExtras({ vaultPath: "/tmp/v", vaultSubdir: "AIOS", financeCompany: "", financeMembers: [] });
      expect(x.halalo).toBeUndefined();
      expect(x.juno).toBeDefined();
    } finally {
      if (prev !== undefined) process.env.AIOS_HALALO_DIR = prev;
    }
  });
});
```

Caveat for the implementer: `HALALO_DIR` is evaluated at module load. If another test file already imported extras.ts with the env var set, this dynamic import may hit the module cache. If the assertion is flaky for that reason, restructure `buildExtras` to read `process.env.AIOS_HALALO_DIR` at call time instead of module level — that is the preferred implementation anyway (do it in Step 4, and export `HALALO_DIR` as a `halaloDir()` function if resolve.ts needs laziness; see Step 5).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — vault default still `Desktop/AI-Vault`, financeCompany still `IDAMA`, `x.halalo` defined.

- [ ] **Step 4: Implement config + extras changes**

`src/config.ts:206`:

```typescript
    vaultPath: process.env.AIOS_VAULT_PATH ?? join(home, "AIOS", "workspace"),
```

`src/config.ts:229`:

```typescript
    financeCompany: process.env.AIOS_FINANCE_COMPANY ?? "",
```

`src/agents/registry/extras.ts` — replace the module-level constant and gate the entry (call-time read, per the Step 2 caveat):

```typescript
/** Client project dir — env-only since onboarding (spec §7); no personal default. */
export const halaloDir = (): string | undefined => process.env.AIOS_HALALO_DIR;
```

In `buildExtras`, wrap the halalo entry:

```typescript
  const hDir = halaloDir();
  return {
    ...(hDir ? {
      halalo: {
        cwd: hDir,
        contextFiles: [join(hDir, "CLAUDE.md")],
        attachDirs: [HALALO_EXPORTS_DIR],
        promptSuffix: /* unchanged existing suffix text */,
      },
    } : {}),
    juno: /* unchanged */,
  };
```

- [ ] **Step 5: Update the two consumers**

`src/agents/resolve.ts:29,157` — `import { halaloDir } from "./registry/extras.js";` and `halaloDir: halaloDir(),`.

`src/agents/guards/index.ts:11` — `halaloDir?: string;` and line 24:

```typescript
  "halalo-readonly": (cfg) => {
    if (!cfg.halaloDir) throw new Error("halalo-readonly guard requires AIOS_HALALO_DIR");
    return { checks: halaloToolChecks(cfg.halaloDir), fallback: "deny" };
  },
```

(The throw fires only when an agent actually carries the `halalo-aws` capability without the env var — correct failure, loud and named.)

- [ ] **Step 6: Run the full suite + build**

Run: `npx vitest run` → all pass, including `test/resolve-agent.test.ts` (golden untouched — tools didn't change; the local `.env` from Step 1 keeps halalo resolvable in dev, and vitest loads `.env`? It does NOT — so if resolve-agent tests construct halalo, they now exercise the unset path; if any fail wanting `AIOS_HALALO_DIR`, set it inside the test's `setup()` via `process.env.AIOS_HALALO_DIR ??= "/tmp/halalo-fixture"` with a comment, not by weakening the gate).
Run: `npm run build` → clean.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/agents/registry/extras.ts src/agents/guards/index.ts src/agents/resolve.ts test/config.test.ts
git commit -m "feat(config): de-personalize defaults — halalo env-gated, IDAMA dropped, vault moved"
```

---

### Task 8: launchd template + README + verification

**Files:**
- Create: `launchd/aios.plist.template`
- Delete (tracked): `launchd/com.ihab.aios.plist` (keep a local untracked copy — it's installed in `~/Library/LaunchAgents` already)
- Modify: `README.md` (launchd section + one-paragraph setup-wizard mention)

**Interfaces:**
- Produces: template with `{{ROOT}}` and `{{NODE}}` placeholders; plan 4's Connect card renders + installs it.

- [ ] **Step 1: Read the current plist, then create the template**

Read `launchd/com.ihab.aios.plist` and reproduce it exactly with every absolute path parameterized: the repo path → `{{ROOT}}`, the node binary path → `{{NODE}}`, log paths → `{{ROOT}}/data/aios.log`. Label becomes `com.aios.daemon`. Keep `KeepAlive`/`RunAtLoad` as-is.

- [ ] **Step 2: Swap tracked files**

```bash
cp launchd/com.ihab.aios.plist /tmp/aios-plist-backup.plist   # safety copy
git rm launchd/com.ihab.aios.plist
git add launchd/aios.plist.template
```

Add `launchd/*.local.plist` to `.gitignore` (rendered copies stay untracked).

- [ ] **Step 3: README**

In the launchd section, replace the `cp launchd/com.ihab.aios.plist ...` instructions with: render the template by hand for now (`sed "s|{{ROOT}}|$PWD|g; s|{{NODE}}|$(which node)|g" launchd/aios.plist.template > ~/Library/LaunchAgents/com.aios.daemon.plist`), load with `launchctl load`. In the Setup section, add one line: fresh installs boot into a browser setup wizard at `http://localhost:4280` (token + org onboarding; org steps land in the next phase).

- [ ] **Step 4: Full-plan verification**

- `npm run build` + `npx vitest run` → all green (read the "Tests" line).
- Setup-mode smoke with a real token: `AIOS_AGENTS_DIR=/tmp/empty-agents AIOS_DATA_DIR=/tmp/aios-smoke npx tsx src/index.ts` (token present in env but empty agents dir) → wizard boots in setup mode because the org is empty; walk welcome → auth in the browser with the real token → lands on the workspace placeholder card; restart with the same env → `GET /api/state` shows `step: "workspace"` (resume works).
- Normal-mode regression: `npm run dev` in the repo (org present) → boots the full daemon exactly as before, `/api/state` now carries `mode: "normal"`.

- [ ] **Step 5: Commit**

```bash
git add launchd/aios.plist.template README.md .gitignore
git commit -m "chore(launchd): parameterized plist template; README setup-wizard note"
```

---

## Self-Review

**Spec coverage (Sections 1, 2, 7):**
- §1 setup/normal modes → Tasks 2, 5. Wizard state machine + SQLite persistence + resume → Tasks 3, 5. Thin-renderer browser + full-screen wizard → Task 6. `npx create-aios` package → NOT in this plan; it's packaging, deferred to plan 4 (Connect/polish) — clone + `npm run dev` reaches the wizard, which the spec names as the equivalent path. Flagged as a known deferral.
- §2 auth step: paste + verify + real error + no-CLI toggle → Tasks 4, 5, 6.
- §7 residue table: halalo (Task 7), IDAMA (Task 7), vault default (Task 7), launchd (Task 8), DB alias waves (spec says leave — left).
- Port-scan mitigation (spec §8 row 7) belongs to this plan's server? Spec assigns mitigations to their feature's plan; port scan is a boot concern — NOT implemented here, deferred to plan 4 polish. Flagged.

**Placeholder scan:** the one intentional non-literal is Task 7 Step 4's `promptSuffix: /* unchanged existing suffix text */` — it instructs keeping the exact current string from extras.ts:28 (visible to the implementer in the file being edited), not inventing content. Task 8 Step 1 similarly derives the template from the file being read. Both are transformations of in-file content, not TBDs.

**Type consistency:** `KvLike` defined in wizard.ts, consumed by server.ts deps (`store: KvLike`) — matches `Store.kvGet/kvSet` signatures at src/store/db.ts:1149-1156. `Ping` defined in auth.ts, threaded through `SetupDeps.ping`. `Step` exported from wizard.ts, used in server route guards. `halaloDir()` function shape consistent across extras.ts/resolve.ts (Task 7 Steps 4-5).
