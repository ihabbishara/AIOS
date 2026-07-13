// ui2/test/stubs.ts — FakeEventSource + fetch stub for jsdom component tests.
import { vi } from "vitest";

let nextId = 1;

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {}
  emit(event: Record<string, unknown> & { type: string }): void {
    this.onmessage?.({ data: JSON.stringify({ id: nextId++, ts: new Date().toISOString(), event }) });
  }
}

/** Stub fetch with a path→body map (query strings stripped; exact path match). */
export function stubApi(routes: Record<string, unknown>): void {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0];
    if (path in routes) return new Response(JSON.stringify(routes[path]), { status: 200 });
    return new Response(JSON.stringify({ error: `no stub for ${path}` }), { status: 404 });
  }));
}

export const STATE_STUB = {
  uptimeMs: 1000, voice: false,
  agents: [
    { name: "hermes", kind: "moderator", description: "Chief of Staff", tools: [], guarded: false },
    { name: "iris", kind: "specialist", description: "researcher", tools: [], guarded: false },
  ],
  playbooks: [], bindings: [],
};
