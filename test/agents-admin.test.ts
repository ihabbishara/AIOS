// test/agents-admin.test.ts — hire/fire builders + loader archive-skip (spec 2026-07-20).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildExtras } from "../src/agents/registry/extras.js";
import { loadConfig } from "../src/config.js";

function extras() {
  const config = loadConfig(process.cwd());
  return buildExtras({
    vaultPath: config.vaultPath, vaultSubdir: config.vaultSubdir,
    financeCompany: config.financeCompany, financeMembers: config.financeMembers,
  });
}

import { parse as parseYaml } from "yaml";
import { agentSchema } from "../src/agents/registry/types.js";
import { validateHire, renderAgentYaml, retireBlockers } from "../src/web/agents-admin.js";

const reg = loadRegistry("agents", "playbooks", extras(), () => {});
const good = {
  name: "test-scout", department: "research", kind: "worker" as const, title: "Scout",
  charter: "Scouts things.", persona: "Terse and curious.", prompt: "You are a scout. Report findings.",
  capabilities: ["files-ro"],
};

describe("validateHire", () => {
  it("accepts a well-formed hire", () => {
    expect(validateHire(good, reg)).toEqual({ ok: true, manifest: good });
  });
  it("refuses each broken field with a distinct error", () => {
    const cases: Array<[object, RegExp]> = [
      [{ ...good, name: "Bad Name" }, /name/],
      [{ ...good, name: "athena" }, /taken|collision/i],
      [{ ...good, name: "cfo" }, /taken|collision/i], // alias collision
      [{ ...good, department: "nope" }, /department/],
      [{ ...good, kind: "coordinator" }, /coordinator|kind/],
      [{ ...good, capabilities: ["not-a-cap"] }, /capability/],
      [{ ...good, charter: "" }, /charter/],
    ];
    for (const [body, re] of cases) {
      const r = validateHire(body, reg);
      expect(r.ok, JSON.stringify(body)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(re);
    }
  });
});

describe("renderAgentYaml", () => {
  it("round-trips through agentSchema with defaults and multi-line fields intact", () => {
    const rendered = renderAgentYaml({ ...good, prompt: "Line one.\n\nLine two after a blank." });
    const parsed = agentSchema.parse(parseYaml(rendered));
    expect(parsed.name).toBe("test-scout");
    expect(parsed.department).toBe("research");
    expect(parsed.kind).toBe("worker");
    expect(parsed.capabilities).toEqual(["files-ro"]);
    expect(parsed.maxTurns).toBe(25);
    expect(parsed.permissionMode).toBe("dontAsk");
    expect(parsed.prompt).toContain("Line two");
  });
});

describe("retireBlockers", () => {
  it("blocks the coordinator", () => {
    expect(retireBlockers(reg.coordinator, reg).join(" ")).toMatch(/coordinator/);
  });
  it("blocks a department lead with the dept named", () => {
    const dept = [...reg.departments.values()].find((d) => d.lead);
    expect(dept).toBeTruthy();
    expect(retireBlockers(dept!.lead!, reg).join(" ")).toContain(dept!.department);
  });
  const stageRoles = (s: { type: string } & Record<string, unknown>): string[] =>
    s.type === "single" ? [s.role as string]
    : s.type === "loop" ? [s.producer as string, s.critic as string]
    : [s.runner as string, s.fixer as string];

  it("blocks a playbook-referenced role with the playbook named", () => {
    const hit = [...reg.playbooks.entries()].find(([, p]) =>
      p.stages.some((s) => stageRoles(s).some((r) => reg.agents.has(reg.agentOf.get(r) ?? r))));
    expect(hit).toBeTruthy();
    const stage = hit![1].stages.find((s) => stageRoles(s).some((r) => reg.agents.has(reg.agentOf.get(r) ?? r)))!;
    const raw = stageRoles(stage).find((r) => reg.agents.has(reg.agentOf.get(r) ?? r))!;
    const role = reg.agentOf.get(raw) ?? raw;
    expect(retireBlockers(role, reg).join(" ")).toContain(hit![0]);
  });
  it("returns [] for an unreferenced worker", () => {
    const free = [...reg.agents.values()].find((a) =>
      a.kind === "worker" &&
      ![...reg.departments.values()].some((d) => d.lead === a.manifest.name) &&
      ![...reg.playbooks.values()].some((p) => p.stages.some((s) =>
        stageRoles(s).some((r) => (reg.agentOf.get(r) ?? r) === a.manifest.name))));
    if (free) expect(retireBlockers(free.manifest.name, reg)).toEqual([]);
  });
});

describe("loader skips _-prefixed dirs (the _retired/ archive)", () => {
  it("a manifest inside agents/_retired/ is not registered", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agents-"));
    cpSync("agents", tmp, { recursive: true });
    mkdirSync(join(tmp, "_retired"), { recursive: true });
    writeFileSync(join(tmp, "_retired", "zz-ghost.yaml"), [
      "name: zz-ghost", "title: Ghost", "department: engineering",
      "charter: >\n  ghost charter", "persona: >\n  ghost persona", "prompt: >\n  ghost prompt",
      "kind: worker", "capabilities: [files-ro]",
    ].join("\n"));
    const reg = loadRegistry(tmp, "playbooks", extras(), () => {});
    expect(reg.agents.has("zz-ghost")).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });
});
