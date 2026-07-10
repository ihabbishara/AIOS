// The /reset race: a turn in flight when resetSession runs must NOT write its old
// session id back after completing (previously required a second /reset).
import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { resumableTurn, clearSession } from "../src/agents/resumable.js";
import { Store } from "../src/store/db.js";

function deferredQuery(sessionId: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const iter = (async function* () {
    await gate;
    yield { type: "result", subtype: "success", session_id: sessionId, result: "ok" };
  })();
  return { iter, release };
}

describe("reset-epoch guard", () => {
  it("a reset during an in-flight turn wins — the old session id is not written back", async () => {
    const store = new Store(":memory:");
    const key = "moderator-session:telegram:1";
    store.kvSet(key, "old-session");
    const { iter, release } = deferredQuery("session-from-inflight-turn");
    vi.mocked(query).mockReturnValueOnce(iter as never);

    const turn = resumableTurn({ store, sessionKey: key, prompt: "hi", options: {} as never });
    clearSession(store, key); // user's /reset lands mid-flight
    release();
    await turn;

    expect(store.kvGet(key)).toBe(""); // reset survived — NOT "session-from-inflight-turn"
  });

  it("without a reset, a successful turn persists its session id as before", async () => {
    const store = new Store(":memory:");
    const key = "moderator-session:telegram:2";
    const { iter, release } = deferredQuery("fresh-session");
    vi.mocked(query).mockReturnValueOnce(iter as never);

    const turn = resumableTurn({ store, sessionKey: key, prompt: "hi", options: {} as never });
    release();
    await turn;

    expect(store.kvGet(key)).toBe("fresh-session");
  });
});
