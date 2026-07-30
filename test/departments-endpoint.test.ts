// test/departments-endpoint.test.ts — POST /api/departments (onboarding spec §4).
//
// No test in this suite drives src/web/server.ts over HTTP — it needs the whole booted world
// (store, bus, vault, gate, registry, mailbox), which is why the routes are kept thin and the
// logic they call is tested directly. What is new here and untestable with a fake registry is
// the ROUND TRIP: that a rendered manifest is one the real loader accepts.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { validateDepartment, renderDepartmentYaml } from "../src/web/agents-admin.js";

let agentsDir: string, playbooksDir: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "dept-ep-"));
  agentsDir = join(root, "agents");
  playbooksDir = join(root, "playbooks");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(playbooksDir, { recursive: true });
  cpSync(join(process.cwd(), "templates", "_capabilities.yaml"), join(agentsDir, "_capabilities.yaml"));
});

/** Mirrors the route body: validate → write → (reload). */
function post(body: unknown): { status: number; body: unknown } {
  const registry = loadRegistry(agentsDir, playbooksDir);
  const v = validateDepartment(body, registry);
  if (!v.ok) return { status: 400, body: { error: v.error } };
  const dir = join(agentsDir, v.manifest.department);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "department.yaml"), renderDepartmentYaml(v.manifest));
  return { status: 200, body: { department: v.manifest.department, agents: [] } };
}

const good = {
  department: "studio", mission: "Make things.", memoDomain: "studio",
  capabilities: [], playbooks: [],
};

describe("POST /api/departments", () => {
  it("writes a department.yaml the loader accepts", () => {
    const r = post(good);
    expect(r.status).toBe(200);
    expect(existsSync(join(agentsDir, "studio", "department.yaml"))).toBe(true);
    expect(loadRegistry(agentsDir, playbooksDir).departments.has("studio")).toBe(true);
  });

  it("rejects a duplicate department with 400", () => {
    post(good);
    const r = post({ ...good, mission: "Again." });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'department "studio" already exists' });
  });

  it("rejects an unknown capability with 400 and writes nothing", () => {
    const r = post({ ...good, capabilities: ["telepathy"] });
    expect(r.status).toBe(400);
    expect(existsSync(join(agentsDir, "studio"))).toBe(false);
  });

  it("renders a manifest that round-trips its own fields", () => {
    post({ ...good, capabilities: ["reading"] });
    const yaml = readFileSync(join(agentsDir, "studio", "department.yaml"), "utf8");
    expect(yaml).toContain("department: studio");
    expect(yaml).toContain("capabilities: [reading]");
  });
});
