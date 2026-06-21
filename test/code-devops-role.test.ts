import { describe, it, expect } from "vitest";
import { roles } from "../src/agents/roles/index.js";

describe("devops role", () => {
  it("exists with Edit/Write but no raw Bash, default permission mode", () => {
    const d = roles.devops;
    expect(d).toBeTruthy();
    expect(d.allowedTools).toEqual(expect.arrayContaining(["Read", "Edit", "Write"]));
    expect(d.allowedTools).not.toContain("Bash");
    expect(d.permissionMode).toBe("default");
  });
  it("its prompt refuses live deploys", () => {
    expect(roles.devops.systemPrompt.toLowerCase()).toMatch(/never|refuse/);
    expect(roles.devops.systemPrompt.toLowerCase()).toMatch(/deploy|terraform|kubectl/);
  });
});
