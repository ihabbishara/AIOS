import { describe, it, expect } from "vitest";
import { roles } from "../src/agents/roles/index.js";

describe("analyst role", () => {
  it("exists, is shareable, and is read/web/recall oriented", () => {
    const a = roles.analyst;
    expect(a).toBeTruthy();
    expect(a.privateOnly).toBeFalsy(); // shareable — unlike cfo
    expect(a.allowedTools).toContain("WebSearch");
    expect(a.allowedTools).toContain("recall");
    expect(a.allowedTools).toContain("mcp__research__save_source");
    // read-only posture: no Bash/Edit/Write
    expect(a.allowedTools).not.toContain("Bash");
    expect(a.allowedTools).not.toContain("Write");
    expect(a.systemPrompt).toMatch(/knowledge\//); // persists findings under knowledge/
  });
});
