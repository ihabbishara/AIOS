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

  // A doc.toString() round-trip reformats the WHOLE file (flow padding, re-wrapped
  // folded scalars). Only the skills line may move — assert the rest byte-for-byte.
  const REAL = `name: janus
title: Market Researcher
charter: >
  Market research: competitors, pricing, audience, TAM/SAM/SOM. Produces a
  fully sourced markdown report with a concrete recommendation.
tools: [Read, Grep, Glob, WebSearch, WebFetch, recall, vault_read, vault_write]
maxTurns: 40
skills: [market-sizing]
aliases: [market-researcher, sami]
kind: worker
`;
  it("touches ONLY the skills line — every other line survives byte-for-byte", () => {
    const out = rewriteSkillsField(REAL, ["market-sizing", "design-tokens"]);
    const before = REAL.split("\n");
    const after = out.split("\n");
    expect(after.length).toBe(before.length);
    const differing = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null);
    expect(differing).toEqual([7]); // the skills line, and nothing else
    expect(after[7]).toBe("skills: [market-sizing, design-tokens]");
  });

  it("emits the repo's flow style and converts a block sequence in place", () => {
    const block = `name: odin\nskills:\n  - a-skill\n  - b-skill\nkind: worker\n`;
    expect(rewriteSkillsField(block, ["a-skill"])).toBe("name: odin\nskills: [a-skill]\nkind: worker\n");
  });

  it("drops the whole pair when empty, leaving neighbours intact", () => {
    expect(rewriteSkillsField(SRC, [])).toBe("name: janus\n# keep this comment\ntools: [Read]\nkind: worker\n");
  });

  it("rejects names that would need quoting rather than emitting broken flow yaml", () => {
    expect(() => rewriteSkillsField(SRC, ["not valid"])).toThrow(/invalid skill name/);
  });
});
