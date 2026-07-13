// test/policy-labels.test.ts
import { describe, it, expect } from "vitest";
import { deptLabel, docLabels } from "../src/kernel/labels.js";

describe("label derivation", () => {
  it("dept → confidentiality label", () => {
    expect(deptLabel("finance")).toBe("personal.finance");
    expect(deptLabel("life")).toBe("personal.tasks");
    expect(deptLabel("clients")).toBe("client.halalo");
    expect(deptLabel("engineering")).toBe("org.internal");
    expect(deptLabel("research")).toBe("org.internal");
  });
  it("calendar event → personal.calendar; a private-participant mail thread → the dept label", () => {
    expect(docLabels({ source: "event", domain: "inbox" })).toEqual(["personal.calendar"]);
    expect(docLabels({ source: "mail", domain: "money", mailPrivate: true, dept: "finance" })).toEqual(["personal.finance"]);
    expect(docLabels({ source: "mail", domain: "code", dept: "engineering" })).toEqual(["org.internal"]);
    expect(docLabels({ source: "decision", domain: "code" })).toEqual(["org.internal"]);
    expect(docLabels({ source: "vault", domain: "general" })).toEqual(["shared"]);
    expect(docLabels({ source: "memo", domain: "money" })).toEqual(["personal.finance"]);
  });
});
