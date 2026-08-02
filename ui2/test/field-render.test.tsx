// ui2/test/field-render.test.tsx — the two claims the field makes: motion stops
// when the stream dies, and state is legible without motion at all.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Field } from "../src/views/home/Field.js";
import { fieldLayout } from "../src/lib/field.js";
import type { OrgDepartmentView, OrgAgentCard } from "../src/api.js";

afterEach(cleanup);

const card = (name: string, status: OrgAgentCard["status"]): OrgAgentCard => ({
  name, title: "T", charter: "c", visibility: "shared", guarded: false,
  status, currentTask: null, costTodayUsd: 0,
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

  it("hides labels at the low tide but keeps every dot mounted", () => {
    const { container } = render(<Field clusters={clusters} level="low" live={true} />);
    expect(container.querySelectorAll("[data-dot]")).toHaveLength(2);
    expect(container.querySelector("[data-labels]")?.className).toContain("opacity-0");
  });

  it("shows a private agent — the owner's own body is not partial", () => {
    const withPrivate = fieldLayout([
      dept("life", [{ ...card("hestia", "idle"), visibility: "private" }]),
    ]);
    const { container } = render(<Field clusters={withPrivate} level="mid" live={true} />);
    expect(container.querySelectorAll("[data-dot]")).toHaveLength(1);
  });

  it("keeps a waiting agent amber and unmoving — it is blocked, not working", () => {
    const waiting = fieldLayout([dept("ops", [card("neo", "waiting")])]);
    const { container } = render(<Field clusters={waiting} level="mid" live={true} />);
    expect(container.querySelectorAll(".bg-accent")).toHaveLength(1);
    expect(container.querySelectorAll(".breath")).toHaveLength(0);
  });
});
