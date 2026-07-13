// test/policy.test.ts
import { describe, it, expect } from "vitest";
import { rawCheck, Policy, type Label, type Sink, type Violation } from "../src/kernel/policy.js";

describe("rawCheck — label × sink table (spec §5)", () => {
  it("shared goes everywhere", () => {
    for (const sink of ["recall-index", "vault", "brief", "standup", "chat:primary", "mail:iris", "prompt.system:hermes", "file-export"] as Sink[]) {
      expect(rawCheck({ labels: ["shared"], sink })).toBe("allow");
    }
  });

  it("personal.finance: only primary/web chat + private-agent prompts; nothing else", () => {
    const priv = { labels: ["personal.finance"] };
    expect(rawCheck({ labels: ["personal.finance"], sink: "chat:primary" })).toBe("allow");
    expect(rawCheck({ labels: ["personal.finance"], sink: "chat:web-ui" })).toBe("allow");
    expect(rawCheck({ labels: ["personal.finance"], sink: "prompt.system:midas", agent: priv })).toBe("allow");
    expect(rawCheck({ labels: ["personal.finance"], sink: "recall-index" })).toBe("deny");
    expect(rawCheck({ labels: ["personal.finance"], sink: "vault" })).toBe("deny");
    expect(rawCheck({ labels: ["personal.finance"], sink: "brief" })).toBe("deny");
    expect(rawCheck({ labels: ["personal.finance"], sink: "prompt.system:hermes", agent: { labels: [] } })).toBe("deny");
  });

  it("personal.email: prompt.context:speculate-email only; declassify D1 → brief", () => {
    expect(rawCheck({ labels: ["personal.email"], sink: "prompt.context:speculate-email" })).toBe("allow");
    expect(rawCheck({ labels: ["personal.email"], sink: "recall-index" })).toBe("deny");
    expect(rawCheck({ labels: ["personal.email"], sink: "brief" })).toEqual({ declassify: "D1-email-count" });
  });

  it("personal.tasks: primary chat + brief (title relaxation)", () => {
    expect(rawCheck({ labels: ["personal.tasks"], sink: "chat:primary" })).toBe("allow");
    expect(rawCheck({ labels: ["personal.tasks"], sink: "brief" })).toBe("allow");
    expect(rawCheck({ labels: ["personal.tasks"], sink: "recall-index" })).toBe("deny");
  });

  it("personal.calendar: brief + recall-index + private/coordinator prompts", () => {
    expect(rawCheck({ labels: ["personal.calendar"], sink: "brief" })).toBe("allow");
    expect(rawCheck({ labels: ["personal.calendar"], sink: "recall-index" })).toBe("allow");
    expect(rawCheck({ labels: ["personal.calendar"], sink: "prompt.system:hermes", agent: { labels: [] } })).toBe("allow"); // coordinator
    expect(rawCheck({ labels: ["personal.calendar"], sink: "file-export" })).toBe("deny");
  });

  it("client.halalo: halalo prompts + export dirs only", () => {
    expect(rawCheck({ labels: ["client.halalo"], sink: "prompt.system:halalo", agent: { labels: ["client.halalo"] } })).toBe("allow");
    expect(rawCheck({ labels: ["client.halalo"], sink: "file-export" })).toBe("allow");
    expect(rawCheck({ labels: ["client.halalo"], sink: "recall-index" })).toBe("deny");
    expect(rawCheck({ labels: ["client.halalo"], sink: "prompt.system:hermes", agent: { labels: [] } })).toBe("deny");
  });

  it("org.internal: all sinks except file-export and non-primary chat", () => {
    expect(rawCheck({ labels: ["org.internal"], sink: "recall-index" })).toBe("allow");
    expect(rawCheck({ labels: ["org.internal"], sink: "brief" })).toBe("allow");
    expect(rawCheck({ labels: ["org.internal"], sink: "chat:primary" })).toBe("allow");
    expect(rawCheck({ labels: ["org.internal"], sink: "file-export" })).toBe("deny");
    expect(rawCheck({ labels: ["org.internal"], sink: "chat:telegram:999" })).toBe("deny");
  });

  it("untrusted origin: never prompt.system, regardless of label", () => {
    expect(rawCheck({ labels: ["personal.calendar"], origin: "untrusted", sink: "prompt.system:hermes", agent: { labels: [] } })).toBe("deny");
    expect(rawCheck({ labels: ["shared"], origin: "untrusted", sink: "prompt.system:hermes", agent: { labels: [] } })).toBe("deny");
    // context is allowed (fenced data) for untrusted
    expect(rawCheck({ labels: ["shared"], origin: "untrusted", sink: "prompt.context:hermes" })).toBe("allow");
  });

  it("multi-label = strictest wins (union of inputs, no laundering)", () => {
    expect(rawCheck({ labels: ["shared", "personal.finance"], sink: "recall-index" })).toBe("deny");
  });
});

describe("Policy modes", () => {
  it("audit reports a deny but returns allow (blocks nothing)", () => {
    const seen: Violation[] = [];
    const p = new Policy({ mode: "audit", report: (v) => seen.push(v) });
    expect(p.check({ labels: ["personal.finance"], sink: "recall-index" }, "indexer:mail", "recall-index-secret")).toBe("allow");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ label: "personal.finance", sink: "recall-index", site: "indexer:mail" });
    expect(seen[0].hash).toBeTruthy();
    expect(JSON.stringify(seen[0])).not.toContain("recall-index-secret"); // no content, only hash
  });
  it("enforce returns deny and still reports", () => {
    const seen: Violation[] = [];
    const p = new Policy({ mode: "enforce", report: (v) => seen.push(v) });
    expect(p.check({ labels: ["personal.finance"], sink: "recall-index" }, "indexer:mail")).toBe("deny");
    expect(seen).toHaveLength(1);
  });
  it("enforce: missing label at a sink stricter than chat is denied", () => {
    const p = new Policy({ mode: "enforce", report: () => {} });
    expect(p.check({ labels: [], sink: "recall-index" }, "x")).toBe("deny");
    expect(p.check({ labels: [], sink: "chat:primary" }, "x")).toBe("allow"); // chat is not stricter
  });
  it("declassify verdict resolves to allow at the named sink", () => {
    const p = new Policy({ mode: "enforce", report: () => {} });
    expect(p.check({ labels: ["personal.email"], sink: "brief" }, "brief:email-count")).toBe("allow");
  });
  it("exposes readonly mode", () => {
    expect(new Policy({ mode: "audit", report: () => {} }).mode).toBe("audit");
    expect(new Policy({ mode: "enforce", report: () => {} }).mode).toBe("enforce");
  });
});
