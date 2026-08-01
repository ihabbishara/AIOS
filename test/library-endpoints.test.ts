// test/library-endpoints.test.ts — /api/library/{tree,file}: the read-only workspace browser
// behind the UI-token gate. This is where the containment work in library-view becomes
// reachable by a caller-supplied path, so the gate and the refusals are pinned here.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store/db.js";
import { startWebServer, type WebDeps } from "../src/web/server.js";
import { MAX_READ_BYTES, type LibraryNode } from "../src/web/library-view.js";

const TOKEN = "library-test-token";

let vaultRoot: string;
let outside: string;
let server: { close: () => Promise<void> } | undefined;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "lib-api-"));
  vaultRoot = join(base, "vault");
  outside = join(base, "secrets");
  mkdirSync(join(vaultRoot, "goals", "2026-08-01-chaser"), { recursive: true });
  mkdirSync(join(vaultRoot, ".git"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(vaultRoot, "goals", "2026-08-01-chaser", "report.md"), "# Chaser\n\nbody");
  writeFileSync(join(vaultRoot, "logo.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(join(vaultRoot, ".env"), "ANTHROPIC_TOKEN=sk-secret-123");
  writeFileSync(join(vaultRoot, ".git", "config"), "url = https://user:pw@example.com/x.git");
  writeFileSync(join(vaultRoot, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>');
  writeFileSync(join(outside, "id_rsa"), "PRIVATE KEY");
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start() {
  const prev = process.env.AIOS_UI_TOKEN;
  process.env.AIOS_UI_TOKEN = TOKEN;
  const deps = {
    store: new Store(":memory:"), goals: {}, vault: { root: vaultRoot },
    registry: { agents: new Map(), departments: new Map(), agentOf: new Map() },
    reloadPacks: () => {}, envPath: "", uiDist: "", log: () => {},
    bus: { history: () => [], on: () => () => {} }, config: { dbPath: ":memory:" }, router: {}, gate: {},
    voice: { available: () => false }, mailbox: {},
  } as unknown as WebDeps;
  const http = startWebServer(deps, 0);
  if (!http.listening) await once(http, "listening");
  const { port } = http.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  server = {
    close: async () => {
      http.closeAllConnections?.();
      await new Promise<void>((r) => http.close(() => r()));
      if (prev === undefined) delete process.env.AIOS_UI_TOKEN; else process.env.AIOS_UI_TOKEN = prev;
    },
  };
  return {
    tree: () => fetch(`${base}/api/library/tree`, { headers: auth }),
    file: (rel: string) => fetch(`${base}/api/library/file?path=${encodeURIComponent(rel)}`, { headers: auth }),
    raw: (path: string, init?: RequestInit) => fetch(`${base}${path}`, init),
  };
}

/** Both endpoints must inherit the one gate in front of /api/ — never a second auth path. */
describe("library endpoints: auth", () => {
  it("refuses both endpoints without the UI token", async () => {
    const t = await start();
    expect((await t.raw("/api/library/tree")).status).toBe(401);
    expect((await t.raw("/api/library/file?path=logo.png")).status).toBe(401);
    // …and the same requests with the token do not 401, so the 401s above are the gate talking.
    expect((await t.tree()).status).toBe(200);
    expect((await t.file("logo.png")).status).toBe(200);
  });
});

describe("GET /api/library/tree", () => {
  it("returns the vault tree", async () => {
    const t = await start();
    const { nodes } = (await (await t.tree()).json()) as { nodes: LibraryNode[] };
    expect(nodes.map((n) => n.name)).toEqual(["goals", "diagram.svg", "logo.png"]);
    expect(nodes[0].children![0].path).toBe("goals/2026-08-01-chaser");
  });

  it("never lists dot-directories, so .env and .git stay out of the listing", async () => {
    const t = await start();
    const body = await (await t.tree()).text();
    expect(body).not.toContain(".env");
    expect(body).not.toContain(".git");
  });

  // The walk depth is unclamped from the caller's side and a symlink loop amplifies every extra
  // level, so the endpoint exposes no depth control at all — a query param must do nothing.
  it("ignores a caller-supplied depth", async () => {
    const t = await start();
    const r = await t.raw("/api/library/tree?maxDepth=1&depth=1", { headers: { Authorization: `Bearer ${TOKEN}` } });
    const { nodes } = (await r.json()) as { nodes: LibraryNode[] };
    // A depth of 1 would have flattened this away.
    expect(nodes.find((n) => n.name === "goals")!.children![0].children![0].name).toBe("report.md");
  });
});

describe("GET /api/library/file", () => {
  it("serves a vault file with its mime and length", async () => {
    const t = await start();
    const r = await t.file("goals/2026-08-01-chaser/report.md");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/markdown");
    expect(r.headers.get("content-length")).toBe("14");
    expect(await r.text()).toBe("# Chaser\n\nbody");
  });

  it("serves an .svg as a download, never as an inline image type", async () => {
    const t = await start();
    const r = await t.file("diagram.svg");
    // image/svg+xml here would be stored XSS in the cockpit's own origin: the file is agent-written.
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses the dotfiles the tree refuses to list", async () => {
    const t = await start();
    for (const rel of [".env", ".git/config"]) {
      const r = await t.file(rel);
      expect(r.status, rel).toBe(404);
      expect(await r.text()).not.toContain("sk-secret-123");
    }
  });

  it("refuses an escape without leaking whether the outside file exists", async () => {
    const t = await start();
    symlinkSync(join(outside, "id_rsa"), join(vaultRoot, "leak.md"));
    for (const rel of ["../secrets/id_rsa", join(outside, "id_rsa"), "leak.md"]) {
      const r = await t.file(rel);
      expect(r.status, rel).toBe(404);
      expect(await r.text(), rel).not.toContain("PRIVATE KEY");
    }
  });

  it("refuses an over-large file with an error instead of buffering it", async () => {
    const t = await start();
    const big = join(vaultRoot, "big.bin");
    writeFileSync(big, "");
    truncateSync(big, MAX_READ_BYTES + 1); // sparse: a real reported size, no multi-MB write
    const r = await t.file("big.bin");
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toMatch(/too large/i);
  });

  it("answers a missing file as 404 JSON, not a 500", async () => {
    const t = await start();
    const r = await t.file("goals/nope.md");
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("application/json");
  });
});
