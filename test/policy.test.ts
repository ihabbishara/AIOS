// test/policy.test.ts
import { describe, it, expect } from "vitest";
import { rawCheck, wallVerdict, Policy, type Label, type Sink, type Violation } from "../src/kernel/policy.js";

describe("rawCheck — label × sink table (spec §5)", () => {
  it("shared goes everywhere", () => {
    for (const sink of ["recall-index", "vault", "brief", "standup", "chat:primary", "mail:iris", "prompt.system:neo", "file-export"] as Sink[]) {
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
    expect(rawCheck({ labels: ["personal.finance"], sink: "prompt.system:neo", agent: { labels: [] } })).toBe("deny");
  });

  it("personal.email: prompt.context:speculate-email only; declassify D1 → brief", () => {
    expect(rawCheck({ labels: ["personal.email"], sink: "prompt.context:speculate-email" })).toBe("allow");
    expect(rawCheck({ labels: ["personal.email"], sink: "recall-index" })).toBe("deny");
    expect(rawCheck({ labels: ["personal.email"], sink: "brief" })).toEqual({ declassify: "D1-email-count" });
  });

  it("personal.tasks: primary chat + brief + standup (money wall is finance-only)", () => {
    expect(rawCheck({ labels: ["personal.tasks"], sink: "chat:primary" })).toBe("allow");
    expect(rawCheck({ labels: ["personal.tasks"], sink: "brief" })).toBe("allow");
    expect(rawCheck({ labels: ["personal.tasks"], sink: "standup" })).toBe("allow");
    expect(rawCheck({ labels: ["personal.tasks"], sink: "recall-index" })).toBe("deny");
  });

  it("personal.calendar: brief + recall-index + private/coordinator prompts", () => {
    expect(rawCheck({ labels: ["personal.calendar"], sink: "brief" })).toBe("allow");
    expect(rawCheck({ labels: ["personal.calendar"], sink: "recall-index" })).toBe("allow");
    expect(rawCheck({ labels: ["personal.calendar"], sink: "prompt.system:neo", agent: { labels: [] } })).toBe("allow"); // coordinator
    expect(rawCheck({ labels: ["personal.calendar"], sink: "file-export" })).toBe("deny");
  });

  it("client.halalo: halalo prompts + export dirs + brief/standup; still walled from recall + foreign prompts", () => {
    expect(rawCheck({ labels: ["client.halalo"], sink: "prompt.system:halalo", agent: { labels: ["client.halalo"] } })).toBe("allow");
    expect(rawCheck({ labels: ["client.halalo"], sink: "file-export" })).toBe("allow");
    expect(rawCheck({ labels: ["client.halalo"], sink: "brief" })).toBe("allow");
    expect(rawCheck({ labels: ["client.halalo"], sink: "standup" })).toBe("allow");
    expect(rawCheck({ labels: ["client.halalo"], sink: "recall-index" })).toBe("deny");
    expect(rawCheck({ labels: ["client.halalo"], sink: "prompt.system:neo", agent: { labels: [] } })).toBe("deny");
  });

  it("org.internal: all sinks except file-export and non-primary chat", () => {
    expect(rawCheck({ labels: ["org.internal"], sink: "recall-index" })).toBe("allow");
    expect(rawCheck({ labels: ["org.internal"], sink: "brief" })).toBe("allow");
    expect(rawCheck({ labels: ["org.internal"], sink: "chat:primary" })).toBe("allow");
    expect(rawCheck({ labels: ["org.internal"], sink: "file-export" })).toBe("deny");
    expect(rawCheck({ labels: ["org.internal"], sink: "chat:telegram:999" })).toBe("deny");
  });

  it("untrusted origin: never prompt.system, regardless of label", () => {
    expect(rawCheck({ labels: ["personal.calendar"], origin: "untrusted", sink: "prompt.system:neo", agent: { labels: [] } })).toBe("deny");
    expect(rawCheck({ labels: ["shared"], origin: "untrusted", sink: "prompt.system:neo", agent: { labels: [] } })).toBe("deny");
    // context is allowed (fenced data) for untrusted
    expect(rawCheck({ labels: ["shared"], origin: "untrusted", sink: "prompt.context:neo" })).toBe("allow");
  });

  it("multi-label = strictest wins (union of inputs, no laundering)", () => {
    expect(rawCheck({ labels: ["shared", "personal.finance"], sink: "recall-index" })).toBe("deny");
  });

  it("a declassify rule cannot launder a co-present stricter label", () => {
    // D1 lowers personal.email → brief. personal.finance has NO brief rule, so a brief carrying
    // BOTH must deny — email's rule may not rescue finance. (Regression: the rule used to match
    // the whole input, letting finance ride D1 into the vaulted+indexed brief.)
    expect(rawCheck({ labels: ["personal.email", "personal.finance"], sink: "brief" })).toBe("deny");
    // order-independent
    expect(rawCheck({ labels: ["personal.finance", "personal.email"], sink: "brief" })).toBe("deny");
    // the legitimate single-label declassify still resolves
    expect(rawCheck({ labels: ["personal.email"], sink: "brief" })).toEqual({ declassify: "D1-email-count" });
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
  it("audit PREVIEWS an unlabeled-sensitive flow: reports it, returns allow", () => {
    const seen: Violation[] = [];
    const p = new Policy({ mode: "audit", report: (v) => seen.push(v) });
    expect(p.check({ labels: [], sink: "recall-index" }, "indexer:x", "secret")).toBe("allow");
    expect(seen).toHaveLength(1); // enforce would deny this — audit must surface it, not hide it
    expect(p.check({ labels: [], sink: "chat:primary" }, "x")).toBe("allow");
    expect(seen).toHaveLength(1); // chat is not sensitive — no new violation
  });
  it("names the offending label on a multi-label deny, not labels[0]", () => {
    const seen: Violation[] = [];
    const p = new Policy({ mode: "audit", report: (v) => seen.push(v) });
    p.check({ labels: ["shared", "personal.finance"], sink: "recall-index" }, "site");
    expect(seen[0].label).toBe("personal.finance"); // shared passes; finance is the real offender
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

describe("Policy.wall — wall-replacement sites (wall-deletion spec)", () => {
  it("denies in AUDIT mode too (parity with the pre-policy wall, not a new block)", () => {
    const seen: Violation[] = [];
    const p = new Policy({ mode: "audit", report: (v) => seen.push(v) });
    expect(p.wall({ labels: ["personal.finance"], sink: "recall-index" }, "indexer:mail", "x")).toBe("deny");
    expect(seen).toHaveLength(1);
    expect(seen[0].label).toBe("personal.finance");
    expect(seen[0].site).toBe("indexer:mail");
  });
  it("denies in enforce mode and reports", () => {
    const seen: Violation[] = [];
    const p = new Policy({ mode: "enforce", report: (v) => seen.push(v) });
    expect(p.wall({ labels: ["client.halalo"], sink: "recall-index" }, "indexer:mail")).toBe("deny");
    expect(seen).toHaveLength(1);
  });
  it("allows clean flows without reporting", () => {
    const seen: Violation[] = [];
    const p = new Policy({ mode: "audit", report: (v) => seen.push(v) });
    expect(p.wall({ labels: ["org.internal"], sink: "recall-index" }, "indexer:mail")).toBe("allow");
    expect(seen).toHaveLength(0);
  });
  it("declassify rules still allow", () => {
    const p = new Policy({ mode: "audit", report: () => {} });
    expect(p.wall({ labels: ["personal.email"], sink: "brief" }, "brief:email-count")).toBe("allow");
  });
});

describe("D2 finance decision previews (wall-deletion spec)", () => {
  it("rescues ONLY the decision-preview flow at recall-index", () => {
    expect(rawCheck({ labels: ["personal.finance"], sink: "recall-index", flow: "decision-preview" }))
      .toEqual({ declassify: "D2-finance-decision-preview" });
    expect(rawCheck({ labels: ["personal.finance"], sink: "recall-index" })).toBe("deny");
    expect(rawCheck({ labels: ["personal.finance"], sink: "vault", flow: "decision-preview" })).toBe("deny");
  });
  it("cannot launder a co-present stricter label", () => {
    expect(rawCheck({ labels: ["personal.finance", "personal.email"], sink: "recall-index", flow: "decision-preview" })).toBe("deny");
  });
});

describe("wallVerdict — absent Policy still fail-closed", () => {
  it("denies from the table with no Policy instance", () => {
    expect(wallVerdict(undefined, { labels: ["personal.finance"], sink: "recall-index" }, "indexer:mail")).toBe("deny");
    expect(wallVerdict(undefined, { labels: ["org.internal"], sink: "recall-index" }, "indexer:mail")).toBe("allow");
  });
});

describe("personal.tasks prompt clearance (wall-deletion spec table fix)", () => {
  it("a cleared prompt agent (jasmine via lifeops label) gets tasks content", () => {
    expect(rawCheck({ labels: ["personal.tasks"], sink: "prompt.system:jasmine", agent: { labels: ["personal.tasks"] } })).toBe("allow");
  });
  it("an uncleared prompt agent stays denied", () => {
    expect(rawCheck({ labels: ["personal.tasks"], sink: "prompt.system:neo", agent: { labels: [] } })).toBe("deny");
  });
});
