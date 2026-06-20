import { describe, it, expect } from "vitest";
import { parseMembers, parseBindings, parseTrustSeeds, parsePrimaryChat, loadConfig } from "../src/config.js";

describe("parseBindings", () => {
  it("parses default agent plus @-addressable extras", () => {
    const map = parseBindings("telegram:-5137644671=finance|halalo, slack:C123=finance");
    expect(map.get("telegram:-5137644671")).toEqual({ agents: ["finance", "halalo"], mentionOnly: false });
    expect(map.get("slack:C123")).toEqual({ agents: ["finance"], mentionOnly: false });
  });

  it("parses mention-only bindings (@-prefixed)", () => {
    const map = parseBindings("telegram:-5137644671=@finance|@halalo");
    expect(map.get("telegram:-5137644671")).toEqual({ agents: ["finance", "halalo"], mentionOnly: true });
  });

  it("returns empty for unset", () => {
    expect(parseBindings(undefined).size).toBe(0);
  });
});

describe("parseMembers", () => {
  it("parses name:handle pairs and bare names", () => {
    expect(parseMembers("Ihab:theAmsterdamer, Amr:amr_tg, Sara")).toEqual([
      { name: "Ihab", handle: "theAmsterdamer" },
      { name: "Amr", handle: "amr_tg" },
      { name: "Sara" },
    ]);
  });

  it("strips @ prefix from handles", () => {
    expect(parseMembers("Akram:@iAZak")).toEqual([{ name: "Akram", handle: "iAZak" }]);
  });

  it("returns empty for unset", () => {
    expect(parseMembers(undefined)).toEqual([]);
    expect(parseMembers("")).toEqual([]);
  });
});

describe("parseTrustSeeds", () => {
  it("parses type=state pairs", () => {
    const seeds = parseTrustSeeds("vault.write=autonomous, test.echo=supervised");
    expect(seeds.get("vault.write")).toBe("autonomous");
    expect(seeds.get("test.echo")).toBe("supervised");
  });

  it("ignores malformed entries and unknown states", () => {
    const seeds = parseTrustSeeds("bad, x=wat, =autonomous");
    expect(seeds.size).toBe(0);
  });

  it("handles undefined", () => {
    expect(parseTrustSeeds(undefined).size).toBe(0);
  });
});

describe("parsePrimaryChat", () => {
  it("parses channel:chatId", () => {
    expect(parsePrimaryChat("telegram:12345")).toEqual({ channel: "telegram", chatId: "12345" });
  });

  it("splits on the FIRST colon only (negative group ids keep their dash, ids may contain colons)", () => {
    expect(parsePrimaryChat("telegram:-100987")).toEqual({ channel: "telegram", chatId: "-100987" });
    expect(parsePrimaryChat("web:ui:main")).toEqual({ channel: "web", chatId: "ui:main" });
  });

  it("returns undefined for empty/malformed input", () => {
    expect(parsePrimaryChat(undefined)).toBeUndefined();
    expect(parsePrimaryChat("")).toBeUndefined();
    expect(parsePrimaryChat("justachannel")).toBeUndefined();
    expect(parsePrimaryChat(":nochannnel")).toBeUndefined();
  });
});

describe("voice config", () => {
  it("defaults: enabled, base model, af_heart voice", () => {
    delete process.env.AIOS_VOICE_ENABLED;
    delete process.env.AIOS_WHISPER_MODEL;
    delete process.env.AIOS_TTS_VOICE;
    const cfg = loadConfig();
    expect(cfg.voiceEnabled).toBe(true);
    expect(cfg.whisperModel).toBe("base");
    expect(cfg.ttsVoice).toBe("af_heart");
  });

  it("kill-switch and overrides", () => {
    process.env.AIOS_VOICE_ENABLED = "false";
    process.env.AIOS_WHISPER_MODEL = "small";
    process.env.AIOS_TTS_VOICE = "say";
    try {
      const cfg = loadConfig();
      expect(cfg.voiceEnabled).toBe(false);
      expect(cfg.whisperModel).toBe("small");
      expect(cfg.ttsVoice).toBe("say");
    } finally {
      delete process.env.AIOS_VOICE_ENABLED;
      delete process.env.AIOS_WHISPER_MODEL;
      delete process.env.AIOS_TTS_VOICE;
    }
  });
});

describe("senses config", () => {
  it("defaults", () => {
    delete process.env.AIOS_GMAIL_POLL_SECONDS;
    delete process.env.AIOS_CALENDAR_POLL_SECONDS;
    delete process.env.AIOS_MEETING_PING_MINUTES;
    delete process.env.AIOS_GMAIL_SKIP_CATEGORIES;
    const cfg = loadConfig();
    expect(cfg.gmailPollSeconds).toBe(120);
    expect(cfg.calendarPollSeconds).toBe(300);
    expect(cfg.meetingPingMinutes).toBe(15);
    expect(cfg.gmailSkipCategories).toEqual(["promotions", "social"]);
  });

  it("overrides parse", () => {
    process.env.AIOS_GMAIL_POLL_SECONDS = "30";
    process.env.AIOS_GMAIL_SKIP_CATEGORIES = "promotions, updates ,forums";
    try {
      const cfg = loadConfig();
      expect(cfg.gmailPollSeconds).toBe(30);
      expect(cfg.gmailSkipCategories).toEqual(["promotions", "updates", "forums"]);
    } finally {
      delete process.env.AIOS_GMAIL_POLL_SECONDS;
      delete process.env.AIOS_GMAIL_SKIP_CATEGORIES;
    }
  });
});

describe("speculate-email config", () => {
  it("defaults: feature on, no account override, maxJobs 2", () => {
    delete process.env.AIOS_SPECULATE_EMAIL_DISABLED;
    delete process.env.AIOS_SPECULATE_EMAIL_ACCOUNT;
    delete process.env.AIOS_SPECULATE_EMAIL_MAX_JOBS;
    const c = loadConfig();
    expect(c.speculateEmailDisabled).toBe(false);
    expect(c.speculateEmailAccount).toBeUndefined();
    expect(c.speculateEmailMaxJobs).toBe(2);
  });

  it("honors env overrides", () => {
    process.env.AIOS_SPECULATE_EMAIL_DISABLED = "1";
    process.env.AIOS_SPECULATE_EMAIL_ACCOUNT = "personal";
    process.env.AIOS_SPECULATE_EMAIL_MAX_JOBS = "3";
    const c = loadConfig();
    expect(c.speculateEmailDisabled).toBe(true);
    expect(c.speculateEmailAccount).toBe("personal");
    expect(c.speculateEmailMaxJobs).toBe(3);
    delete process.env.AIOS_SPECULATE_EMAIL_DISABLED;
    delete process.env.AIOS_SPECULATE_EMAIL_ACCOUNT;
    delete process.env.AIOS_SPECULATE_EMAIL_MAX_JOBS;
  });
});
