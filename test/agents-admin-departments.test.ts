// test/agents-admin-departments.test.ts — departments are the one new validated mutation
// onboarding needs (spec §4). Provisioning writes them before the agents that name them.
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { validateDepartment, renderDepartmentYaml } from "../src/web/agents-admin.js";
import { departmentSchema } from "../src/agents/registry/types.js";
import type { LoadedRegistry } from "../src/agents/registry/loader.js";

function reg(over: Partial<LoadedRegistry> = {}): LoadedRegistry {
  return {
    agents: new Map(), departments: new Map(), agentOf: new Map(),
    ownerOfPlaybook: new Map(), playbooks: new Map(),
    capabilities: new Map([["reading", { tools: ["Read"] }]]),
    coordinator: "", ...over,
  } as unknown as LoadedRegistry;
}

const body = {
  department: "studio", mission: "Make things.", memoDomain: "studio",
  capabilities: ["reading"], playbooks: [],
};

describe("validateDepartment", () => {
  it("accepts a well-formed department", () => {
    const v = validateDepartment(body, reg());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.manifest.department).toBe("studio");
  });

  it("rejects a non-kebab name", () => {
    const v = validateDepartment({ ...body, department: "Studio One" }, reg());
    expect(v).toEqual({ ok: false, error: "department must match ^[a-z][a-z0-9-]*$" });
  });

  it("rejects a department that already exists", () => {
    const v = validateDepartment(body, reg({ departments: new Map([["studio", {} as never]]) }));
    expect(v).toEqual({ ok: false, error: 'department "studio" already exists' });
  });

  it("requires mission and memoDomain", () => {
    expect(validateDepartment({ ...body, mission: "  " }, reg()))
      .toEqual({ ok: false, error: "mission required" });
    expect(validateDepartment({ ...body, memoDomain: "" }, reg()))
      .toEqual({ ok: false, error: "memoDomain required" });
  });

  it("rejects an unknown capability", () => {
    const v = validateDepartment({ ...body, capabilities: ["telepathy"] }, reg());
    expect(v).toEqual({ ok: false, error: 'unknown capability "telepathy"' });
  });

  it("rejects a playbook the loader could not find — the department would be silently skipped", () => {
    const v = validateDepartment({ ...body, playbooks: ["ghost"] }, reg());
    expect(v).toEqual({ ok: false, error: 'unknown playbook "ghost"' });
  });

  it("accepts a playbook supplied by the caller's known-set (about to be copied in)", () => {
    const v = validateDepartment({ ...body, playbooks: ["ghost"] }, reg(), {
      knownPlaybooks: new Set(["ghost"]),
    });
    expect(v.ok).toBe(true);
  });

  it("rejects a lead who is not a registered agent", () => {
    const v = validateDepartment({ ...body, lead: "nobody" }, reg());
    expect(v).toEqual({ ok: false, error: 'lead "nobody" is not a registered agent' });
  });

  it("allows a not-yet-written lead when the caller says the lead is pending", () => {
    const v = validateDepartment({ ...body, lead: "nobody" }, reg(), { leadPending: true });
    expect(v.ok).toBe(true);
  });

  it("rejects a body that is not an object", () => {
    expect(validateDepartment(null, reg())).toEqual({ ok: false, error: "body required" });
  });
});

describe("renderDepartmentYaml", () => {
  it("round-trips through departmentSchema", () => {
    const yaml = renderDepartmentYaml({
      department: "studio", mission: "Make things that ship.", memoDomain: "studio",
      lead: "scribe", capabilities: ["reading"], playbooks: ["starter-brief"],
    });
    const parsed = departmentSchema.parse(parse(yaml));
    expect(parsed.department).toBe("studio");
    expect(parsed.lead).toBe("scribe");
    expect(parsed.capabilities).toEqual(["reading"]);
    expect(parsed.playbooks).toEqual(["starter-brief"]);
    expect(parsed.vaultSection).toBe("studio"); // schema transform defaults it
  });

  it("omits lead entirely when there is none", () => {
    const yaml = renderDepartmentYaml({
      department: "studio", mission: "Make things.", memoDomain: "studio",
      capabilities: [], playbooks: [],
    });
    expect(yaml).not.toContain("lead:");
    expect(departmentSchema.parse(parse(yaml)).lead).toBeUndefined();
  });

  it("keeps a multi-line mission readable and parseable", () => {
    const yaml = renderDepartmentYaml({
      department: "studio", mission: "Line one.\n\nLine two.", memoDomain: "studio",
      capabilities: [], playbooks: [],
    });
    expect(departmentSchema.parse(parse(yaml)).mission).toContain("Line one.");
  });
});
