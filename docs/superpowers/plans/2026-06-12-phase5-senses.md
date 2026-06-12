# Phase 5 — First Senses (Gmail + Calendar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-account Gmail + Calendar watchers feed the existing bus/triage/brief pipeline; four gated `email.*` executors and two moderator read tools make email conversational and safe.

**Architecture:** `src/senses/google/` — `auth.ts` (OAuth2 clients per account from `data/google-tokens.json`, degraded-account tracking), `gmail.ts` (poll via Gmail history API, incremental from kv historyId), `calendar.ts` (windowed snapshot-diff poll + meeting-soon pings). All API clients are injectable for tests. Events ride the Phase 4 bus → triage (new defaults + quiet-posture model prompt) → briefs (mail digest + meetings sections). Mutations go through Phase 3 gate executors.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` imports), `googleapis` npm (official), node:sqlite Store/kv (NEVER better-sqlite3), vitest with stub clients (no network in `npm test`).

**Spec:** `docs/superpowers/specs/2026-06-12-phase5-senses-design.md`

**Spec refinement (documented):** Calendar uses a windowed snapshot-diff (now → +7 days, diff vs kv snapshot keyed by `eventId → updated`) instead of `syncToken` — syncToken forbids window params, forces unbounded initial syncs, and adds 410-expiry handling for zero benefit at this scale. Emitted semantics are identical (`calendar.changed` on new/moved/cancelled within the window). The kv snapshot doubles as the brief assembler's meetings source.

**Conventions (Phases 3-4.5 precedent):** deps-object constructors, injectable `nowFn`/clients, per-watcher isolated loops with backoff, fail-quiet `log?.()`, kv for cursors, claim-style idempotence, `describe.skipIf`/opt-in for anything needing real credentials.

---

### Task 1: Config + event types

**Files:**
- Modify: `src/config.ts`
- Modify: `src/events.ts`
- Modify: `src/web/server.ts` (CONFIG_KEYS only)
- Test: `test/config.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.ts`:

```ts
describe("senses config", () => {
  it("defaults", () => {
    delete process.env.AIOS_GMAIL_POLL_SECONDS;
    delete process.env.AIOS_CALENDAR_POLL_SECONDS;
    delete process.env.AIOS_MEETING_PING_MINUTES;
    delete process.env.AIOS_GMAIL_SKIP_CATEGORIES;
    const cfg = loadConfig();
    expect(cfg.gmailPollSeconds).toBe(120);
    expect(cfg.calendarPollSeconds).toBe(300);
    expect(cfg.meetingPingMinutes).toBe(15);
    expect(cfg.gmailSkipCategories).toEqual(["promotions", "social"]);
  });

  it("overrides parse", () => {
    process.env.AIOS_GMAIL_POLL_SECONDS = "30";
    process.env.AIOS_GMAIL_SKIP_CATEGORIES = "promotions, updates ,forums";
    try {
      const cfg = loadConfig();
      expect(cfg.gmailPollSeconds).toBe(30);
      expect(cfg.gmailSkipCategories).toEqual(["promotions", "updates", "forums"]);
    } finally {
      delete process.env.AIOS_GMAIL_POLL_SECONDS;
      delete process.env.AIOS_GMAIL_SKIP_CATEGORIES;
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `gmailPollSeconds` undefined

- [ ] **Step 3: Implement**

`src/config.ts` — add to the `Config` interface (after `ttsVoice: string;`):

```ts
  gmailPollSeconds: number;
  calendarPollSeconds: number;
  meetingPingMinutes: number;
  /** Gmail categories never emitted as events (lowercase, e.g. "promotions"). */
  gmailSkipCategories: string[];
```

Add to the `loadConfig` return object (after `ttsVoice: ...`):

```ts
    gmailPollSeconds: Number(process.env.AIOS_GMAIL_POLL_SECONDS ?? 120),
    calendarPollSeconds: Number(process.env.AIOS_CALENDAR_POLL_SECONDS ?? 300),
    meetingPingMinutes: Number(process.env.AIOS_MEETING_PING_MINUTES ?? 15),
    gmailSkipCategories: (process.env.AIOS_GMAIL_SKIP_CATEGORIES ?? "promotions,social")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
```

`src/events.ts` — the union currently ends with the `triage.decision` variant. Replace its closing `;` line region so the union ends:

```ts
  | { type: "triage.decision"; eventType: string; verdict: string; via: "rule" | "default" | "model" }
  | { type: "mail.received"; account: string; messageId: string; threadId: string; from: string; to: string; subject: string; snippet: string; labels: string[]; receivedAt: string }
  | { type: "calendar.changed"; account: string; eventId: string; summary: string; start: string; end: string; status: string; organizer: string }
  | { type: "calendar.reminder"; account: string; eventId: string; summary: string; start: string; minutesUntil: number; link: string | null };
```

`src/web/server.ts` — append to `CONFIG_KEYS`:

```ts
  { key: "AIOS_GMAIL_POLL_SECONDS", secret: false },
  { key: "AIOS_CALENDAR_POLL_SECONDS", secret: false },
  { key: "AIOS_MEETING_PING_MINUTES", secret: false },
  { key: "AIOS_GMAIL_SKIP_CATEGORIES", secret: false },
```

- [ ] **Step 4: Verify**

Run: `npx vitest run test/config.test.ts && npx tsc --noEmit && npm test`
Expected: PASS; suite 188+1 (186 + 2)

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/events.ts src/web/server.ts test/config.test.ts
git commit -m "feat(senses): config, event types, editable poll settings"
```

---

### Task 2: googleapis dependency + auth module

**Files:**
- Modify: `package.json` (googleapis)
- Create: `src/senses/google/auth.ts`
- Test: `test/google-auth.test.ts`

- [ ] **Step 1: Install**

Run: `npm install googleapis`
Expected: `googleapis@^…` in dependencies.

- [ ] **Step 2: Write the failing tests**

```ts
// test/google-auth.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleAccounts, type TokensFile } from "../src/senses/google/auth.js";

function tokensFile(dir: string, content: unknown): string {
  const p = join(dir, "google-tokens.json");
  writeFileSync(p, JSON.stringify(content));
  return p;
}

const VALID: TokensFile = {
  clientId: "id", clientSecret: "secret",
  accounts: {
    personal: { email: "p@x.com", refreshToken: "rt1" },
    work: { email: "w@y.com", refreshToken: "rt2" },
  },
};

describe("GoogleAccounts", () => {
  it("disabled when the tokens file is missing", () => {
    const ga = GoogleAccounts.load(join(mkdtempSync(join(tmpdir(), "ga-")), "nope.json"));
    expect(ga.enabled()).toBe(false);
    expect(ga.accounts()).toHaveLength(0);
    expect(ga.disabledReason()).toContain("google-tokens.json");
  });

  it("disabled when the file has no accounts", () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-"));
    const ga = GoogleAccounts.load(tokensFile(dir, { clientId: "i", clientSecret: "s", accounts: {} }));
    expect(ga.enabled()).toBe(false);
  });

  it("loads accounts and builds clients", () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-"));
    const ga = GoogleAccounts.load(tokensFile(dir, VALID));
    expect(ga.enabled()).toBe(true);
    const accounts = ga.accounts();
    expect(accounts.map((a) => a.name)).toEqual(["personal", "work"]);
    expect(accounts[0].email).toBe("p@x.com");
    expect(accounts[0].gmail).toBeTruthy();
    expect(accounts[0].calendar).toBeTruthy();
  });

  it("tracks degraded accounts", () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-"));
    const ga = GoogleAccounts.load(tokensFile(dir, VALID));
    ga.markDegraded("work", "invalid_grant");
    expect(ga.degraded()).toEqual([{ name: "work", reason: "invalid_grant" }]);
    expect(ga.isDegraded("work")).toBe(true);
    expect(ga.isDegraded("personal")).toBe(false);
    ga.clearDegraded("work");
    expect(ga.degraded()).toHaveLength(0);
  });

  it("rejects malformed json gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-"));
    const p = join(dir, "google-tokens.json");
    writeFileSync(p, "not json{");
    const ga = GoogleAccounts.load(p);
    expect(ga.enabled()).toBe(false);
    expect(ga.disabledReason()).toContain("parse");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/google-auth.test.ts`
Expected: FAIL — module missing

- [ ] **Step 4: Implement `src/senses/google/auth.ts`**

```ts
// src/senses/google/auth.ts
import { existsSync, readFileSync } from "node:fs";
import { google, type gmail_v1, type calendar_v3 } from "googleapis";

export interface TokensFile {
  clientId: string;
  clientSecret: string;
  accounts: Record<string, { email: string; refreshToken: string }>;
}

export interface GoogleAccount {
  name: string;
  email: string;
  gmail: gmail_v1.Gmail;
  calendar: calendar_v3.Calendar;
}

/**
 * Loads data/google-tokens.json (written by scripts/google-auth.ts) and builds
 * one auto-refreshing OAuth2 client per account. Missing/invalid file → senses
 * disabled (voice pattern: one boot log line, nothing else breaks).
 */
export class GoogleAccounts {
  private list: GoogleAccount[] = [];
  private reason = "";
  private degradedMap = new Map<string, string>();

  static load(tokensPath: string): GoogleAccounts {
    const ga = new GoogleAccounts();
    if (!existsSync(tokensPath)) {
      ga.reason = `no google-tokens.json at ${tokensPath} — run: npx tsx scripts/google-auth.ts <account>`;
      return ga;
    }
    let file: TokensFile;
    try {
      file = JSON.parse(readFileSync(tokensPath, "utf8")) as TokensFile;
    } catch (err) {
      ga.reason = `google-tokens.json parse error: ${(err as Error).message}`;
      return ga;
    }
    const names = Object.keys(file.accounts ?? {});
    if (!file.clientId || !file.clientSecret || names.length === 0) {
      ga.reason = "google-tokens.json has no accounts — run: npx tsx scripts/google-auth.ts <account>";
      return ga;
    }
    for (const name of names) {
      const acc = file.accounts[name];
      const auth = new google.auth.OAuth2(file.clientId, file.clientSecret);
      auth.setCredentials({ refresh_token: acc.refreshToken });
      ga.list.push({
        name,
        email: acc.email,
        gmail: google.gmail({ version: "v1", auth }),
        calendar: google.calendar({ version: "v3", auth }),
      });
    }
    return ga;
  }

  enabled(): boolean {
    return this.list.length > 0;
  }

  disabledReason(): string {
    return this.reason;
  }

  accounts(): GoogleAccount[] {
    return this.list;
  }

  get(name: string): GoogleAccount | undefined {
    return this.list.find((a) => a.name === name);
  }

  markDegraded(name: string, reason: string): void {
    this.degradedMap.set(name, reason);
  }

  clearDegraded(name: string): void {
    this.degradedMap.delete(name);
  }

  isDegraded(name: string): boolean {
    return this.degradedMap.has(name);
  }

  degraded(): Array<{ name: string; reason: string }> {
    return [...this.degradedMap.entries()].map(([name, reason]) => ({ name, reason }));
  }
}
```

- [ ] **Step 5: Verify + commit**

Run: `npx vitest run test/google-auth.test.ts && npm test && npx tsc --noEmit`

```bash
git add package.json package-lock.json src/senses/google/auth.ts test/google-auth.test.ts
git commit -m "feat(senses): google accounts loader with degraded tracking"
```

---

### Task 3: One-time auth helper script

**Files:**
- Create: `scripts/google-auth.ts`

No unit test (interactive, opens a browser); verified live by the user during rollout. Code is complete below — transcribe exactly.

- [ ] **Step 1: Create `scripts/google-auth.ts`**

```ts
// scripts/google-auth.ts — one-time per-account Google OAuth consent.
// Usage: npx tsx scripts/google-auth.ts <accountName>
// Prompts for the OAuth Desktop client id/secret on first run (stored in
// data/google-tokens.json, shared across accounts), opens the consent URL,
// catches the redirect on a localhost loopback port, stores the refresh token.
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { execFile } from "node:child_process";
import { google } from "googleapis";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
];

const account = process.argv[2];
if (!account) {
  console.error("Usage: npx tsx scripts/google-auth.ts <accountName>   e.g. personal");
  process.exit(1);
}

const tokensPath = join(process.env.AIOS_DATA_DIR ?? join(process.cwd(), "data"), "google-tokens.json");

interface TokensFile {
  clientId: string;
  clientSecret: string;
  accounts: Record<string, { email: string; refreshToken: string }>;
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let file: TokensFile = existsSync(tokensPath)
    ? (JSON.parse(readFileSync(tokensPath, "utf8")) as TokensFile)
    : { clientId: "", clientSecret: "", accounts: {} };

  if (!file.clientId || !file.clientSecret) {
    console.log("First run — paste your OAuth Desktop client credentials");
    console.log("(GCP console → APIs & Services → Credentials → Create OAuth client → Desktop app)");
    file.clientId = (await rl.question("Client ID: ")).trim();
    file.clientSecret = (await rl.question("Client secret: ")).trim();
  }
  rl.close();

  // Loopback redirect: random free port.
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const auth = new google.auth.OAuth2(file.clientId, file.clientSecret, redirectUri);
  const url = auth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });

  console.log(`\nOpening consent page for account "${account}"…\nIf the browser doesn't open: ${url}\n`);
  execFile("open", [url], () => {});

  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const c = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(c ? "<h2>AI-OS connected. You can close this tab.</h2>" : `<h2>Failed: ${err}</h2>`);
      if (c) resolve(c);
      else reject(new Error(`consent failed: ${err}`));
    });
  });
  server.close();

  const { tokens } = await auth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("no refresh_token returned — remove the app at myaccount.google.com/permissions and rerun");
  }
  auth.setCredentials(tokens);

  const me = await google.gmail({ version: "v1", auth }).users.getProfile({ userId: "me" });
  const email = me.data.emailAddress ?? "unknown";

  file.accounts[account] = { email, refreshToken: tokens.refresh_token };
  mkdirSync(dirname(tokensPath), { recursive: true });
  writeFileSync(tokensPath, JSON.stringify(file, null, 2));
  console.log(`\n✓ Account "${account}" (${email}) connected. Tokens in ${tokensPath}`);
  console.log("Restart the daemon to start watching this account.");
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
```

- [ ] **Step 2: Verify compile + commit**

Run: `npx tsc --noEmit` (scripts are outside tsconfig? check `tsconfig.json` include — if scripts/ is excluded, run `npx tsx --eval "import('./scripts/google-auth.ts')"` — actually simplest: `node --experimental-strip-types --check` is messy; just verify with `npx tsx scripts/google-auth.ts` (no arg) printing the usage line and exiting 1).

Run: `npx tsx scripts/google-auth.ts; echo "exit: $?"`
Expected: usage line + `exit: 1`

```bash
git add scripts/google-auth.ts
git commit -m "feat(senses): one-time google oauth consent script"
```

---

### Task 4: Gmail watcher

**Files:**
- Create: `src/senses/google/gmail.ts`
- Test: `test/gmail-watcher.test.ts`

The watcher depends only on a narrow structural client type (subset of `gmail_v1.Gmail`) so tests stub it without googleapis.

- [ ] **Step 1: Write the failing tests**

```ts
// test/gmail-watcher.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus, type AiosEvent } from "../src/events.js";
import { GmailWatcher, type GmailLike } from "../src/senses/google/gmail.js";

function msg(id: string, labels: string[] = ["INBOX"], headers: Record<string, string> = {}) {
  return {
    id, threadId: `t-${id}`, labelIds: labels, snippet: `snippet ${id}`,
    internalDate: "1765900000000",
    payload: {
      headers: Object.entries({ From: "a@b.com", To: "me@x.com", Subject: `subj ${id}`, ...headers })
        .map(([name, value]) => ({ name, value })),
    },
  };
}

function stubGmail(opts: {
  profileHistoryId?: string;
  history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
  newHistoryId?: string;
  messages?: Record<string, ReturnType<typeof msg>>;
  historyError?: { code: number };
}): GmailLike {
  return {
    users: {
      getProfile: async () => ({ data: { historyId: opts.profileHistoryId ?? "1000" } }),
      history: {
        list: async () => {
          if (opts.historyError) throw Object.assign(new Error("history error"), opts.historyError);
          return { data: { history: opts.history ?? [], historyId: opts.newHistoryId ?? "1001" } };
        },
      },
      messages: {
        get: async ({ id }: { id: string }) => ({ data: opts.messages?.[id] ?? msg(id) }),
      },
    },
  } as unknown as GmailLike;
}

function setup(gmail: GmailLike, skip = ["promotions", "social"]) {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const events: AiosEvent[] = [];
  bus.on((e) => events.push(e.event));
  const watcher = new GmailWatcher({ account: "personal", gmail, store, bus, skipCategories: skip });
  return { store, events, watcher };
}

describe("GmailWatcher", () => {
  it("bootstrap stamps historyId and emits nothing", async () => {
    const { store, events, watcher } = setup(stubGmail({ profileHistoryId: "500" }));
    await watcher.poll();
    expect(store.kvGet("gmail:personal:historyId")).toBe("500");
    expect(events.filter((e) => e.type === "mail.received")).toHaveLength(0);
  });

  it("incremental poll emits mail.received with metadata", async () => {
    const gmail = stubGmail({
      history: [{ messagesAdded: [{ message: { id: "m1" } }, { message: { id: "m2" } }] }],
      newHistoryId: "600",
    });
    const { store, events, watcher } = setup(gmail);
    store.kvSet("gmail:personal:historyId", "500");
    await watcher.poll();
    const mails = events.filter((e) => e.type === "mail.received") as Extract<AiosEvent, { type: "mail.received" }>[];
    expect(mails).toHaveLength(2);
    expect(mails[0]).toMatchObject({
      account: "personal", messageId: "m1", threadId: "t-m1",
      from: "a@b.com", subject: "subj m1", labels: ["INBOX"],
    });
    expect(store.kvGet("gmail:personal:historyId")).toBe("600");
  });

  it("skips non-INBOX and skip-category messages", async () => {
    const gmail = stubGmail({
      history: [{ messagesAdded: [{ message: { id: "spam" } }, { message: { id: "promo" } }, { message: { id: "ok" } }] }],
      messages: {
        spam: msg("spam", ["SPAM"]),
        promo: msg("promo", ["INBOX", "CATEGORY_PROMOTIONS"]),
        ok: msg("ok", ["INBOX"]),
      },
    });
    const { events, watcher, store } = setup(gmail);
    store.kvSet("gmail:personal:historyId", "1");
    await watcher.poll();
    const mails = events.filter((e) => e.type === "mail.received");
    expect(mails).toHaveLength(1);
    expect((mails[0] as { messageId: string }).messageId).toBe("ok");
  });

  it("expired historyId (404) re-bootstraps silently", async () => {
    const gmail = stubGmail({ historyError: { code: 404 }, profileHistoryId: "900" });
    const { events, watcher, store } = setup(gmail);
    store.kvSet("gmail:personal:historyId", "1");
    await watcher.poll();
    expect(store.kvGet("gmail:personal:historyId")).toBe("900");
    expect(events.filter((e) => e.type === "mail.received")).toHaveLength(0);
  });

  it("API errors propagate (caller backoff handles them)", async () => {
    const gmail = stubGmail({ historyError: { code: 500 } });
    const { watcher, store } = setup(gmail);
    store.kvSet("gmail:personal:historyId", "1");
    await expect(watcher.poll()).rejects.toThrow("history error");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/gmail-watcher.test.ts`
Expected: FAIL — module missing

- [ ] **Step 3: Implement `src/senses/google/gmail.ts`**

```ts
// src/senses/google/gmail.ts
import type { Store } from "../../store/db.js";
import type { EventBus } from "../../events.js";

/** Narrow structural slice of gmail_v1.Gmail — keeps tests free of googleapis. */
export interface GmailLike {
  users: {
    getProfile(p: { userId: string }): Promise<{ data: { historyId?: string | null } }>;
    history: {
      list(p: {
        userId: string;
        startHistoryId: string;
        historyTypes: string[];
      }): Promise<{ data: { history?: Array<{ messagesAdded?: Array<{ message?: { id?: string | null } | null }> | null }> | null; historyId?: string | null } }>;
    };
    messages: {
      get(p: { userId: string; id: string; format: string; metadataHeaders?: string[] }): Promise<{
        data: {
          id?: string | null; threadId?: string | null; labelIds?: string[] | null;
          snippet?: string | null; internalDate?: string | null;
          payload?: { headers?: Array<{ name?: string | null; value?: string | null }> | null } | null;
        };
      }>;
    };
  };
}

export interface GmailWatcherDeps {
  account: string;
  gmail: GmailLike;
  store: Store;
  bus: EventBus;
  /** Lowercase Gmail category names to skip (e.g. "promotions" → CATEGORY_PROMOTIONS). */
  skipCategories: string[];
  log?: (line: string) => void;
}

function header(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/**
 * Incremental Gmail poll via the history API. Bootstrap stamps the current
 * historyId WITHOUT emitting (no backlog flood). historyId is stamped after
 * emitting — a crash in between may duplicate one batch (acceptable).
 */
export class GmailWatcher {
  constructor(private deps: GmailWatcherDeps) {}

  private kvKey(): string {
    return `gmail:${this.deps.account}:historyId`;
  }

  async poll(): Promise<void> {
    const { store } = this.deps;
    const last = store.kvGet(this.kvKey());
    if (!last) {
      await this.bootstrap();
      return;
    }
    let history;
    try {
      history = await this.deps.gmail.users.history.list({
        userId: "me",
        startHistoryId: last,
        historyTypes: ["messageAdded"],
      });
    } catch (err) {
      if ((err as { code?: number }).code === 404) {
        // historyId expired (long downtime) — re-bootstrap; Gmail still has the mail.
        this.deps.log?.(`gmail(${this.deps.account}): historyId expired — re-bootstrapping`);
        await this.bootstrap();
        return;
      }
      throw err;
    }

    const ids = new Set<string>();
    for (const h of history.data.history ?? []) {
      for (const added of h.messagesAdded ?? []) {
        if (added.message?.id) ids.add(added.message.id);
      }
    }

    for (const id of ids) {
      const { data } = await this.deps.gmail.users.messages.get({
        userId: "me", id, format: "metadata", metadataHeaders: ["From", "To", "Subject"],
      });
      const labels = data.labelIds ?? [];
      if (!labels.includes("INBOX")) continue;
      const skip = this.deps.skipCategories.some((c) => labels.includes(`CATEGORY_${c.toUpperCase()}`));
      if (skip) continue;
      const headers = data.payload?.headers ?? [];
      this.deps.bus.emit({
        type: "mail.received",
        account: this.deps.account,
        messageId: data.id ?? id,
        threadId: data.threadId ?? "",
        from: header(headers, "From"),
        to: header(headers, "To"),
        subject: header(headers, "Subject"),
        snippet: data.snippet ?? "",
        labels,
        receivedAt: data.internalDate ? new Date(Number(data.internalDate)).toISOString() : new Date().toISOString(),
      });
    }

    if (history.data.historyId) store.kvSet(this.kvKey(), history.data.historyId);
  }

  private async bootstrap(): Promise<void> {
    const profile = await this.deps.gmail.users.getProfile({ userId: "me" });
    if (profile.data.historyId) {
      this.deps.store.kvSet(this.kvKey(), profile.data.historyId);
      this.deps.log?.(`gmail(${this.deps.account}): bootstrapped at historyId ${profile.data.historyId}`);
    }
  }
}
```

- [ ] **Step 4: Verify + commit**

Run: `npx vitest run test/gmail-watcher.test.ts && npm test && npx tsc --noEmit`
Expected: PASS (5 new)

```bash
git add src/senses/google/gmail.ts test/gmail-watcher.test.ts
git commit -m "feat(senses): gmail watcher — incremental history sync, category filtering"
```

---

### Task 5: Calendar watcher

**Files:**
- Create: `src/senses/google/calendar.ts`
- Test: `test/calendar-watcher.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/calendar-watcher.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus, type AiosEvent } from "../src/events.js";
import { CalendarWatcher, type CalendarLike } from "../src/senses/google/calendar.js";

const NOW = new Date("2026-06-12T10:00:00.000Z");

function gevent(id: string, startIso: string, over: Record<string, unknown> = {}) {
  return {
    id, summary: `event ${id}`, status: "confirmed", updated: "2026-06-12T08:00:00.000Z",
    start: { dateTime: startIso }, end: { dateTime: startIso },
    organizer: { email: "org@x.com" }, hangoutLink: null,
    ...over,
  };
}

function stubCalendar(items: Array<ReturnType<typeof gevent>>): CalendarLike {
  return {
    events: { list: async () => ({ data: { items } }) },
  } as unknown as CalendarLike;
}

function setup(items: Array<ReturnType<typeof gevent>>, pingMinutes = 15, now = NOW) {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const events: AiosEvent[] = [];
  bus.on((e) => events.push(e.event));
  const watcher = new CalendarWatcher({
    account: "personal", calendar: stubCalendar(items), store, bus,
    pingMinutes, nowFn: () => now,
  });
  return { store, events, watcher };
}

describe("CalendarWatcher snapshot diff", () => {
  it("first poll bootstraps the snapshot without emitting calendar.changed", async () => {
    const { events, watcher, store } = setup([gevent("e1", "2026-06-13T09:00:00.000Z")]);
    await watcher.poll();
    expect(events.filter((e) => e.type === "calendar.changed")).toHaveLength(0);
    expect(store.kvGet("gcal:personal:snapshot")).toBeTruthy();
  });

  it("new event after bootstrap emits calendar.changed", async () => {
    const { watcher: w1, store } = setup([gevent("e1", "2026-06-13T09:00:00.000Z")]);
    await w1.poll();
    const store2events: AiosEvent[] = [];
    const bus2 = new EventBus(store);
    bus2.on((e) => store2events.push(e.event));
    const w2 = new CalendarWatcher({
      account: "personal",
      calendar: stubCalendar([gevent("e1", "2026-06-13T09:00:00.000Z"), gevent("e2", "2026-06-14T10:00:00.000Z")]),
      store, bus: bus2, pingMinutes: 15, nowFn: () => NOW,
    });
    await w2.poll();
    const changed = store2events.filter((e) => e.type === "calendar.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ eventId: "e2", summary: "event e2", account: "personal" });
  });

  it("updated event (newer updated stamp) emits; unchanged does not", async () => {
    const { watcher: w1, store } = setup([gevent("e1", "2026-06-13T09:00:00.000Z")]);
    await w1.poll();
    const events2: AiosEvent[] = [];
    const bus2 = new EventBus(store);
    bus2.on((e) => events2.push(e.event));
    const w2 = new CalendarWatcher({
      account: "personal",
      calendar: stubCalendar([gevent("e1", "2026-06-13T11:00:00.000Z", { updated: "2026-06-12T09:30:00.000Z" })]),
      store, bus: bus2, pingMinutes: 15, nowFn: () => NOW,
    });
    await w2.poll();
    expect(events2.filter((e) => e.type === "calendar.changed")).toHaveLength(1);
    await w2.poll(); // same data again
    expect(events2.filter((e) => e.type === "calendar.changed")).toHaveLength(1);
  });

  it("disappeared (cancelled) event emits calendar.changed with status cancelled", async () => {
    const { watcher: w1, store } = setup([gevent("e1", "2026-06-13T09:00:00.000Z")]);
    await w1.poll();
    const events2: AiosEvent[] = [];
    const bus2 = new EventBus(store);
    bus2.on((e) => events2.push(e.event));
    const w2 = new CalendarWatcher({
      account: "personal", calendar: stubCalendar([]), store, bus: bus2, pingMinutes: 15, nowFn: () => NOW,
    });
    await w2.poll();
    const changed = events2.filter((e) => e.type === "calendar.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ eventId: "e1", status: "cancelled" });
  });
});

describe("CalendarWatcher meeting pings", () => {
  it("event within the lead window pings once", async () => {
    const soon = new Date(NOW.getTime() + 10 * 60_000).toISOString(); // in 10 min
    const { events, watcher, store } = setup([gevent("m1", soon)]);
    await watcher.poll(); // bootstrap also scans pings
    const pings = events.filter((e) => e.type === "calendar.reminder");
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatchObject({ eventId: "m1", minutesUntil: 10 });
    expect(store.kvGet("gcal:pinged:m1")).toBeTruthy();
    await watcher.poll();
    expect(events.filter((e) => e.type === "calendar.reminder")).toHaveLength(1); // no re-fire
  });

  it("event outside the window does not ping", async () => {
    const later = new Date(NOW.getTime() + 60 * 60_000).toISOString();
    const { events, watcher } = setup([gevent("m2", later)]);
    await watcher.poll();
    expect(events.filter((e) => e.type === "calendar.reminder")).toHaveLength(0);
  });

  it("event already started does not ping", async () => {
    const past = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    const { events, watcher } = setup([gevent("m3", past)]);
    await watcher.poll();
    expect(events.filter((e) => e.type === "calendar.reminder")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/calendar-watcher.test.ts`
Expected: FAIL — module missing

- [ ] **Step 3: Implement `src/senses/google/calendar.ts`**

```ts
// src/senses/google/calendar.ts
import type { Store } from "../../store/db.js";
import type { EventBus } from "../../events.js";

/** Narrow structural slice of calendar_v3.Calendar. */
export interface CalendarLike {
  events: {
    list(p: {
      calendarId: string;
      timeMin: string;
      timeMax: string;
      singleEvents: boolean;
      orderBy: string;
      maxResults: number;
    }): Promise<{ data: { items?: CalendarEventItem[] | null } }>;
  };
}

export interface CalendarEventItem {
  id?: string | null;
  summary?: string | null;
  status?: string | null;
  updated?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
  organizer?: { email?: string | null } | null;
  hangoutLink?: string | null;
}

export interface CalendarWatcherDeps {
  account: string;
  calendar: CalendarLike;
  store: Store;
  bus: EventBus;
  pingMinutes: number;
  log?: (line: string) => void;
  nowFn?: () => Date;
}

const WINDOW_DAYS = 7;

interface SnapshotEntry {
  updated: string;
  summary: string;
  start: string;
  end: string;
  status: string;
  organizer: string;
  link: string | null;
}

function startIso(e: CalendarEventItem): string {
  return e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00.000Z` : "");
}

function endIso(e: CalendarEventItem): string {
  return e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00.000Z` : "");
}

/**
 * Windowed snapshot diff (now → +7d): emits calendar.changed for new, moved,
 * or disappeared (cancelled) events. The kv snapshot doubles as the brief
 * assembler's meetings source. Also scans for meeting-soon pings each poll.
 */
export class CalendarWatcher {
  constructor(private deps: CalendarWatcherDeps) {}

  private snapKey(): string {
    return `gcal:${this.deps.account}:snapshot`;
  }

  async poll(): Promise<void> {
    const now = (this.deps.nowFn ?? (() => new Date()))();
    const { data } = await this.deps.calendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
    });

    const current = new Map<string, SnapshotEntry>();
    for (const item of data.items ?? []) {
      if (!item.id || item.status === "cancelled") continue;
      current.set(item.id, {
        updated: item.updated ?? "",
        summary: item.summary ?? "(no title)",
        start: startIso(item),
        end: endIso(item),
        status: item.status ?? "confirmed",
        organizer: item.organizer?.email ?? "",
        link: item.hangoutLink ?? null,
      });
    }

    const prevRaw = this.deps.store.kvGet(this.snapKey());
    if (prevRaw) {
      const prev = new Map(Object.entries(JSON.parse(prevRaw) as Record<string, SnapshotEntry>));
      for (const [id, entry] of current) {
        const old = prev.get(id);
        if (!old || old.updated !== entry.updated) {
          this.emitChanged(id, entry, entry.status);
        }
      }
      for (const [id, old] of prev) {
        if (!current.has(id) && Date.parse(old.start) > now.getTime()) {
          this.emitChanged(id, old, "cancelled");
        }
      }
    } else {
      this.deps.log?.(`gcal(${this.deps.account}): bootstrapped ${current.size} event(s)`);
    }
    this.deps.store.kvSet(this.snapKey(), JSON.stringify(Object.fromEntries(current)));

    // Meeting-soon pings (once per event, kv-guarded).
    for (const [id, entry] of current) {
      const startMs = Date.parse(entry.start);
      const minutesUntil = Math.round((startMs - now.getTime()) / 60_000);
      if (minutesUntil < 0 || minutesUntil > this.deps.pingMinutes) continue;
      const pingKey = `gcal:pinged:${id}`;
      if (this.deps.store.kvGet(pingKey)) continue;
      this.deps.store.kvSet(pingKey, now.toISOString());
      this.deps.bus.emit({
        type: "calendar.reminder",
        account: this.deps.account,
        eventId: id,
        summary: entry.summary,
        start: entry.start,
        minutesUntil,
        link: entry.link,
      });
    }
  }

  private emitChanged(id: string, entry: SnapshotEntry, status: string): void {
    this.deps.bus.emit({
      type: "calendar.changed",
      account: this.deps.account,
      eventId: id,
      summary: entry.summary,
      start: entry.start,
      end: entry.end,
      status,
      organizer: entry.organizer,
    });
  }
}
```

- [ ] **Step 4: Verify + commit**

Run: `npx vitest run test/calendar-watcher.test.ts && npm test && npx tsc --noEmit`
Expected: PASS (7 new)

```bash
git add src/senses/google/calendar.ts test/calendar-watcher.test.ts
git commit -m "feat(senses): calendar watcher — windowed snapshot diff, meeting pings"
```

---

### Task 6: Email executors

**Files:**
- Create: `src/senses/google/executors.ts`
- Test: `test/email-executors.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/email-executors.test.ts
import { describe, it, expect } from "vitest";
import { buildRawEmail, emailExecutors, type GmailSendLike } from "../src/senses/google/executors.js";
import { GoogleAccounts } from "../src/senses/google/auth.js";

describe("buildRawEmail", () => {
  it("builds base64url RFC2822 with utf-8 subject and body", () => {
    const raw = buildRawEmail({ to: "x@y.com", subject: "Héllo", body: "Grüße\nzeile 2" });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: x@y.com");
    expect(decoded).toContain("Subject: =?UTF-8?B?");
    expect(decoded).toContain("Grüße");
    expect(raw).not.toContain("+"); // base64url, not base64
    expect(raw).not.toContain("/");
  });
});

function fakeAccounts(calls: Array<{ method: string; args: unknown }>): GoogleAccounts {
  const gmail: GmailSendLike = {
    users: {
      messages: {
        send: async (p) => { calls.push({ method: "send", args: p }); return { data: { id: "sent1" } }; },
        batchModify: async (p) => { calls.push({ method: "batchModify", args: p }); return { data: {} }; },
      },
      drafts: {
        create: async (p) => { calls.push({ method: "draftCreate", args: p }); return { data: { id: "d1" } }; },
      },
    },
  };
  return {
    get: (name: string) => (name === "personal" ? { name, email: "p@x.com", gmail } : undefined),
  } as unknown as GoogleAccounts;
}

describe("emailExecutors", () => {
  it("registers four executors with namespaced types", () => {
    const list = emailExecutors(fakeAccounts([]));
    expect(list.map((e) => e.type).sort()).toEqual(["email.archive", "email.draft", "email.label", "email.send"]);
  });

  it("email.send routes to the right account with threadId", async () => {
    const calls: Array<{ method: string; args: unknown }> = [];
    const send = emailExecutors(fakeAccounts(calls)).find((e) => e.type === "email.send")!;
    const result = await send.execute({ account: "personal", to: "x@y.com", subject: "s", body: "b", threadId: "t9" });
    expect(calls[0].method).toBe("send");
    expect((calls[0].args as { requestBody: { threadId?: string } }).requestBody.threadId).toBe("t9");
    expect(result).toContain("x@y.com");
  });

  it("email.draft creates a draft", async () => {
    const calls: Array<{ method: string; args: unknown }> = [];
    const draft = emailExecutors(fakeAccounts(calls)).find((e) => e.type === "email.draft")!;
    await draft.execute({ account: "personal", to: "x@y.com", subject: "s", body: "b" });
    expect(calls[0].method).toBe("draftCreate");
  });

  it("email.archive removes INBOX label via batchModify", async () => {
    const calls: Array<{ method: string; args: unknown }> = [];
    const archive = emailExecutors(fakeAccounts(calls)).find((e) => e.type === "email.archive")!;
    const result = await archive.execute({ account: "personal", messageIds: ["a", "b"] });
    expect(calls[0].method).toBe("batchModify");
    expect((calls[0].args as { requestBody: { removeLabelIds: string[] } }).requestBody.removeLabelIds).toEqual(["INBOX"]);
    expect(result).toContain("2");
  });

  it("unknown account throws (gate records failed)", async () => {
    const send = emailExecutors(fakeAccounts([])).find((e) => e.type === "email.send")!;
    await expect(send.execute({ account: "nope", to: "x@y.com", subject: "s", body: "b" })).rejects.toThrow("unknown google account");
  });

  it("schemas reject malformed payloads at the gate boundary", () => {
    const send = emailExecutors(fakeAccounts([])).find((e) => e.type === "email.send")!;
    expect(() => send.schema.parse({ account: "p" })).toThrow();
    const label = emailExecutors(fakeAccounts([])).find((e) => e.type === "email.label")!;
    expect(() => label.schema.parse({ account: "p", messageIds: [], add: [], remove: [] })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/email-executors.test.ts`
Expected: FAIL — module missing

- [ ] **Step 3: Implement `src/senses/google/executors.ts`**

```ts
// src/senses/google/executors.ts
import { z } from "zod";
import type { Executor } from "../../kernel/actions.js";
import type { GoogleAccounts } from "./auth.js";

/** Structural slice used by the executors (subset of gmail_v1.Gmail). */
export interface GmailSendLike {
  users: {
    messages: {
      send(p: { userId: string; requestBody: { raw: string; threadId?: string } }): Promise<{ data: { id?: string | null } }>;
      batchModify(p: { userId: string; requestBody: { ids: string[]; addLabelIds?: string[]; removeLabelIds?: string[] } }): Promise<unknown>;
    };
    drafts: {
      create(p: { userId: string; requestBody: { message: { raw: string; threadId?: string } } }): Promise<{ data: { id?: string | null } }>;
    };
  };
}

/** RFC2822 → base64url, with RFC2047 UTF-8 subject encoding. */
export function buildRawEmail(p: { to: string; subject: string; body: string }): string {
  const subject = `=?UTF-8?B?${Buffer.from(p.subject, "utf8").toString("base64")}?=`;
  const mime = [
    `To: ${p.to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    p.body,
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

function account(accounts: GoogleAccounts, name: string): { gmail: GmailSendLike } {
  const acc = accounts.get(name);
  if (!acc) throw new Error(`unknown google account "${name}"`);
  return acc as unknown as { gmail: GmailSendLike };
}

const sendSchema = z.object({
  account: z.string(),
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  threadId: z.string().optional(),
});

/** The four gated mailbox mutations. All start supervised; gate audits everything. */
export function emailExecutors(accounts: GoogleAccounts): Executor[] {
  return [
    {
      type: "email.send",
      schema: sendSchema,
      async execute(payload) {
        const p = payload as z.infer<typeof sendSchema>;
        const { gmail } = account(accounts, p.account);
        await gmail.users.messages.send({
          userId: "me",
          requestBody: { raw: buildRawEmail(p), ...(p.threadId ? { threadId: p.threadId } : {}) },
        });
        return `Sent to ${p.to}: "${p.subject}" (${p.account})`;
      },
    },
    {
      type: "email.draft",
      schema: sendSchema,
      async execute(payload) {
        const p = payload as z.infer<typeof sendSchema>;
        const { gmail } = account(accounts, p.account);
        await gmail.users.drafts.create({
          userId: "me",
          requestBody: { message: { raw: buildRawEmail(p), ...(p.threadId ? { threadId: p.threadId } : {}) } },
        });
        return `Draft created for ${p.to}: "${p.subject}" (${p.account})`;
      },
    },
    {
      type: "email.archive",
      schema: z.object({ account: z.string(), messageIds: z.array(z.string()).min(1) }),
      async execute(payload) {
        const p = payload as { account: string; messageIds: string[] };
        const { gmail } = account(accounts, p.account);
        await gmail.users.messages.batchModify({
          userId: "me",
          requestBody: { ids: p.messageIds, removeLabelIds: ["INBOX"] },
        });
        return `Archived ${p.messageIds.length} message(s) (${p.account})`;
      },
    },
    {
      type: "email.label",
      schema: z.object({
        account: z.string(),
        messageIds: z.array(z.string()),
        add: z.array(z.string()),
        remove: z.array(z.string()),
      }),
      async execute(payload) {
        const p = payload as { account: string; messageIds: string[]; add: string[]; remove: string[] };
        const { gmail } = account(accounts, p.account);
        await gmail.users.messages.batchModify({
          userId: "me",
          requestBody: { ids: p.messageIds, addLabelIds: p.add, removeLabelIds: p.remove },
        });
        return `Labeled ${p.messageIds.length} message(s) +[${p.add.join(",")}] -[${p.remove.join(",")}] (${p.account})`;
      },
    },
  ];
}
```

- [ ] **Step 4: Verify + commit**

Run: `npx vitest run test/email-executors.test.ts && npm test && npx tsc --noEmit`
Expected: PASS (7 new)

```bash
git add src/senses/google/executors.ts test/email-executors.test.ts
git commit -m "feat(senses): gated email executors — send, draft, archive, label"
```

---

### Task 7: Moderator read tools + html-to-text

**Files:**
- Create: `src/senses/google/read.ts` (htmlToText + inbox/read helpers)
- Modify: `src/moderator/tools.ts`
- Modify: `src/moderator/session.ts` (MCP_TOOLS)
- Test: `test/google-read.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/google-read.test.ts
import { describe, it, expect } from "vitest";
import { htmlToText, extractBody, type GmailReadLike, listInbox, readEmail } from "../src/senses/google/read.js";
import type { GoogleAccounts } from "../src/senses/google/auth.js";

describe("htmlToText", () => {
  it("strips tags, decodes entities, keeps line structure", () => {
    expect(htmlToText("<p>Hello <b>world</b></p><br><div>line&nbsp;2 &amp; more</div>"))
      .toBe("Hello world\nline 2 & more");
  });
  it("drops style and script blocks entirely", () => {
    expect(htmlToText("<style>.a{}</style><script>x()</script>ok")).toBe("ok");
  });
});

describe("extractBody", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  it("prefers text/plain part", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64("plain body") } },
        { mimeType: "text/html", body: { data: b64("<p>html body</p>") } },
      ],
    };
    expect(extractBody(payload)).toBe("plain body");
  });
  it("falls back to html converted", () => {
    const payload = { mimeType: "text/html", body: { data: b64("<p>only html</p>") } };
    expect(extractBody(payload)).toBe("only html");
  });
  it("recurses nested multiparts", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("deep") } }] }],
    };
    expect(extractBody(payload)).toBe("deep");
  });
});

function fakeAccounts(): GoogleAccounts {
  const gmail: GmailReadLike = {
    users: {
      messages: {
        list: async () => ({ data: { messages: [{ id: "m1" }, { id: "m2" }] } }),
        get: async ({ id }) => ({
          data: {
            id, threadId: `t-${id}`, snippet: `snip ${id}`, labelIds: ["INBOX", "UNREAD"],
            payload: {
              headers: [
                { name: "From", value: "a@b.com" }, { name: "Subject", value: `s ${id}` },
                { name: "Date", value: "Fri, 12 Jun 2026 10:00:00 +0000" },
              ],
              mimeType: "text/plain",
              body: { data: Buffer.from(`body of ${id}`, "utf8").toString("base64url") },
            },
          },
        }),
      },
    },
  };
  return {
    get: (name: string) => (name === "personal" ? { name, email: "p@x.com", gmail } : undefined),
    accounts: () => [{ name: "personal", email: "p@x.com", gmail }],
  } as unknown as GoogleAccounts;
}

describe("listInbox / readEmail", () => {
  it("lists with metadata lines", async () => {
    const out = await listInbox(fakeAccounts(), { account: "personal", query: "is:unread", limit: 5 });
    expect(out).toContain("m1");
    expect(out).toContain("a@b.com");
    expect(out).toContain("s m1");
  });
  it("reads full body", async () => {
    const out = await readEmail(fakeAccounts(), { account: "personal", messageId: "m1" });
    expect(out).toContain("body of m1");
    expect(out).toContain("From: a@b.com");
  });
  it("unknown account → clear error string", async () => {
    const out = await listInbox(fakeAccounts(), { account: "nope" });
    expect(out).toContain("unknown google account");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/google-read.test.ts`
Expected: FAIL — module missing

- [ ] **Step 3: Implement `src/senses/google/read.ts`**

```ts
// src/senses/google/read.ts
import type { GoogleAccounts } from "./auth.js";

export interface GmailPayload {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPayload[] | null;
  headers?: Array<{ name?: string | null; value?: string | null }> | null;
}

export interface GmailReadLike {
  users: {
    messages: {
      list(p: { userId: string; q?: string; maxResults?: number; labelIds?: string[] }): Promise<{ data: { messages?: Array<{ id?: string | null }> | null } }>;
      get(p: { userId: string; id: string; format?: string }): Promise<{ data: { id?: string | null; threadId?: string | null; snippet?: string | null; labelIds?: string[] | null; payload?: GmailPayload | null } }>;
    };
  };
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n").map((l) => l.trim()).join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/** Walk the MIME tree: prefer text/plain, fall back to converted text/html. */
export function extractBody(payload: GmailPayload | null | undefined): string {
  if (!payload) return "";
  const decode = (data?: string | null) => (data ? Buffer.from(data, "base64url").toString("utf8") : "");
  const find = (p: GmailPayload, mime: string): string => {
    if (p.mimeType === mime && p.body?.data) return decode(p.body.data);
    for (const part of p.parts ?? []) {
      const found = find(part, mime);
      if (found) return found;
    }
    return "";
  };
  const plain = find(payload, "text/plain");
  if (plain) return plain.trim();
  const html = find(payload, "text/html");
  if (html) return htmlToText(html);
  return "";
}

function header(headers: Array<{ name?: string | null; value?: string | null }> | null | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function gmailOf(accounts: GoogleAccounts, name: string): GmailReadLike | string {
  const acc = accounts.get(name);
  if (!acc) return `unknown google account "${name}" — accounts: ${accounts.accounts().map((a) => a.name).join(", ") || "(none)"}`;
  return acc.gmail as unknown as GmailReadLike;
}

export async function listInbox(
  accounts: GoogleAccounts,
  opts: { account: string; query?: string; limit?: number },
): Promise<string> {
  const gmail = gmailOf(accounts, opts.account);
  if (typeof gmail === "string") return gmail;
  const list = await gmail.users.messages.list({
    userId: "me",
    q: opts.query ?? "in:inbox",
    maxResults: Math.min(opts.limit ?? 10, 25),
  });
  const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);
  if (!ids.length) return "No messages.";
  const lines: string[] = [];
  for (const id of ids) {
    const { data } = await gmail.users.messages.get({ userId: "me", id, format: "metadata" });
    const h = data.payload?.headers ?? [];
    const unread = (data.labelIds ?? []).includes("UNREAD") ? "● " : "  ";
    lines.push(`${unread}[${id}] ${header(h, "From")} — ${header(h, "Subject")} (${data.snippet ?? ""})`);
  }
  return lines.join("\n");
}

export async function readEmail(
  accounts: GoogleAccounts,
  opts: { account: string; messageId: string },
): Promise<string> {
  const gmail = gmailOf(accounts, opts.account);
  if (typeof gmail === "string") return gmail;
  const { data } = await gmail.users.messages.get({ userId: "me", id: opts.messageId, format: "full" });
  const h = data.payload?.headers ?? [];
  return [
    `From: ${header(h, "From")}`,
    `To: ${header(h, "To")}`,
    `Date: ${header(h, "Date")}`,
    `Subject: ${header(h, "Subject")}`,
    `ThreadId: ${data.threadId ?? ""}`,
    "",
    extractBody(data.payload) || "(no readable body)",
  ].join("\n");
}
```

- [ ] **Step 4: Add the moderator tools**

`src/moderator/tools.ts` — add to imports:

```ts
import { listInbox, readEmail } from "../senses/google/read.js";
import type { GoogleAccounts } from "../senses/google/auth.js";
```

Add to `ModeratorToolsDeps`:

```ts
  google: GoogleAccounts;
```

Add two tools (after `addTriageRule`):

```ts
  const listInboxTool = tool(
    "list_inbox",
    "List recent email (read-only). query uses Gmail search syntax, e.g. 'is:unread from:hannah'. " +
      "Accounts available: ask list with an invalid account to see names.",
    {
      account: z.string().describe("Google account name, e.g. personal"),
      query: z.string().optional(),
      limit: z.number().optional(),
    },
    async (args) => text(await listInbox(deps.google, args)),
  );

  const readEmailTool = tool(
    "read_email",
    "Read one email's full body (read-only). Use the [id] from list_inbox. Returns headers + ThreadId (pass threadId to email.send/email.draft for proper reply threading).",
    {
      account: z.string(),
      message_id: z.string(),
    },
    async (args) => text(await readEmail(deps.google, { account: args.account, messageId: args.message_id })),
  );
```

Register both — append `listInboxTool, readEmailTool` to the `tools:` array.

`src/moderator/session.ts` — add to `ModeratorDeps`: `google: GoogleAccounts;` (+ type import), pass `google: this.deps.google,` in `turn()`'s `buildModeratorServer` call, and add to `MCP_TOOLS`:

```ts
  "mcp__aios__list_inbox",
  "mcp__aios__read_email",
```

- [ ] **Step 5: Verify + commit**

Run: `npx vitest run test/google-read.test.ts && npx tsc --noEmit`
Expected: tests PASS (8 new); tsc FAILS only in `src/index.ts` (Moderator now requires `google`) — that lands in Task 9. If you prefer green tsc per-task, defer the session.ts `ModeratorDeps` change to Task 9 and note it; otherwise proceed knowing Task 9 closes it. Run `npm test` — test suite must still pass (vitest doesn't typecheck index.ts construction).

```bash
git add src/senses/google/read.ts src/moderator/tools.ts src/moderator/session.ts test/google-read.test.ts
git commit -m "feat(moderator): list_inbox and read_email tools with mime body extraction"
```

---

### Task 8: Triage defaults + quiet posture + brief sections

**Files:**
- Modify: `src/heartbeat/triage.ts`
- Modify: `src/heartbeat/briefs.ts`
- Test: `test/triage.test.ts` (append), `test/briefs.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `test/triage.test.ts` (in the `defaultVerdict` describe):

```ts
  it("calendar reminders interrupt; calendar changes batch; mail goes to the model", () => {
    expect(defaultVerdict({ type: "calendar.reminder", account: "p", eventId: "e", summary: "s", start: "", minutesUntil: 10, link: null })).toBe("notify_now");
    expect(defaultVerdict({ type: "calendar.changed", account: "p", eventId: "e", summary: "s", start: "", end: "", status: "confirmed", organizer: "" })).toBe("batch");
    expect(defaultVerdict({ type: "mail.received", account: "p", messageId: "m", threadId: "t", from: "", to: "", subject: "", snippet: "", labels: [], receivedAt: "" })).toBeUndefined();
  });
```

Append to `test/briefs.test.ts`:

```ts
describe("assembleBrief senses sections", () => {
  it("mail digest groups by account and sender domain since the window", () => {
    const store = new Store(":memory:");
    const mail = (account: string, from: string, id: string) =>
      store.addEvent(JSON.stringify({ type: "mail.received", account, messageId: id, threadId: id, from, to: "", subject: `s-${id}`, snippet: "", labels: ["INBOX"], receivedAt: NOW }));
    mail("personal", "Amy <amy@acme.com>", "m1");
    mail("personal", "Bob <bob@acme.com>", "m2");
    mail("work", "Carl <c@corp.io>", "m3");
    const data = assembleBrief(store, "morning", NOW, "2020-01-01T00:00:00.000Z");
    expect(data.mailDigest).toEqual([
      { account: "personal", count: 2, senders: ["acme.com × 2"] },
      { account: "work", count: 1, senders: ["corp.io × 1"] },
    ]);
  });

  it("meetings come from the calendar snapshot kv (morning=today, evening=tomorrow)", () => {
    const store = new Store(":memory:");
    store.kvSet("gcal:personal:snapshot", JSON.stringify({
      e1: { updated: "u", summary: "Standup", start: "2026-06-12T14:00:00.000Z", end: "", status: "confirmed", organizer: "", link: "https://meet/x" },
      e2: { updated: "u", summary: "Tomorrow mtg", start: "2026-06-13T09:00:00.000Z", end: "", status: "confirmed", organizer: "", link: null },
    }));
    const morning = assembleBrief(store, "morning", NOW, null);
    expect(morning.meetings).toEqual([{ account: "personal", summary: "Standup", start: "2026-06-12T14:00:00.000Z", link: "https://meet/x" }]);
    const evening = assembleBrief(store, "evening", NOW, null);
    expect(evening.meetings).toEqual([{ account: "personal", summary: "Tomorrow mtg", start: "2026-06-13T09:00:00.000Z", link: null }]);
  });

  it("empty senses sections keep isEmptyBrief true", () => {
    const store = new Store(":memory:");
    expect(isEmptyBrief(assembleBrief(store, "morning", NOW, null))).toBe(true);
  });
});
```

NOTE: `NOW` in test/briefs.test.ts is `"2026-06-12T10:00:00.000Z"` — `localDateOf` uses LOCAL dates. The meeting at `14:00Z` falls on local 2026-06-12 in any timezone between UTC-4 and UTC+9; if the runner's TZ makes the test flaky, pin start times near midday UTC as above (safe for Europe/Paris).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/triage.test.ts test/briefs.test.ts`
Expected: new tests FAIL (mail.received hits no switch case but the union now includes it — verify it returns undefined naturally; the briefs tests fail on missing fields)

- [ ] **Step 3: Implement**

`src/heartbeat/triage.ts`:

(a) Add to `defaultVerdict`'s switch (before the noise-types block):

```ts
    case "calendar.reminder":
      return "notify_now";
    case "calendar.changed":
      return "batch";
    case "mail.received":
      return undefined; // model decides — quiet posture prompt below
```

Note: `return undefined` inside the switch makes the quiet-posture intent explicit rather than relying on fallthrough.

(b) Quiet-posture prompt — replace `modelClassifier`'s `systemPrompt` string with:

```ts
        systemPrompt:
          "You triage events for a personal AI OS. Verdicts: notify_now (interrupt the user NOW), " +
          "batch (include in the next scheduled brief), ignore (noise). " +
          "POSTURE: quiet by default. For email (mail.received): interrupt ONLY for genuinely urgent, " +
          "time-sensitive items — explicit same-day deadlines, payment or security problems, direct " +
          "personal requests that clearly cannot wait. Newsletters, receipts, notifications, FYIs, " +
          "and anything that can wait a few hours: batch. When unsure: batch.",
```

`src/heartbeat/briefs.ts`:

(a) Extend `BriefData`:

```ts
  mailDigest: Array<{ account: string; count: number; senders: string[] }>;
  meetings: Array<{ account: string; summary: string; start: string; link: string | null }>;
```

(b) In `assembleBrief`, inside the existing `if (sinceTs)` event loop, add a collector before the loop:

```ts
  const mailByAccount = new Map<string, Map<string, number>>(); // account → domain → count
```

and a branch inside the loop:

```ts
      } else if (event.type === "mail.received") {
        const domain = event.from.match(/@([^>\s]+)/)?.[1] ?? event.from;
        const acc = mailByAccount.get(event.account) ?? new Map<string, number>();
        acc.set(domain, (acc.get(domain) ?? 0) + 1);
        mailByAccount.set(event.account, acc);
      }
```

(c) After the event loop, build the meetings list from calendar snapshots (kv scan — add a tiny Store helper in the same commit):

`src/store/db.ts` — add method (before `close()`):

```ts
  /** All kv entries whose key starts with the prefix (used by brief assembly for calendar snapshots). */
  kvByPrefix(prefix: string): Array<{ key: string; value: string }> {
    return this.db
      .prepare("SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key")
      .all(`${prefix}%`) as unknown as Array<{ key: string; value: string }>;
  }
```

`assembleBrief` (after the reminders block, before the return):

```ts
  const targetDateMeetings = localDateOf(
    anchor === "morning" ? nowIso : new Date(nowMs + DAY).toISOString(),
  );
  const meetings: BriefData["meetings"] = [];
  for (const row of store.kvByPrefix("gcal:") ) {
    const m = /^gcal:(.+):snapshot$/.exec(row.key);
    if (!m) continue;
    let snap: Record<string, { summary: string; start: string; link: string | null }>;
    try {
      snap = JSON.parse(row.value) as never;
    } catch {
      continue;
    }
    for (const entry of Object.values(snap)) {
      if (localDateOf(entry.start) === targetDateMeetings) {
        meetings.push({ account: m[1], summary: entry.summary, start: entry.start, link: entry.link ?? null });
      }
    }
  }
  meetings.sort((a, b) => a.start.localeCompare(b.start));
```

(d) Add both to the returned object:

```ts
    mailDigest: [...mailByAccount.entries()]
      .map(([account, domains]) => ({
        account,
        count: [...domains.values()].reduce((a, b) => a + b, 0),
        senders: [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, c]) => `${d} × ${c}`),
      }))
      .sort((a, b) => a.account.localeCompare(b.account)),
    meetings,
```

(e) Extend `isEmptyBrief` with `… && d.mailDigest.length === 0 && d.meetings.length === 0`.

(f) Extend `renderBriefNote` with two sections (before the reminders section):

```ts
  section("Mail", d.mailDigest.map((x) => `${x.account}: ${x.count} new (${x.senders.join(", ")})`));
  section(d.anchor === "morning" ? "Meetings today" : "Meetings tomorrow",
    d.meetings.map((mt) => `${mt.start.slice(11, 16)} ${mt.summary} (${mt.account})${mt.link ? ` — ${mt.link}` : ""}`));
```

- [ ] **Step 4: Verify + commit**

Run: `npx vitest run test/triage.test.ts test/briefs.test.ts && npm test && npx tsc --noEmit`
Expected: PASS (existing briefs tests need `mailDigest`/`meetings` in the hand-built `BriefData` literal in the render test — update that literal with empty arrays)

```bash
git add src/heartbeat/triage.ts src/heartbeat/briefs.ts src/store/db.ts test/triage.test.ts test/briefs.test.ts
git commit -m "feat(heartbeat): mail/calendar triage defaults, quiet posture, brief sections"
```

---

### Task 9: Daemon wiring + README + final verification

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`

- [ ] **Step 1: Wire senses in `src/index.ts`**

Add imports:

```ts
import { GoogleAccounts } from "./senses/google/auth.js";
import { GmailWatcher } from "./senses/google/gmail.js";
import { CalendarWatcher } from "./senses/google/calendar.js";
import { emailExecutors } from "./senses/google/executors.js";
```

After the voice block and BEFORE the channels map (executors must register before the gate is used; google needed by Moderator):

```ts
  // ---- google senses (gmail + calendar) ----
  const google = GoogleAccounts.load(join(config.dataDir, "google-tokens.json"));
  if (!google.enabled()) {
    log(`google senses disabled: ${google.disabledReason()}`);
  } else {
    for (const exec of emailExecutors(google)) registry.register(exec);
    log(`google senses: ${google.accounts().map((a) => `${a.name} (${a.email})`).join(", ")}`);
  }
```

(`join` is already imported in index.ts? Check — if not, add `import { join } from "node:path";`.)

`Moderator` construction gains `google,`.

AFTER the heartbeat block (clock/triage started), add the watcher loops:

```ts
  // Watcher loops: per-account isolation with capped backoff (1m → 5m → 15m).
  if (google.enabled()) {
    const BACKOFFS = [60_000, 300_000, 900_000];
    const startWatcher = (name: string, intervalMs: number, pollFn: () => Promise<void>) => {
      let failures = 0;
      let timer: NodeJS.Timeout;
      const tick = async () => {
        try {
          await pollFn();
          failures = 0;
          const account = name.split(":")[1];
          if (account) google.clearDegraded(account);
        } catch (err) {
          failures++;
          const account = name.split(":")[1];
          if (account) google.markDegraded(account, (err as Error).message.slice(0, 120));
          log(`${name} poll failed (${failures}): ${(err as Error).message}`);
        }
        const delay = failures > 0 ? BACKOFFS[Math.min(failures - 1, BACKOFFS.length - 1)] : intervalMs;
        timer = setTimeout(() => void tick(), delay);
        timer.unref?.();
      };
      void tick();
      return () => clearTimeout(timer);
    };

    const stops: Array<() => void> = [];
    for (const acc of google.accounts()) {
      const gmailWatcher = new GmailWatcher({
        account: acc.name, gmail: acc.gmail, store, bus, skipCategories: config.gmailSkipCategories, log,
      });
      const calWatcher = new CalendarWatcher({
        account: acc.name, calendar: acc.calendar, store, bus, pingMinutes: config.meetingPingMinutes, log,
      });
      stops.push(startWatcher(`gmail:${acc.name}`, config.gmailPollSeconds * 1000, () => gmailWatcher.poll()));
      stops.push(startWatcher(`gcal:${acc.name}`, config.calendarPollSeconds * 1000, () => calWatcher.poll()));
    }
    const stopWatchers = () => stops.forEach((s) => s());
    process.on("SIGINT", stopWatchers);
    process.on("SIGTERM", stopWatchers);
  }
```

(Simpler alternative for shutdown: add `stops.forEach(s => s())` inside the existing `shutdown` function instead of extra signal handlers — do THAT, matching the existing pattern; declare `const stops` in the outer scope so `shutdown` can reach it.)

Also: the `notify` function's reminder special-case — add a calendar-reminder summary so pings read well. In `notify`, before the generic fallback:

```ts
    if (e.type === "calendar.reminder") {
      if (!config.primaryChat) return;
      await sendVia(config.primaryChat.channel, config.primaryChat.chatId,
        `📅 ${e.summary} in ${e.minutesUntil} min${e.link ? ` — ${e.link}` : ""}`);
      return;
    }
    if (e.type === "mail.received") {
      if (!config.primaryChat) return;
      await sendVia(config.primaryChat.channel, config.primaryChat.chatId,
        `📧 ${e.from}: ${e.subject} (${e.account})\n${e.snippet.slice(0, 150)}`);
      return;
    }
```

- [ ] **Step 2: Boot smoke (no tokens — graceful off)**

```bash
env TELEGRAM_BOT_TOKEN= SLACK_BOT_TOKEN= SLACK_APP_TOKEN= \
  AIOS_DATA_DIR=/tmp/aios-p5-data AIOS_UI_PORT=4295 \
  timeout 10 npx tsx src/index.ts --cli < /dev/null; echo "exit: $?"
```

Expected: `google senses disabled: no google-tokens.json …` line, `aios daemon running`, exit 124, no crash.

- [ ] **Step 3: README**

After the Voice section, add:

```markdown
### Email & Calendar (first senses)

Connect Google accounts once: create a GCP project → enable **Gmail API** +
**Google Calendar API** → OAuth consent screen (External, add yourself as test
user) → Credentials → **Create OAuth client → Desktop app** → copy id/secret,
then run `npx tsx scripts/google-auth.ts personal` (repeat per account) and
restart the daemon.

The daemon then watches your inbox (urgent mail pings you; the rest lands in
briefs as a digest) and calendar (meeting reminders 15 min ahead; agenda in the
morning brief). Ask the moderator things like *"what's unread?"* or *"draft a
reply to Hannah saying I'll confirm Monday"* — drafts, sends, archives, and
labels all go through the approval gate and earn autonomy like everything else.
Polling: `AIOS_GMAIL_POLL_SECONDS` (120), `AIOS_CALENDAR_POLL_SECONDS` (300),
`AIOS_MEETING_PING_MINUTES` (15), `AIOS_GMAIL_SKIP_CATEGORIES` (promotions,social).
```

- [ ] **Step 4: Final gates**

Run: `npm test && npx tsc --noEmit && (cd ui && npm run build)`
Expected: all green (~210 tests + 1 skip).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts README.md
git commit -m "feat(daemon): google senses wiring — watchers with backoff, sense pings, docs"
```

---

## Self-review notes (already applied)

- **Spec coverage:** auth + tokens file + degraded tracking (T2), consent script with loopback (T3), gmail watcher incl. bootstrap-no-flood/404-rebootstrap/category filtering (T4), calendar windowed diff + once-only pings (T5 — documented spec refinement replacing syncToken), four executors with previews-in-results (T6; gate-side previews come from the proposal's preview field which the moderator composes — the spec's preview table is guidance for the moderator prompt + executor result strings), read tools + MIME extraction (T7), triage defaults + quiet posture + digest/meetings brief sections + isEmpty/render extensions (T8), wiring with per-account backoff + sense-specific ping formatting + boot smoke + README + config keys (T1/T9).
- **Deviation note:** spec says gate previews are "gate-side" for email — Phase 3's gate only authors previews for `trust.promote`; email previews come from the moderator's proposal text plus the executor's result string. The approval ping still shows exactly what will happen (to/subject/account in the preview the moderator must write — its tool description should instruct this; covered by propose_action usage). Flagged for the final reviewer to assess rather than silently expanding gate scope.
- **Placeholder scan:** none.
- **Type consistency:** `GoogleAccounts` surface (T2) matches consumers (T6 `accounts.get`, T7 `gmailOf`, T9 wiring); event payloads (T1) match watcher emits (T4/T5) and triage/brief consumers (T8); `kvByPrefix` defined in T8 where first used.
