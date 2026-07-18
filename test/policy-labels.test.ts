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
  it("calendar event → personal.calendar; a mail thread → union of dept + participant-dept labels", () => {
    expect(docLabels({ source: "event", domain: "inbox" })).toEqual(["personal.calendar"]);
    expect(docLabels({ source: "mail", domain: "money", dept: "finance" })).toEqual(["personal.finance"]);
    expect(docLabels({ source: "mail", domain: "code", dept: "engineering" })).toEqual(["org.internal"]);
    expect(docLabels({ source: "decision", domain: "code" })).toEqual(["org.internal"]);
    expect(docLabels({ source: "vault", domain: "general" })).toEqual(["shared"]);
    expect(docLabels({ source: "memo", domain: "money" })).toEqual(["personal.finance"]);
  });

  it("mail participant-union: a private-dept participant labels a cross-dept thread (wall-deletion spec)", () => {
    // midas participating in an engineering thread — the thread must carry personal.finance
    expect(docLabels({ source: "mail", domain: "code", dept: "engineering", participantDepts: ["engineering", "finance"] }))
      .toEqual(expect.arrayContaining(["org.internal", "personal.finance"]));
    // duplicates collapse
    expect(docLabels({ source: "mail", domain: "money", dept: "finance", participantDepts: ["finance", "finance"] }))
      .toEqual(["personal.finance"]);
  });

  it("email decisions carry personal.email; calendar decisions keep personal.calendar (wall-deletion spec)", () => {
    expect(docLabels({ source: "decision", domain: "inbox", actionType: "email.send" })).toEqual(["personal.email"]);
    expect(docLabels({ source: "decision", domain: "inbox", actionType: "calendar.accept" })).toEqual(["personal.calendar"]);
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
