// test/skills-assign.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchSkillMd, agentYamlPath, rewriteSkillsField } from "../src/web/skills-view.js";

function fakeFetch(body: string, init?: { status?: number; contentType?: string }): typeof fetch {
  return (async () =>
    new Response(body, {
      status: init?.status ?? 200,
      headers: { "content-type": init?.contentType ?? "text/plain" },
    })) as unknown as typeof fetch;
}

describe("fetchSkillMd", () => {
  it("returns text from an https url", async () => {
    const r = await fetchSkillMd("https://example.com/SKILL.md", fakeFetch("---\nname: x\n---\nbody"));
    expect(r).toEqual({ ok: true, md: "---\nname: x\n---\nbody" });
  });
  it("rejects non-https and invalid urls without calling fetch", async () => {
    expect(await fetchSkillMd("http://example.com/x", fakeFetch("x"))).toMatchObject({ ok: false, error: "https only" });
    expect(await fetchSkillMd("not a url", fakeFetch("x"))).toMatchObject({ ok: false, error: "invalid url" });
  });
  it("rejects non-text content-type, oversize, and HTTP errors", async () => {
    expect(await fetchSkillMd("https://x.com/a", fakeFetch("bin", { contentType: "application/octet-stream" })))
      .toMatchObject({ ok: false });
    expect(await fetchSkillMd("https://x.com/a", fakeFetch("x".repeat(262_145)))).toMatchObject({ ok: false });
    expect(await fetchSkillMd("https://x.com/a", fakeFetch("nope", { status: 404 }))).toMatchObject({ ok: false, error: "HTTP 404" });
  });
});

describe("agentYamlPath", () => {
  it("finds <dept>/<name>.yaml directly, falls back to scanning for matching name", () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    mkdirSync(join(dir, "research"));
    writeFileSync(join(dir, "research", "janus.yaml"), "name: janus\n");
    writeFileSync(join(dir, "research", "renamed-file.yaml"), "name: venus\n");
    writeFileSync(join(dir, "research", "department.yaml"), "department: research\n");
    const def = (n: string) => ({ department: "research", manifest: { name: n } });
    expect(agentYamlPath(dir, def("janus"))).toBe(join(dir, "research", "janus.yaml"));
    expect(agentYamlPath(dir, def("venus"))).toBe(join(dir, "research", "renamed-file.yaml"));
    expect(agentYamlPath(dir, def("nobody"))).toBeNull();
  });
});

describe("rewriteSkillsField", () => {
  const SRC = `name: janus\n# keep this comment\ntools: [Read]\nskills: [market-sizing]\nkind: worker\n`;
  it("replaces the skills array and preserves comments + other fields", () => {
    const out = rewriteSkillsField(SRC, ["market-sizing", "design-tokens"]);
    expect(out).toContain("# keep this comment");
    expect(out).toContain("design-tokens");
    expect(out).toContain("kind: worker");
  });
  it("adds the key when absent, removes it when empty", () => {
    expect(rewriteSkillsField("name: odin\n", ["a-skill"])).toContain("a-skill");
    expect(rewriteSkillsField(SRC, [])).not.toContain("skills");
  });
});
