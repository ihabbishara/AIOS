import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("bunq read-only invariant", () => {
  it("scripts/bunq_read.py contains no write/payment endpoints", () => {
    const src = readFileSync(new URL("../scripts/bunq_read.py", import.meta.url), "utf8");
    // Read path must NEVER reference money-moving / write SDK calls.
    expect(src).not.toMatch(/RequestInquiry|DraftPayment|PaymentBatch|RequestResponse|SchedulePayment|\.create\(|\.update\(|\.delete\(/);
  });
});
