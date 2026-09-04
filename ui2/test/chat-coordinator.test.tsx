// ui2/test/chat-coordinator.test.tsx — the chat picker lists the org's OWN coordinator.
//
// Reported 2026-09-04 by a new user: their picker showed `neo`, `nova`, `delve`, `sift`, `quill`
// — and neo is not in their org. Two bugs, one cause. `/api/state` synthesised the moderator row
// with the literal name "neo" and filtered the registry by that same literal, so an org led by
// `nova` got a phantom neo tab AND its real coordinator listed again as an ordinary specialist.
// The picker then prepended "neo" a second time on the client.
//
// "neo" is simply what this repo's author called their coordinator. Every org has exactly one and
// names it itself; the registry has always known which (`registry.coordinator`).
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Chat } from "../src/components/Chat.js";
import type { StateInfo } from "../src/api.js";

afterEach(cleanup);

/** The reporter's org: nova coordinates, three specialists. No neo anywhere. */
const NOVA_ORG = {
  uptimeMs: 1, voice: false,
  coordinator: "nova",
  agents: [
    { name: "nova", kind: "moderator", description: "Chief of Staff", tools: [], guarded: false },
    { name: "delve", kind: "specialist", description: "research", tools: [], guarded: false },
    { name: "sift", kind: "specialist", description: "analysis", tools: [], guarded: false },
    { name: "quill", kind: "specialist", description: "writing", tools: [], guarded: false },
  ],
  playbooks: [], bindings: [],
} as unknown as StateInfo;

const chat = (state: StateInfo, target = "nova") =>
  render(<Chat open state={state} events={[]} target={target} setTarget={() => {}} />);

describe("the chat picker follows the org", () => {
  it("offers exactly the org's agents — no phantom neo", () => {
    chat(NOVA_ORG);
    expect(screen.queryByText("neo")).toBeNull();
    for (const name of ["nova", "delve", "sift", "quill"]) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }
  });

  it("lists the coordinator once, not twice", () => {
    // The old filter excluded the literal "neo", so a coordinator named anything else survived
    // it and appeared a second time as a specialist.
    const { container } = chat(NOVA_ORG);
    const tabs = [...container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(tabs.filter((t) => t === "nova")).toHaveLength(1);
  });

  it("puts the coordinator first — it is the default channel", () => {
    const { container } = chat(NOVA_ORG);
    const first = container.querySelector("button");
    expect(first?.textContent).toContain("nova");
  });

  it("names the coordinator in the routing hint, rather than a hardcoded one", () => {
    chat(NOVA_ORG);
    expect(screen.getByText(/describe what you need; nova routes it/)).toBeTruthy();
    expect(screen.queryByText(/neo routes it/)).toBeNull();
  });

  it("does not offer the routing hint when the channel is a specialist", () => {
    chat(NOVA_ORG, "delve");
    expect(screen.queryByText(/routes it/)).toBeNull();
  });

  it("falls back to the moderator row when an older server sends no coordinator field", () => {
    const { coordinator: _drop, ...older } = NOVA_ORG as unknown as Record<string, unknown>;
    const { container } = chat(older as unknown as StateInfo);
    expect(container.querySelector("button")?.textContent).toContain("nova");
    expect(screen.queryByText("neo")).toBeNull();
  });
});
