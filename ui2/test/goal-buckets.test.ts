// ui2/test/goal-buckets.test.ts
import { describe, it, expect } from "vitest";
import { bucketOf, provenance, BUCKETS } from "../src/lib/goal-buckets.js";

describe("goal buckets", () => {
  it("maps every engine status", () => {
    expect(bucketOf("failed")).toBe("needs");
    expect(bucketOf("running")).toBe("running");
    expect(bucketOf("planning")).toBe("running");
    expect(bucketOf("replanning")).toBe("running");
    expect(bucketOf("paused-budget")).toBe("waiting");
    expect(bucketOf("paused-user")).toBe("waiting");
    expect(bucketOf("awaiting-mail")).toBe("waiting");
    expect(bucketOf("done")).toBe("done");
    expect(bucketOf("abandoned")).toBe("abandoned");
    expect(bucketOf("anything-else")).toBe("running");
  });
  it("bucket order is the spec order", () => {
    expect(BUCKETS.map((b) => b.key)).toEqual(["needs", "running", "waiting", "done", "abandoned"]);
  });
  it("provenance chips", () => {
    expect(provenance("mail")).toBe("mail");
    expect(provenance("speculate")).toBe("speculate");
    expect(provenance("dream")).toBe("speculate");
    expect(provenance("web")).toBe("chat");
    expect(provenance("telegram")).toBe("chat");
  });
});
