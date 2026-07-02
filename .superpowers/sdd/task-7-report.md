# Task 7 Report

**Status:** COMPLETE

**Commit:** `828eba2 feat(staff): hand_off with full capability parity; Rami roster from registry`

**Test summary:** 115 files, 684 passed + 1 skipped — all green. 3 new tests in `test/hand-off.test.ts` (capability parity, tool routing, ask_specialist absence).

**Changes made:**
- `src/moderator/tools.ts`: Removed `consult`/`roles` import; added `handOff`+`agentNames` to `ModeratorToolsDeps`; replaced `askSpecialist` tool with `hand_off` tool.
- `src/moderator/prompt.ts`: New signature with `roster: RosterEntry[]`; opening line → "You are Rami, Chief of Staff…"; dept-grouped team block; `ask_specialist` rule → `hand_off` rule.
- `src/moderator/session.ts`: Removed `run: SpecialistRunFn`; added `handOff`+`registry: LoadedRegistry` to `ModeratorDeps`; builds roster+agentNames from registry; prepends rami persona prefix; `effectiveAllowedTools`/`withDenialObserver` use "rami".
- `src/index.ts`: Added `handOff` closure (bus event + resolveDeptFor + runSpecialist); passes `handOff`+`registry` to Moderator (removed `run:`).
- `src/store/db.ts`: One-time migration `UPDATE role_permissions SET role='rami' WHERE role='moderator'`.
- `src/web/permissions-view.ts`: Catalog entry renamed moderator→rami with updated description.
- `src/web/server.ts`: Agent info block moderator→rami, ask_specialist→hand_off.
- `src/router.ts`: `agentTurn("moderator",...)` → `agentTurn("rami",...)`, reset fallback moderator→rami.
- `test/permissions-view.test.ts`: Updated expectations moderator→rami.
- `test/hand-off.test.ts`: New — capability parity pin, hand_off routing, tool-list assertion.

**Concerns:** None. The `moderator-session:` KV key prefix intentionally kept as-is (internal storage key, not role name).

**Report path:** `/Users/ihabbishara/projects/AIOS/.claude/worktrees/staff-registry/.superpowers/sdd/task-7-report.md`

---

## Review Fix Report — commit `95eed1d`

**Commit:** `95eed1d fix(staff): real capability-parity pin + rami/moderator web sentinel`

**Test summary:** 115 files, 689 passed + 1 skipped — all green (+5 new tests).

### Finding 1 (Critical) — Parity pin rewritten

**Approach chosen:** extracted `specialistOptions()` from `makeRunSpecialist` (zero direct.ts changes needed — the two option pipelines are already identical in structure).

`src/agents/runner.ts`: Added exported pure function `specialistOptions(role, roleName, canonical, opts, store)` that runs the three-step kernel: `roleQueryOptions → packRunOptions(pack?) → withEffectiveTools`. `makeRunSpecialist` now calls `specialistOptions` directly.

`test/hand-off.test.ts` — two parity tests:
1. **All-agents parity** — for every agent: Path A replicates `direct.ts handle()` option assembly (`roleQueryOptions → packRunOptions(pack?) → withEffectiveTools`), Path B calls `specialistOptions(...)`. Sorted `allowedTools` must match.
2. **Deny-row test** — inserts `setRolePermission(name, tool, 0, "test")` into the in-memory store; asserts BOTH paths drop the revoked tool and remain equal to each other.

**RED/GREEN evidence:**

RED (pack drop in Path B — `const withPack = baseOptions` instead of `opts.pack ? packRunOptions(...) : baseOptions`):
```
Expected (Path A has pack tools):  ["Glob", "Grep", "Read", "mcp__aios-pack__recall", "mcp__aios-pack__vault_read", "mcp__aios-pack__vault_write", "mcp__code__sh"]
Received (Path B missing them):    ["Glob", "Grep", "Read", "mcp__code__sh"]
→ 1 test failed, 3 passed
```

GREEN (restored): 4 tests passed.

### Finding 2 (Important) — server.ts sentinel mismatch

`src/web/server.ts`: Exported `isChiefOfStaff(target?: string): boolean` → `!target || target === "moderator" || target === "rami"`. Used in both `/api/chat` and `/api/voice` endpoints replacing the bare `!== "moderator"` guard. Now target="rami" from any UI build routes correctly to the Moderator; legacy target="moderator" is accepted in the transition window.

`test/router-gate.test.ts`: Added 4 unit tests for `isChiefOfStaff` in a new describe block (`"isChiefOfStaff predicate (web sentinel)"`).

### Finding 3 (Minor) — stub rename

`test/router-gate.test.ts`: Renamed stub return string `"moderator-reply"` → `"rami-reply"` and updated the expectation (`expect(reply?.text).toBe("rami-reply")`). Trivially aligned with current role name; two-line change with no assertion churn.
