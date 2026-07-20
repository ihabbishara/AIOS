# Department privacy-wall enforcement at hire time

**Date:** 2026-07-20
**Status:** Approved
**Cycle:** ⑦ (follow-up to ② hire/fire and the marco vault-write incident)

## Problem

`validateHire` (src/web/agents-admin.ts) checks that requested capabilities are *known* (`registry.capabilities.has(c)`), but not that they are *allowed for the department*. The life-department privacy wall — no vault_write, no outward/gated tools — exists only as a test assertion (test/lifeops-privacy.test.ts invariant 2), which catches violations after the fact. The marco hire proved the gap live: the UI granted a life-dept agent `vault-write`; the daemon loaded and ran it; only the next full-suite run flagged it.

## Design

### `src/agents/registry/walls.ts` — single source of truth

```ts
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
export function deptWallViolations(dept: string, tools: string[]): string[]
```

Structured as a map so future dept walls are one entry, but only `life` ships now.

### Helper extraction: `toolsFromCaps`

The caps→tools resolution at src/agents/registry/loader.ts:163 (`[...new Set(capNames.flatMap((c) => capabilities.get(c)!.tools).map(fqPackTool))]`) is extracted into an exported `toolsFromCaps(capabilities: Map<string, CapabilityDef>, capNames: string[]): string[]`; the loader calls it, and `validateHire` calls it for the candidate. This guarantees hire-time validation resolves tools exactly the way the loader will after the hire — same DRY-on-the-security-path argument as reusing `isSafe` from attachment-server.

### `validateHire` change

After the existing caps-known loop, with `department` already validated to exist:

```ts
const dept = registry.departments.get(department)!;
const capNames = [...new Set([...dept.capabilities, ...capabilities])];
const violations = deptWallViolations(department, toolsFromCaps(registry.capabilities, capNames));
if (violations.length > 0) {
  return fail(`capability wall: ${department} department agents may not carry ${violations.join(", ")}`);
}
```

Department-granted capabilities are included (dept ∪ requested) because that is the tool surface the loaded agent will actually carry. The 400 message names the offending tools; ui2's HireForm already surfaces error bodies — no UI change.

### Test refactor + coverage

- test/lifeops-privacy.test.ts invariant 2 asserts through the same predicate: `deptWallViolations("life", tools)` must be `[]` across all life-dept agents (its positive assertions — contains `mcp__lifeops__add_task`, `mcp__aios-pack__vault_read` — stay as-is). Test and hire gate can no longer drift.
- New unit tests (walls): exact ban detected, pattern ban detected, unwalled dept returns `[]`, clean life toolset returns `[]`.
- New validateHire tests: rejects the exact marco scenario (life + vault-write) with the wall message; accepts life + web/web-fetch/memory; accepts engineering + vault-write (no wall).

## Not doing (YAGNI)

- Finance walls — finance privacy is label/policy-based (privateMemo, wallVerdict sinks), a different mechanism.
- Runtime re-validation of already-loaded agents — the refactored test carries that invariant.
- ui2 capability filtering/greying — server 400 with a readable message suffices.
- department.yaml schema changes — the wall is code, next to the loader that interprets capabilities.
