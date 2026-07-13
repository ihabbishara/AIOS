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

import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";

describe("event label stamping (spec §6)", () => {
  it("emit stamps mail.received untrusted/personal.email and calendar.changed untrusted/personal.calendar", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const seen: Array<Record<string, unknown>> = [];
    bus.on((e) => seen.push(e as unknown as Record<string, unknown>));
    bus.emit({ type: "mail.received", account: "a", messageId: "m", threadId: "t", from: "x@y.z", to: "me", subject: "s", snippet: "hi", labels: ["INBOX"], receivedAt: "t" } as never);
    bus.emit({ type: "calendar.changed", account: "a", eventId: "e", summary: "s", start: "t", end: "t", status: "confirmed", organizer: "o" } as never);
    const mail = seen.find((e) => (e.event as { type: string }).type === "mail.received")!;
    const cal = seen.find((e) => (e.event as { type: string }).type === "calendar.changed")!;
    expect(mail.origin).toBe("untrusted");
    expect(mail.labels).toEqual(["personal.email"]);
    expect(cal.origin).toBe("untrusted");
    expect(cal.labels).toEqual(["personal.calendar"]);
  });
  it("a chat event is trusted/org.internal by default", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    let ev: Record<string, unknown> | undefined;
    bus.on((e) => { if ((e.event as { type: string }).type === "chat.in") ev = e as never; });
    bus.emit({ type: "chat.in", channel: "cli", chatId: "l", text: "hi" } as never);
    expect(ev!.origin).toBe("trusted");
    expect(ev!.labels).toEqual(["org.internal"]);
  });
});
