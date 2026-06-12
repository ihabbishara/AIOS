// test/voice-service.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceService } from "../src/voice/index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "aios-voice-"));
}

const okProbe = async () => true;
const noProbe = async () => false;

describe("VoiceService.create", () => {
  it("disabled by config kill-switch", async () => {
    const v = await VoiceService.create({
      enabled: false, whisperModel: "base", ttsVoice: "say", dataDir: tmp(), probeFn: okProbe,
    });
    expect(v.available()).toBe(false);
    expect(v.disabledReason()).toContain("AIOS_VOICE_ENABLED");
  });

  it("disabled when binaries are missing", async () => {
    const v = await VoiceService.create({
      enabled: true, whisperModel: "base", ttsVoice: "say", dataDir: tmp(), probeFn: noProbe,
    });
    expect(v.available()).toBe(false);
    expect(v.disabledReason()).toContain("missing");
  });

  it("available when probes pass; transcribe/synthesize reject when disabled", async () => {
    const dir = tmp();
    const on = await VoiceService.create({
      enabled: true, whisperModel: "base", ttsVoice: "say", dataDir: dir, probeFn: okProbe,
    });
    expect(on.available()).toBe(true);
    const off = await VoiceService.create({
      enabled: false, whisperModel: "base", ttsVoice: "say", dataDir: dir, probeFn: okProbe,
    });
    await expect(off.transcribe("/nope.ogg")).rejects.toThrow("voice disabled");
    await expect(off.synthesize("hi")).rejects.toThrow("voice disabled");
  });
});

describe("VoiceService queue", () => {
  it("serializes transcriptions (no overlap)", async () => {
    const dir = tmp();
    const v = await VoiceService.create({
      enabled: true, whisperModel: "base", ttsVoice: "say", dataDir: dir, probeFn: okProbe,
    });
    let active = 0;
    let maxActive = 0;
    // Replace the engine pipeline with an instrumented stub (test-only injection point).
    v._setSttForTests({
      transcribe: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return "ok";
      },
    });
    await Promise.all([v.transcribe("/a.ogg"), v.transcribe("/b.ogg"), v.transcribe("/c.ogg")]);
    expect(maxActive).toBe(1);
  });
});
