import { describe, it, expect } from "vitest";
import { codeTaskPlan, CODE_PLAYBOOKS, isCodePlaybook } from "../src/moderator/tools.js";

describe("codeTaskPlan", () => {
  it("maps build → code-build with inplace:false", () => {
    const plan = codeTaskPlan("build");
    expect(plan.playbook).toBe("code-build");
    expect(plan.inplace).toBe(false);
  });

  it("maps analyze → code-analyze with inplace:false", () => {
    const plan = codeTaskPlan("analyze");
    expect(plan.playbook).toBe("code-analyze");
    expect(plan.inplace).toBe(false);
  });

  it("maps inplace → code-inplace with inplace:true", () => {
    const plan = codeTaskPlan("inplace");
    expect(plan.playbook).toBe("code-inplace");
    expect(plan.inplace).toBe(true);
  });
});

describe("CODE_PLAYBOOKS", () => {
  it("contains all three code playbooks", () => {
    expect(CODE_PLAYBOOKS.has("code-build")).toBe(true);
    expect(CODE_PLAYBOOKS.has("code-analyze")).toBe(true);
    expect(CODE_PLAYBOOKS.has("code-inplace")).toBe(true);
  });

  it("does not contain non-code playbooks", () => {
    expect(CODE_PLAYBOOKS.has("research-report")).toBe(false);
    expect(CODE_PLAYBOOKS.has("echo")).toBe(false);
  });
});

describe("isCodePlaybook", () => {
  it("returns true for code-build", () => {
    expect(isCodePlaybook("code-build")).toBe(true);
  });

  it("returns true for code-analyze", () => {
    expect(isCodePlaybook("code-analyze")).toBe(true);
  });

  it("returns true for code-inplace", () => {
    expect(isCodePlaybook("code-inplace")).toBe(true);
  });

  it("returns false for echo", () => {
    expect(isCodePlaybook("echo")).toBe(false);
  });

  it("returns false for research-report", () => {
    expect(isCodePlaybook("research-report")).toBe(false);
  });
});
