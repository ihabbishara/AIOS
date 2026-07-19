// test/direct-attachments.test.ts
//
// Pins the attachment marker format injected into the prompt by DirectChats.handle()
// when the caller passes attachments.  resumableTurn is stubbed so no SDK/LLM calls
// happen.  The assert order matches the old FinanceAgent format exactly:
//   [from: Name (@username)]\n[attached file stored at: <path>]\n<userText>

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { DirectChats } from "../src/agents/direct.js";
import { testRegistry } from "./fixtures/registry.js";

// Stub resumableTurn — must be declared before any imports that trigger module
// evaluation.  Vitest hoists vi.mock() calls automatically.
vi.mock("../src/agents/resumable.js", () => ({
  resumableTurn: vi.fn().mockResolvedValue("ok"),
  surfaceHash: () => "stub-hash",
}));

// Import AFTER vi.mock so we get the stub
import * as resumableModule from "../src/agents/resumable.js";

const stubResolve = (registry: ReturnType<typeof testRegistry>) =>
  ((name, _origin, _ctx) => {
    const canonical = registry.agentOf.get(name.toLowerCase());
    const def = canonical ? registry.agents.get(canonical) : undefined;
    if (!canonical || !def) return undefined;
    return { canonical, kind: def.kind, def, options: { systemPrompt: "", allowedTools: [] }, ceiling: [], labels: [] };
  }) as import("../src/agents/resolve.js").ResolveAgentFn;

function makeDirectChats(): DirectChats {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const registry = testRegistry();
  return new DirectChats({
    store,
    bus,
    projectsRoot: "/tmp",
    registry,
    resolveAgent: stubResolve(registry),
  });
}

describe("DirectChats.handle — attachment markers in prompt", () => {
  let capturedPrompt: string;

  beforeEach(() => {
    capturedPrompt = "";
    vi.mocked(resumableModule.resumableTurn).mockImplementation(async (params) => {
      capturedPrompt = params.prompt;
      return "stub reply";
    });
  });

  it("injects [attached file stored at: ...] after sender prefix, before user text", async () => {
    const dc = makeDirectChats();

    await dc.handle(
      "researcher",
      "telegram",
      "chat-1",
      "analyze this invoice",
      { name: "Ihab", username: "ihab" },
      [{ path: "/vault/finance/invoices/2026-06/invoice.pdf", fileName: "invoice.pdf" }],
    );

    // Sender prefix comes first
    expect(capturedPrompt).toContain("[from: Ihab (@ihab)]");
    // Attachment marker follows
    expect(capturedPrompt).toContain("[attached file stored at: /vault/finance/invoices/2026-06/invoice.pdf]");
    // User text follows
    expect(capturedPrompt).toContain("analyze this invoice");

    // Exact order: from\nmarker\nuserText
    const fromIdx = capturedPrompt.indexOf("[from:");
    const markerIdx = capturedPrompt.indexOf("[attached file stored at:");
    const textIdx = capturedPrompt.indexOf("analyze this invoice");
    expect(fromIdx).toBeLessThan(markerIdx);
    expect(markerIdx).toBeLessThan(textIdx);
  });

  it("handles multiple attachments — one marker line per file", async () => {
    const dc = makeDirectChats();

    await dc.handle(
      "researcher",
      "telegram",
      "chat-1",
      "here are two receipts",
      { name: "Amr" },
      [
        { path: "/vault/finance/inv1.pdf", fileName: "inv1.pdf" },
        { path: "/vault/finance/inv2.pdf", fileName: "inv2.pdf" },
      ],
    );

    expect(capturedPrompt).toContain("[attached file stored at: /vault/finance/inv1.pdf]");
    expect(capturedPrompt).toContain("[attached file stored at: /vault/finance/inv2.pdf]");
    const idx1 = capturedPrompt.indexOf("[attached file stored at: /vault/finance/inv1.pdf]");
    const idx2 = capturedPrompt.indexOf("[attached file stored at: /vault/finance/inv2.pdf]");
    expect(idx1).toBeLessThan(idx2);
  });

  it("omits marker block when no attachments given", async () => {
    const dc = makeDirectChats();

    await dc.handle("researcher", "telegram", "chat-1", "hello", { name: "Ihab" });

    expect(capturedPrompt).not.toContain("[attached file stored at:");
    expect(capturedPrompt).toContain("hello");
  });

  it("omits sender prefix when sender is undefined", async () => {
    const dc = makeDirectChats();

    await dc.handle(
      "researcher",
      "telegram",
      "chat-1",
      "no sender here",
      undefined,
      [{ path: "/vault/x.pdf", fileName: "x.pdf" }],
    );

    expect(capturedPrompt).not.toContain("[from:");
    expect(capturedPrompt).toContain("[attached file stored at: /vault/x.pdf]");
    expect(capturedPrompt).toContain("no sender here");
  });
});
