import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttachmentRegistry, mimeFor } from "../src/web/attachment-registry.js";

const safeRoot = realpathSync(mkdtempSync(join(tmpdir(), "aios-reg-")));
function file(name: string): string {
  const p = join(safeRoot, name);
  writeFileSync(p, "x");
  return p;
}

describe("mimeFor", () => {
  it("maps known extensions and defaults to octet-stream", () => {
    expect(mimeFor("chart.png")).toBe("image/png");
    expect(mimeFor("voice.ogg")).toBe("audio/ogg");
    expect(mimeFor("d.svg")).toBe("image/svg+xml");
    expect(mimeFor("x.bin")).toBe("application/octet-stream");
  });
});

describe("attachment registry", () => {
  it("registers a safe path and returns a descriptor resolvable by token", () => {
    const reg = createAttachmentRegistry([safeRoot]);
    const d = reg.register(file("chart.png"), { caption: "hi" });
    expect(d.token).toMatch(/.{16,}/);
    expect(d.name).toBe("chart.png");
    expect(d.mime).toBe("image/png");
    expect(d.caption).toBe("hi");
    const got = reg.get(d.token);
    expect(got?.mime).toBe("image/png");
    expect(got?.name).toBe("chart.png");
  });

  it("carries kind through and mints distinct tokens", () => {
    const reg = createAttachmentRegistry([safeRoot]);
    const a = reg.register(file("a.ogg"), { kind: "voice" });
    const b = reg.register(file("b.png"));
    expect(a.kind).toBe("voice");
    expect(a.token).not.toBe(b.token);
  });

  it("rejects a path outside the safe roots", () => {
    const reg = createAttachmentRegistry([safeRoot]);
    expect(() => reg.register("/etc/hosts")).toThrow();
  });

  it("returns undefined for unknown or expired tokens and sweeps on register", () => {
    let t = 1000;
    const reg = createAttachmentRegistry([safeRoot], { ttlMs: 100, now: () => t });
    const d = reg.register(file("c.png"));
    expect(reg.get(d.token)).toBeDefined();
    t = 1201; // past ttl
    expect(reg.get(d.token)).toBeUndefined(); // expired -> undefined
    reg.register(file("d.png")); // triggers sweep of expired entry
    expect(reg.get("nope")).toBeUndefined();
  });
});
