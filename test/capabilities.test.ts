// test/capabilities.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { loadCapabilities } from "../src/agents/registry/capabilities.js";
import { loadRegistry } from "../src/agents/registry/loader.js";

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "caps-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const HERMES = `
name: hermes
title: Chief of Staff
department: operations
charter: routes
persona: decisive
prompt: You are Hermes.
kind: coordinator
capabilities: [files-ro]
`;
const OPS_DEPT = `
department: operations
mission: front door
lead: hermes
memoDomain: general
`;
const CAPS = `
files-ro: { tools: [Read, Grep, Glob] }
web:      { tools: [WebSearch, WebFetch] }
guarded:  { tools: [Bash], guard: atlas-mutating }
labeled:  { server: money, tools: [mcp__money__spending_summary], labels: [personal.finance], actions: [ledger.write] }
`;

function agentYaml(name: string, extra = ""): string {
  return `\nname: ${name}\ntitle: T\ndepartment: operations\ncharter: c\npersona: p\nprompt: pr\n${extra}`;
}

describe("loadCapabilities", () => {
  it("parses defs with defaults and tolerates a missing file", () => {
    const dir = tree({ "_capabilities.yaml": CAPS });
    const caps = loadCapabilities(join(dir, "_capabilities.yaml"));
    expect(caps.get("files-ro")).toEqual({
      tools: ["Read", "Grep", "Glob"], actions: [], labels: [],
      server: undefined, guard: undefined, sandbox: false,
    });
    expect(caps.get("labeled")!.labels).toEqual(["personal.finance"]);
    expect(loadCapabilities(join(dir, "nope.yaml")).size).toBe(0);
  });
});

describe("loader v2", () => {
  it("boot error on alias collision", () => {
    const dir = tree({
      "_capabilities.yaml": CAPS,
      "operations/department.yaml": OPS_DEPT,
      "operations/hermes.yaml": HERMES,
      "operations/a.yaml": agentYaml("aaa", "aliases: [shared]\ncapabilities: [files-ro]\nkind: worker"),
      "operations/b.yaml": agentYaml("bbb", "aliases: [shared]\ncapabilities: [files-ro]\nkind: worker"),
    });
    expect(() => loadRegistry(dir, join(dir, "nopb"), {}, () => {})).toThrow(/alias/i);
  });

  it("boot error on unknown capability and unknown guard", () => {
    const base = {
      "operations/department.yaml": OPS_DEPT,
      "operations/hermes.yaml": HERMES,
    };
    const d1 = tree({ ...base, "_capabilities.yaml": CAPS,
      "operations/x.yaml": agentYaml("xxx", "capabilities: [nope]\nkind: worker") });
    expect(() => loadRegistry(d1, join(d1, "nopb"), {}, () => {})).toThrow(/capability/i);
    const d2 = tree({
      "_capabilities.yaml": "files-ro: { tools: [Read] }\nbad: { tools: [Bash], guard: ghost }\n",
      "operations/department.yaml": OPS_DEPT,
      "operations/hermes.yaml": HERMES,
      "operations/x.yaml": agentYaml("xxx", "capabilities: [bad]\nkind: worker"),
    });
    expect(() => loadRegistry(d2, join(d2, "nopb"), {}, () => {})).toThrow(/guard/i);
  });

  it("boot error on zero or two coordinators", () => {
    const d1 = tree({ "_capabilities.yaml": CAPS,
      "operations/department.yaml": OPS_DEPT,
      "operations/solo.yaml": agentYaml("solo", "kind: worker\ncapabilities: [files-ro]") });
    expect(() => loadRegistry(d1, join(d1, "nopb"), {}, () => {})).toThrow(/coordinator/i);
    const d2 = tree({ "_capabilities.yaml": CAPS,
      "operations/department.yaml": OPS_DEPT,
      "operations/hermes.yaml": HERMES,
      "operations/dup.yaml": agentYaml("dup", "kind: coordinator\ncapabilities: [files-ro]") });
    expect(() => loadRegistry(d2, join(d2, "nopb"), {}, () => {})).toThrow(/coordinator/i);
  });

  it("kind inference shim: hermes→coordinator wins over lead; outputSchema→critic; dept lead→lead; else worker", () => {
    const dir = tree({
      "_capabilities.yaml": CAPS,
      "operations/department.yaml": `\ndepartment: operations\nmission: m\nlead: leader\nmemoDomain: general\n`,
      "operations/hermes.yaml": agentYaml("hermes"), // no kind, no capabilities → shims
      "operations/leader.yaml": agentYaml("leader"),
      "operations/judge.yaml": agentYaml("judge", "outputSchema: verdict"),
      "operations/pleb.yaml": agentYaml("pleb"),
    });
    const reg = loadRegistry(dir, join(dir, "nopb"), {}, () => {});
    expect(reg.agents.get("hermes")!.kind).toBe("coordinator");
    expect(reg.agents.get("leader")!.kind).toBe("lead");
    expect(reg.agents.get("judge")!.kind).toBe("critic");
    expect(reg.agents.get("pleb")!.kind).toBe("worker");
    expect(reg.coordinator).toBe("hermes");
  });

  it("capability synthesis shim preserves manifest tools; dept capabilities are inherited", () => {
    const dir = tree({
      "_capabilities.yaml": CAPS,
      "operations/department.yaml": OPS_DEPT + "capabilities: [web]\n",
      "operations/hermes.yaml": HERMES,
      "operations/old.yaml": agentYaml("old", "tools: [Read, Bash]\nkind: worker"),
    });
    const reg = loadRegistry(dir, join(dir, "nopb"), {}, () => {});
    const old = reg.agents.get("old")!;
    expect(old.capabilities).toContain("web"); // dept default inherited (agent has no own capabilities)
    // the shim only fires when NEITHER agent nor dept declare capabilities:
    expect(reg.capabilities.has("__legacy:old")).toBe(false);

    const dir2 = tree({
      "_capabilities.yaml": CAPS,
      "operations/department.yaml": OPS_DEPT,
      "operations/hermes.yaml": HERMES,
      "operations/old.yaml": agentYaml("old", "tools: [Read, Bash]\nkind: worker"),
    });
    const reg2 = loadRegistry(dir2, join(dir2, "nopb"), {}, () => {});
    expect(reg2.capabilities.get("__legacy:old")!.tools).toEqual(["Read", "Bash"]);
  });

  it("live tree is fully v2: no __legacy shims, hermes coordinates, critics inferred right", () => {
    const reg = loadRegistry("agents", "playbooks", {}, () => {});
    expect([...reg.capabilities.keys()].filter((k) => k.startsWith("__legacy"))).toEqual([]);
    expect(reg.coordinator).toBe("hermes");
    expect(reg.agents.get("argus")!.kind).toBe("critic");
    expect(reg.agents.get("minos")!.kind).toBe("critic");
    expect(reg.agents.get("athena")!.kind).toBe("lead");
    expect(reg.agents.get("halalo")!.kind).toBe("lead");
    expect(reg.agents.get("vulcan")!.kind).toBe("worker");
  });

  it("manifest model: flows into RoleDef", () => {
    const dir = tree({
      "_capabilities.yaml": CAPS,
      "operations/department.yaml": OPS_DEPT,
      "operations/hermes.yaml": HERMES,
      "operations/m.yaml": agentYaml("mmm", "model: claude-haiku-4-5-20251001\nkind: worker\ncapabilities: [files-ro]"),
    });
    expect(loadRegistry(dir, join(dir, "nopb"), {}, () => {}).agents.get("mmm")!.role.model)
      .toBe("claude-haiku-4-5-20251001");
  });
});
