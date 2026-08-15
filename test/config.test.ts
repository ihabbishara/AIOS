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

// Both the dir AND the agent name are env: product source must not name one operator's client,
// so there is nothing to fall back to. Half-configured is not a client — it yields no entry
// rather than an entry keyed on a guess.
describe("client env gating", () => {
  const CLIENT_ENV = ["AIOS_CLIENT_DIR", "AIOS_CLIENT_AGENT"] as const;
  const withClientEnv = async (
    set: Partial<Record<(typeof CLIENT_ENV)[number], string>>,
    body: (x: Record<string, { cwd?: string; contextFiles?: string[] } | undefined>) => void,
  ) => {
    const prev = Object.fromEntries(CLIENT_ENV.map((k) => [k, process.env[k]]));
    for (const k of CLIENT_ENV) delete process.env[k];
    Object.assign(process.env, set);
    try {
      const { buildExtras } = await import("../src/agents/registry/extras.js");
      body(buildExtras({ vaultPath: "/tmp/v", vaultSubdir: "AIOS", financeCompany: "", financeMembers: [] }));
    } finally {
      for (const k of CLIENT_ENV) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k]!;
      }
    }
  };

  it("buildExtras omits the client when nothing is configured", async () => {
    await withClientEnv({}, (x) => {
      expect(x.acme).toBeUndefined();
      expect(x.juno).toBeDefined();   // the rest of the org is unaffected
    });
  });

  it("buildExtras omits the client when only half of it is configured", async () => {
    await withClientEnv({ AIOS_CLIENT_DIR: "/tmp/client-fixture" }, (x) => {
      expect(Object.keys(x)).not.toContain("acme");
    });
    await withClientEnv({ AIOS_CLIENT_AGENT: "acme" }, (x) => {
      expect(x.acme).toBeUndefined();
    });
  });

  it("buildExtras keys the entry on the configured agent name", async () => {
    await withClientEnv({ AIOS_CLIENT_AGENT: "acme", AIOS_CLIENT_DIR: "/tmp/client-fixture" }, (x) => {
      expect(x.acme?.cwd).toBe("/tmp/client-fixture");
      expect(x.acme?.contextFiles).toEqual(["/tmp/client-fixture/CLAUDE.md"]);
    });
  });

  it("the aws-readonly guard names the missing env var instead of silently confining to nothing", async () => {
    const { NAMED_GUARDS } = await import("../src/agents/guards/index.js");
    expect(() => NAMED_GUARDS["aws-readonly"]({ vaultPath: "/tmp/v", vaultSubdir: "AIOS" }))
      .toThrow(/AIOS_CLIENT_DIR/);
  });
});

describe("the daily spend cap is settable", () => {
  it("AIOS_DAILY_BUDGET_USD is an editable config key", async () => {
    // It is the ONLY setting that caps spend — unset, SpendGuard.allow() is always true — and it
    // was missing from CONFIG_KEYS, so the one control that stops a runaway day could not be set
    // from the cockpit at all.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8"));
    const block = src.slice(src.indexOf("const CONFIG_KEYS"), src.indexOf("];", src.indexOf("const CONFIG_KEYS")));
    expect(block).toContain("AIOS_DAILY_BUDGET_USD");
  });

  it("an unset cap really does mean no cap", () => {
    expect(buildConfig({}, "/tmp").dailyBudgetUsd).toBeUndefined();
    expect(buildConfig({ AIOS_DAILY_BUDGET_USD: "20" }, "/tmp").dailyBudgetUsd).toBe(20);
  });
});
