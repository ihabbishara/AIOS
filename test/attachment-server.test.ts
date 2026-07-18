// test/attachment-server.test.ts
//
// Unit tests for the attach_file tool built by buildAttachmentServer.
// Tests the security-critical isSafe() path by driving the tool handler
// directly via the SDK MCP server's internal _registeredTools registry.
//
// No network calls or SDK query() are required — the handler is a plain
// async function and can be invoked without the SDK runtime.

import { describe, it, expect, beforeAll } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Attachment } from "../src/agents/attachment.js";
import { buildAttachmentServer, AIOS_TMP_PREFIX } from "../src/agents/attachment-server.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the attach_file handler from the MCP server returned by
 * buildAttachmentServer.  Uses the SDK McpServer's internal _registeredTools
 * map — intentionally private but stable enough for tests.
 */
function getHandler(
  collector: Attachment[],
  safeDirs: string[],
): (args: { path: string; caption?: string; kind?: "voice" }) => Promise<{ content: Array<{ type: string; text: string }> }> {
  const server = buildAttachmentServer(collector, safeDirs);
  // server = { type: "sdk", name: "aios_attachments", instance: McpServer }
  const inst = (server as unknown as { instance: { _registeredTools: Record<string, { handler: unknown }> } }).instance;
  const registered = inst._registeredTools["attach_file"];
  if (!registered || typeof registered.handler !== "function") {
    throw new Error("attach_file tool not found in server");
  }
  return registered.handler as ReturnType<typeof getHandler>;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let safeDir: string;
let otherDir: string;
let safeFile: string;
let otherFile: string;

beforeAll(() => {
  // Resolve via realpathSync so that macOS /tmp → /private/tmp symlink
  // doesn't cause isSafe() to reject paths that look like they're in safeDir.
  safeDir = realpathSync(mkdtempSync(join(tmpdir(), "aios-safe-")));
  otherDir = realpathSync(mkdtempSync(join(tmpdir(), "aios-other-")));
  safeFile = join(safeDir, "report.csv");
  otherFile = join(otherDir, "secret.txt");
  writeFileSync(safeFile, "a,b,c\n1,2,3\n");
  writeFileSync(otherFile, "top secret");
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("buildAttachmentServer — attach_file tool", () => {
  it("queues a file inside the safe directory", async () => {
    const collector: Attachment[] = [];
    const handler = getHandler(collector, [safeDir]);

    const result = await handler({ path: safeFile, caption: "June report" });

    expect(result.content[0].text).toContain("Queued for delivery");
    expect(collector).toHaveLength(1);
    expect(collector[0].path).toBe(safeFile);
    expect(collector[0].caption).toBe("June report");
  });

  it("refuses a file outside the safe directory", async () => {
    const collector: Attachment[] = [];
    const handler = getHandler(collector, [safeDir]);

    const result = await handler({ path: otherFile });

    expect(result.content[0].text).toContain("Refused");
    expect(collector).toHaveLength(0);
  });

  it("refuses a non-existent path", async () => {
    const collector: Attachment[] = [];
    const handler = getHandler(collector, [safeDir]);

    const result = await handler({ path: join(safeDir, "ghost.csv") });

    expect(result.content[0].text).toContain("Refused");
    expect(collector).toHaveLength(0);
  });

  it("refuses a directory (not a file)", async () => {
    const collector: Attachment[] = [];
    const handler = getHandler(collector, [safeDir]);

    const result = await handler({ path: safeDir });

    expect(result.content[0].text).toContain("Refused");
    expect(collector).toHaveLength(0);
  });

  it("allows /tmp/aios-* prefix pattern", async () => {
    // On macOS, tmpdir() returns /var/folders/... but /tmp is a symlink to
    // /private/tmp.  Build the tmp file under the resolved /tmp path so that
    // both the file and the safeDirs prefix survive realpathSync().
    const resolvedTmp = realpathSync(tmpdir());
    const tmpFile = join(resolvedTmp, `aios-test-${Date.now()}.csv`);
    writeFileSync(tmpFile, "tmp,data\n");

    const collector: Attachment[] = [];
    // The trailing-dash prefix allows any path starting with <resolvedTmp>/aios-test-
    const handler = getHandler(collector, [`${resolvedTmp}/aios-test-`]);

    const result = await handler({ path: tmpFile });

    expect(result.content[0].text).toContain("Queued for delivery");
    expect(collector).toHaveLength(1);

    unlinkSync(tmpFile);
  });

  it("refuses a symlink pointing outside the safe directory", async () => {
    const symlink = join(safeDir, "evil-link.csv");
    try { unlinkSync(symlink); } catch { /* doesn't exist */ }
    symlinkSync(otherFile, symlink);                 // safeDir/evil-link.csv → otherDir/secret.txt

    const collector: Attachment[] = [];
    const handler = getHandler(collector, [safeDir]);

    const result = await handler({ path: symlink });

    // realpathSync resolves the symlink → otherDir/secret.txt which is outside safeDir
    expect(result.content[0].text).toContain("Refused");
    expect(collector).toHaveLength(0);

    unlinkSync(symlink);
  });

  it("each buildAttachmentServer call has an independent collector (no cross-turn bleed)", async () => {
    const c1: Attachment[] = [];
    const c2: Attachment[] = [];
    const h1 = getHandler(c1, [safeDir]);
    const h2 = getHandler(c2, [safeDir]);

    await h1({ path: safeFile, caption: "turn 1" });
    // c2 must remain empty
    expect(c2).toHaveLength(0);
    // c1 must have the entry
    expect(c1).toHaveLength(1);
    expect(c1[0].caption).toBe("turn 1");

    await h2({ path: safeFile, caption: "turn 2" });
    expect(c1).toHaveLength(1);  // turn-1 collector unchanged
    expect(c2).toHaveLength(1);
    expect(c2[0].caption).toBe("turn 2");
  });

  it("AIOS_TMP_PREFIX admits a file in a real /tmp/aios-* dir (macOS /tmp symlink)", async () => {
    const dir = mkdtempSync("/tmp/aios-prefixtest-");
    const f = join(dir, "out.png");
    writeFileSync(f, "x");
    const collector: Attachment[] = [];
    const handler = getHandler(collector, [AIOS_TMP_PREFIX]);

    const result = await handler({ path: f });

    expect(result.content[0].text).toContain("Queued for delivery");
    expect(collector).toHaveLength(1);
  });

  it("attach_file forwards kind: voice into the collector", async () => {
    const collector: Attachment[] = [];
    const handler = getHandler(collector, [safeDir]);

    await handler({ path: safeFile, kind: "voice" });

    expect(collector).toHaveLength(1);
    expect(collector[0].kind).toBe("voice");
  });

  it("caption is optional — omitting it pushes undefined to collector", async () => {
    const collector: Attachment[] = [];
    const handler = getHandler(collector, [safeDir]);

    await handler({ path: safeFile });

    expect(collector[0].caption).toBeUndefined();
  });
});
