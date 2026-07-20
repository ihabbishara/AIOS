# Hire-Time Department Privacy Walls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `validateHire` rejects capability sets whose resolved tools violate the hiring department's privacy wall (life: no vault_write/outward tools), using the same predicate the lifeops-privacy test pins.

**Architecture:** New pure module `src/agents/registry/walls.ts` holds the per-dept wall rules and `deptWallViolations`. The caps→tools expression from the loader is extracted to `toolsFromCaps` in `src/agents/registry/capabilities.ts` so hire-time validation resolves tools exactly as the loader will. `validateHire` gains one gate; the lifeops-privacy test asserts through the shared predicate.

**Tech Stack:** TypeScript, vitest, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-20-hire-dept-walls-design.md`

## Global Constraints

- No new npm dependencies.
- Trunk-based: commit on main, EXPLICIT file paths only in `git add` (parallel session shares this checkout).
- Builders/validators carry tests in root `test/` (vitest); route wiring stays untouched.
- Do not trust piped vitest exit codes — read the "Tests" summary line.
- Wall error message format exactly: `capability wall: <dept> department agents may not carry <tools joined by ", ">`.
- Life wall values exactly: bannedTools `["mcp__aios-pack__vault_write", "mcp__aios-pack__propose_action"]`, bannedToolPattern `/propose|gate|email|git|calendar/i`. Only `life` is walled.
- Loader refactor must be behavior-identical — the org-golden suite is the arbiter.
- Deploy: `npm run build && launchctl kickstart -k gui/501/com.ihab.aios`, poll `/api/state` (~3s).

---

### Task 1: `walls.ts` predicate + `toolsFromCaps` extraction

**Files:**
- Create: `src/agents/registry/walls.ts`
- Modify: `src/agents/registry/capabilities.ts` (add `toolsFromCaps` export after `fqPackTool`)
- Modify: `src/agents/registry/loader.ts:163` (use the helper)
- Test: `test/dept-walls.test.ts` (new)

**Interfaces:**
- Consumes: `CapabilityDef`, `fqPackTool` (already in capabilities.ts).
- Produces: `deptWallViolations(dept: string, tools: string[]): string[]` and `DEPT_WALLS` from walls.ts; `toolsFromCaps(capabilities: Map<string, CapabilityDef>, capNames: string[]): string[]` from capabilities.ts. Task 2 imports all three names exactly.

- [ ] **Step 1: Write the failing tests**

Create `test/dept-walls.test.ts`:

```ts
// test/dept-walls.test.ts
import { describe, it, expect } from "vitest";
import { deptWallViolations } from "../src/agents/registry/walls.js";
import { toolsFromCaps, type CapabilityDef } from "../src/agents/registry/capabilities.js";

describe("deptWallViolations", () => {
  it("flags exact banned tools for life", () => {
    expect(deptWallViolations("life", ["mcp__aios-pack__vault_write", "WebSearch"]))
      .toEqual(["mcp__aios-pack__vault_write"]);
  });
  it("flags pattern-banned tools for life", () => {
    expect(deptWallViolations("life", ["mcp__gcal__calendar_list"]))
      .toEqual(["mcp__gcal__calendar_list"]);
  });
  it("clean life toolset passes", () => {
    expect(deptWallViolations("life", [
      "mcp__lifeops__add_task", "WebSearch", "WebFetch",
      "mcp__aios-pack__recall", "mcp__aios-pack__vault_read",
    ])).toEqual([]);
  });
  it("unwalled dept always passes", () => {
    expect(deptWallViolations("engineering", ["mcp__aios-pack__vault_write"])).toEqual([]);
  });
});

describe("toolsFromCaps", () => {
  it("dedupes and fully qualifies aios-pack bare tools", () => {
    const caps = new Map<string, CapabilityDef>([
      ["memory", { tools: ["recall", "vault_read"] } as CapabilityDef],
      ["vault-read", { tools: ["vault_read"] } as CapabilityDef],
      ["web", { tools: ["WebSearch", "WebFetch"] } as CapabilityDef],
    ]);
    expect(toolsFromCaps(caps, ["memory", "vault-read", "web"]).sort()).toEqual([
      "WebFetch", "WebSearch", "mcp__aios-pack__recall", "mcp__aios-pack__vault_read",
    ]);
  });
  it("unknown capability contributes no tools", () => {
    expect(toolsFromCaps(new Map(), ["ghost"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/dept-walls.test.ts`
Expected: FAIL — cannot resolve `../src/agents/registry/walls.js`; `toolsFromCaps` not exported. (Read the "Tests" summary line, not the exit code.)

- [ ] **Step 3: Implement**

Create `src/agents/registry/walls.ts`:

```ts
// src/agents/registry/walls.ts — per-department privacy walls (spec 2026-07-20).
// Single source of truth: validateHire enforces at hire time, lifeops-privacy pins at test time.

export interface DeptWall {
  /** Exact fully-qualified tool names this department's agents may never carry. */
  bannedTools: string[];
  /** Pattern ban applied to every fully-qualified tool name. */
  bannedToolPattern?: RegExp;
}

export const DEPT_WALLS: Record<string, DeptWall> = {
  life: {
    bannedTools: ["mcp__aios-pack__vault_write", "mcp__aios-pack__propose_action"],
    bannedToolPattern: /propose|gate|email|git|calendar/i,
  },
};

/** Offending tools for this department, [] when unwalled or clean. */
export function deptWallViolations(dept: string, tools: string[]): string[] {
  const wall = DEPT_WALLS[dept];
  if (!wall) return [];
  return tools.filter(
    (t) => wall.bannedTools.includes(t) || (wall.bannedToolPattern?.test(t) ?? false),
  );
}
```

In `src/agents/registry/capabilities.ts`, add directly after the `fqPackTool` definition:

```ts
/** Deduped, fully-qualified tool list for a set of capability names.
 *  Shared by the loader and the hire gate so both resolve identically. */
export function toolsFromCaps(capabilities: Map<string, CapabilityDef>, capNames: string[]): string[] {
  return [...new Set(capNames.flatMap((c) => capabilities.get(c)?.tools ?? []).map(fqPackTool))];
}
```

In `src/agents/registry/loader.ts`, replace line 163:

```ts
        const tools = [...new Set(capNames.flatMap((c) => capabilities.get(c)!.tools).map(fqPackTool))];
```

with:

```ts
        const tools = toolsFromCaps(capabilities, capNames);
```

and extend the existing import from `./capabilities.js` (line 6) to include `toolsFromCaps`. Remove `fqPackTool` from that import ONLY if the loader no longer references it anywhere else (check with grep first; if still referenced, keep it).

- [ ] **Step 4: Run tests to verify they pass + golden guard**

Run: `npx vitest run test/dept-walls.test.ts test/org-golden.test.ts test/registry-live-tree.test.ts`
Expected: PASS — new units green AND golden/live-tree green (proves the loader refactor is behavior-identical).

- [ ] **Step 5: Commit**

```bash
git add src/agents/registry/walls.ts src/agents/registry/capabilities.ts src/agents/registry/loader.ts test/dept-walls.test.ts
git commit -m "feat(registry): dept walls predicate + shared toolsFromCaps resolution"
```

---

### Task 2: `validateHire` gate + privacy-test refactor

**Files:**
- Modify: `src/web/agents-admin.ts` (imports + gate after the caps-known loop, lines ~30-34)
- Modify: `test/lifeops-privacy.test.ts` (invariant-2 block, lines ~79-94)
- Test: `test/agents-admin.test.ts` (new cases appended)

**Interfaces:**
- Consumes: `deptWallViolations(dept, tools): string[]` from `../agents/registry/walls.js`; `toolsFromCaps(capabilities, capNames): string[]` from `../agents/registry/capabilities.js` (both from Task 1).
- Produces: `validateHire` rejects wall violations with error `capability wall: <dept> department agents may not carry <tools>`. No signature change.

- [ ] **Step 1: Write the failing tests**

Append to `test/agents-admin.test.ts` inside its top-level scope, following the file's existing pattern for building a registry (it already imports or constructs one for validateHire cases — reuse exactly that mechanism; the cases below assume a `reg` built the same way as the file's existing validateHire tests):

```ts
describe("validateHire — dept privacy walls", () => {
  const base = {
    name: "wally", department: "life", kind: "worker" as const,
    title: "T", charter: "C", persona: "P", prompt: "Pr",
  };
  it("rejects life + vault-write (the marco scenario)", () => {
    const r = validateHire({ ...base, capabilities: ["vault-write"] }, reg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/capability wall: life department agents may not carry mcp__aios-pack__vault_write/);
  });
  it("accepts life + web/web-fetch/memory", () => {
    const r = validateHire({ ...base, capabilities: ["web", "web-fetch", "memory"] }, reg);
    expect(r.ok).toBe(true);
  });
  it("accepts engineering + vault-write (no wall)", () => {
    const r = validateHire({ ...base, department: "engineering", capabilities: ["vault-write"] }, reg);
    expect(r.ok).toBe(true);
  });
});
```

In `test/lifeops-privacy.test.ts`, replace the invariant-2 assertions (the `not.toContain` pair and the regex `for` loop) so the block reads:

```ts
describe("lifeops privacy: life department tools contain no outward/gated tools", () => {
  it("life department agents have only mcp__lifeops__* tools plus vault_read", () => {
    const reg = testRegistry();
    expect(reg.departments.get("life")).toBeDefined();
    const tools = [...reg.agents.values()]
      .filter((a) => a.department === "life")
      .flatMap((a) => capabilityTools(reg, a.manifest.name));
    expect(tools).toContain("mcp__lifeops__add_task");
    expect(tools).toContain("mcp__aios-pack__vault_read");
    expect(deptWallViolations("life", tools)).toEqual([]);
  });
});
```

Add the import at the top of the file:

```ts
import { deptWallViolations } from "../src/agents/registry/walls.js";
```

- [ ] **Step 2: Run tests to verify the new cases fail**

Run: `npx vitest run test/agents-admin.test.ts test/lifeops-privacy.test.ts`
Expected: agents-admin FAILS — "rejects life + vault-write" gets `ok: true` (gate not implemented yet). lifeops-privacy PASSES already (live agents are clean; this refactor is equivalence, not new behavior — that is expected, not a broken RED).

- [ ] **Step 3: Implement the gate**

In `src/web/agents-admin.ts`, add imports after line 2:

```ts
import { deptWallViolations } from "../agents/registry/walls.js";
import { toolsFromCaps } from "../agents/registry/capabilities.js";
```

Insert after the capabilities-known loop (after line 32's closing `}`), before the destructuring return:

```ts
  const dept = registry.departments.get(b.department)!;
  const capNames = [...new Set([...dept.capabilities, ...(b.capabilities as string[])])];
  const violations = deptWallViolations(b.department, toolsFromCaps(registry.capabilities, capNames));
  if (violations.length > 0) {
    return fail(`capability wall: ${b.department} department agents may not carry ${violations.join(", ")}`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/agents-admin.test.ts test/lifeops-privacy.test.ts test/dept-walls.test.ts`
Expected: PASS — all three files green.

- [ ] **Step 5: Commit**

```bash
git add src/web/agents-admin.ts test/agents-admin.test.ts test/lifeops-privacy.test.ts
git commit -m "feat(web): validateHire enforces dept privacy walls — life rejects vault-write at hire time"
```

---

### Task 3: Full-suite gate + deploy + push

**Files:** none created/modified (verification and shipping only).

**Interfaces:**
- Consumes: Tasks 1-2 committed on main.
- Produces: deployed daemon enforcing the wall; main pushed.

- [ ] **Step 1: Typecheck both roots + full suite**

Run: `npx tsc --noEmit && (cd ui2 && npx tsc --noEmit); cd /Users/ihabbishara/projects/AIOS`
Expected: clean.

Run: `npx vitest run`
Expected: "Tests" summary line all passing (baseline 1374 passed | 2 skipped across 185 files; count grows by the new cases). If unrelated tests fail, STOP and report — do not fix them.

- [ ] **Step 2: Deploy + verify**

```bash
npm run build && launchctl kickstart -k gui/501/com.ihab.aios
```

Poll until ready:

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 10 -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/state | head -c 200
```

Expected: JSON state. Then live-prove the wall via the API (validation-only — the hire is REJECTED, so nothing is created; still, use a throwaway name):

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/agents \
  -d '{"name":"walltest","department":"life","kind":"worker","title":"T","charter":"C","persona":"P","prompt":"Pr","capabilities":["vault-write"]}'
```

Expected: HTTP 400-class response whose body contains `capability wall: life department agents may not carry mcp__aios-pack__vault_write`. Confirm no agent was created: `ls agents/life/` must NOT contain `walltest.yaml`. Check `tail -10 data/aios.err.log` for new errors (expect none).

- [ ] **Step 3: Push**

```bash
git push origin main
```
