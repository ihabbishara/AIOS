import { describe, it, expect } from "vitest";
import { buildConfig } from "../src/config.js";

describe("code pack config", () => {
  it("defaults workspaceRoot under home, readRoots to [projectsRoot], codeDisabled false", () => {
    const c = buildConfig();
    expect(c.workspaceRoot).toMatch(/AIOS-Workspace$/);
    expect(c.codeReadRoots).toEqual([c.projectsRoot]);
    expect(c.codeDisabled).toBe(false);
  });

  it("honors env overrides", () => {
    const c = buildConfig({
      AIOS_WORKSPACE_ROOT: "/tmp/ws",
      AIOS_CODE_READ_ROOTS: "/a, /b",
      AIOS_CODE_DISABLED: "1",
    });
    expect(c.workspaceRoot).toBe("/tmp/ws");
    expect(c.codeReadRoots).toEqual(["/a", "/b"]);
    expect(c.codeDisabled).toBe(true);
  });
});
