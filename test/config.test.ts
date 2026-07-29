import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseMembers, parseBindings, parseTrustSeeds, parsePrimaryChat, loadConfig, buildConfig } from "../src/config.js";

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

describe("lifeops config", () => {
  it("defaults the lifeops knobs", () => {
    delete process.env.AIOS_LIFEOPS_POLL_SECONDS;
    delete process.env.AIOS_LIFEOPS_SOON_DAYS;
    delete process.env.AIOS_LIFEOPS_STALE_DAYS;
    const c = loadConfig();
    expect(c.lifeopsPollSeconds).toBe(21600);
    expect(c.lifeopsSoonDays).toBe(2);
    expect(c.lifeopsStaleDays).toBe(14);
  });
});

// A fresh install must land on neutral ground: no operator's desktop, no operator's
// company, no operator's client repo. Every personal value is env-supplied now.
describe("de-personalized defaults", () => {
  const SAVED: Record<string, string | undefined> = {};
  const KEYS = ["AIOS_VAULT_PATH", "AIOS_FINANCE_COMPANY", "AIOS_HALALO_DIR"];
  beforeEach(() => { for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

  it("vault defaults to ~/AIOS/workspace, finance company to empty", () => {
    const c = buildConfig(process.env, "/tmp/aios-root");
    expect(c.vaultPath.endsWith("/AIOS/workspace")).toBe(true);
    expect(c.vaultPath.includes("Desktop")).toBe(false);
    expect(c.financeCompany).toBe("");
  });

  it("env still overrides both", () => {
    process.env.AIOS_VAULT_PATH = "/tmp/custom-vault";
    process.env.AIOS_FINANCE_COMPANY = "ACME";
    const c = buildConfig(process.env, "/tmp/aios-root");
    expect(c.vaultPath).toBe("/tmp/custom-vault");
    expect(c.financeCompany).toBe("ACME");
  });
});

describe("halalo env gating", () => {
  it("buildExtras omits halalo when AIOS_HALALO_DIR is unset", async () => {
    const prev = process.env.AIOS_HALALO_DIR;
    delete process.env.AIOS_HALALO_DIR;
    try {
      const { buildExtras } = await import("../src/agents/registry/extras.js");
      const x = buildExtras({ vaultPath: "/tmp/v", vaultSubdir: "AIOS", financeCompany: "", financeMembers: [] });
      expect(x.halalo).toBeUndefined();
      expect(x.juno).toBeDefined();
    } finally {
      if (prev !== undefined) process.env.AIOS_HALALO_DIR = prev;
    }
  });

  it("buildExtras builds halalo from AIOS_HALALO_DIR when set", async () => {
    const prev = process.env.AIOS_HALALO_DIR;
    process.env.AIOS_HALALO_DIR = "/tmp/halalo-fixture";
    try {
      const { buildExtras } = await import("../src/agents/registry/extras.js");
      const x = buildExtras({ vaultPath: "/tmp/v", vaultSubdir: "AIOS", financeCompany: "", financeMembers: [] });
      expect(x.halalo?.cwd).toBe("/tmp/halalo-fixture");
      expect(x.halalo?.contextFiles).toEqual(["/tmp/halalo-fixture/CLAUDE.md"]);
    } finally {
      if (prev === undefined) delete process.env.AIOS_HALALO_DIR;
      else process.env.AIOS_HALALO_DIR = prev;
    }
  });

  it("the halalo-readonly guard names the missing env var instead of silently confining to nothing", async () => {
    const { NAMED_GUARDS } = await import("../src/agents/guards/index.js");
    expect(() => NAMED_GUARDS["halalo-readonly"]({ vaultPath: "/tmp/v", vaultSubdir: "AIOS" }))
      .toThrow(/AIOS_HALALO_DIR/);
  });
});
