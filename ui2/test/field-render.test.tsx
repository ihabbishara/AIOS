// ui2/test/field-render.test.tsx — the two claims the field makes: motion stops
// when the stream dies, and state is legible without motion at all.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Field } from "../src/views/home/Field.js";
import { fieldLayout } from "../src/lib/field.js";
import type { OrgDepartmentView, OrgAgentCard } from "../src/api.js";

afterEach(cleanup);

const card = (name: string, status: OrgAgentCard["status"]): OrgAgentCard => ({
  name, title: "T", charter: "c", visibility: "shared", guarded: false,
  status, currentTask: null, costTodayUsd: 0,
  lastActiveAt: null, costUsd: 0, nodes: 0, goalsLed: 0, mail: 0, runs: 0,
});

const dept = (department: string, agents: OrgAgentCard[]): OrgDepartmentView => ({
  department, mission: "m", lead: agents[0]?.name ?? null,
  memoDomain: department, sandbox: false, actions: [], agents,
});

const clusters = fieldLayout([dept("engineering", [card("atlas", "working"), card("vulcan", "idle")])]);

describe("Field", () => {
  it("breathes a working dot while the stream is live", () => {
    const { container } = render(<Field clusters={clusters} level="high" live={true} />);
    expect(container.querySelectorAll(".breath")).toHaveLength(1);
  });

  it("stops all motion when the stream is down — a breathing dot on dead data is a lie", () => {
    const { container } = render(<Field clusters={clusters} level="high" live={false} />);
    expect(container.querySelectorAll(".breath")).toHaveLength(0);
  });

  it("distinguishes working from idle by hue, so reduced-motion still reads", () => {
    const { container } = render(<Field clusters={clusters} level="high" live={false} />);
    expect(container.querySelectorAll(".bg-now")).toHaveLength(1);
    expect(container.querySelectorAll(".bg-rest")).toHaveLength(1);
  });

  it("keeps every label legible at the low tide — at rest the names ARE the content", () => {
    // These used to collapse to opacity-0 h-0, which left the low tide as a field of
    // anonymous dots: a chart OF a company rather than the company.
    const { container } = render(<Field clusters={clusters} level="low" live={true} />);
    expect(container.querySelectorAll("[data-dot]")).toHaveLength(2);
    expect(container.querySelector("[data-labels]")?.className).not.toContain("opacity-0");
    expect(screen.getByText("engineering")).toBeTruthy();
    expect(screen.getByText("vulcan")).toBeTruthy();
  });

  it("pulses the resting dots only at the low tide, and only while the stream is live", () => {
    const low = render(<Field clusters={clusters} level="low" live={true} />);
    // One of the two rests; the working dot breathes instead.
    expect(low.container.querySelectorAll(".rest-pulse")).toHaveLength(1);
    cleanup();

    const dead = render(<Field clusters={clusters} level="low" live={false} />);
    expect(dead.container.querySelectorAll(".rest-pulse")).toHaveLength(0);
    cleanup();

    // At high tide the dots are not the whole screen, and an ambient pulse there
    // competes with the one animation that means something: an agent mid-turn.
    const high = render(<Field clusters={clusters} level="high" live={true} />);
    expect(high.container.querySelectorAll(".rest-pulse")).toHaveLength(0);
  });

  it("staggers the pulse in fieldLayout order, so the field ripples rather than blinks", () => {
    const resting = fieldLayout([
      dept("engineering", [card("atlas", "idle"), card("vulcan", "idle")]),
      dept("research", [card("clio", "idle")]),
    ]);
    const { container } = render(<Field clusters={resting} level="low" live={true} />);
    const delays = [...container.querySelectorAll<HTMLElement>(".rest-pulse")]
      .map((el) => parseFloat(el.style.animationDelay));
    expect(delays).toHaveLength(3);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i], `dot ${i} must lag dot ${i - 1}`).toBeGreaterThan(delays[i - 1]);
    }
  });

  it("shows a private agent — the owner's own body is not partial", () => {
    const withPrivate = fieldLayout([
      dept("life", [{ ...card("hestia", "idle"), visibility: "private" }]),
    ]);
    const { container } = render(<Field clusters={withPrivate} level="mid" live={true} />);
    expect(container.querySelectorAll("[data-dot]")).toHaveLength(1);
  });

  it("captions what each working agent is actually doing", () => {
    const working = fieldLayout([
      dept("research", [
        { ...card("clio", "working"), currentTask: "reading 9 of 14 sources" },
        card("janus", "idle"),
      ]),
    ]);
    render(<Field clusters={working} level="high" live={true} />);
    expect(screen.getByText("reading 9 of 14 sources")).toBeTruthy();
    // The idle agent contributes no caption — only real work is described.
    expect(screen.queryByText(/janus is/)).toBeNull();
  });

  it("drops the captions at low tide, where nothing is running to describe", () => {
    const working = fieldLayout([
      dept("research", [{ ...card("clio", "working"), currentTask: "reading 9 of 14 sources" }]),
    ]);
    render(<Field clusters={working} level="low" live={true} />);
    expect(screen.queryByText("reading 9 of 14 sources")).toBeNull();
  });

  it("keeps a waiting agent amber and unmoving — it is blocked, not working", () => {
    const waiting = fieldLayout([dept("ops", [card("neo", "waiting")])]);
    const { container } = render(<Field clusters={waiting} level="mid" live={true} />);
    expect(container.querySelectorAll(".bg-accent")).toHaveLength(1);
    expect(container.querySelectorAll(".breath")).toHaveLength(0);
  });
});
