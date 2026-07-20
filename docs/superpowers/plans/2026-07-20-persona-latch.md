# Persona Latch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persona/contextFile/skills/mission edits invalidate live agent sessions; nightly memo re-renders never do.

**Architecture:** resolve.ts already builds the static prompt half (`base.systemPrompt` + pillar + mission) before appending the dynamic memo — expose it as `ResolvedAgent.personaSurface`, fold it plus `options.skills` into `surfaceHash` via an additive-optional second parameter, and pass it at both resume seams. The existing resume gate does the invalidation.

**Tech Stack:** TypeScript, vitest.

## Global Constraints

- No new npm deps. No new bus event types. No tool-surface change → **no golden regen**.
- `surfaceHash` second param MUST be optional — existing callers, tests, and the `vi.mock` of resumable.js stay source-compatible; all pre-existing session-surface tests stay green **unchanged**.
- The memo (and `moderatorBlocks`) must NEVER enter `personaSurface` — hermes-continuity guarantee.
- TDD: failing test → red → minimal impl → green → commit. Check the vitest "Tests" summary line, never a piped exit code.
- Commits end with the repo's Co-Authored-By + Claude-Session trailers.
- One-time fleet reset on deploy is EXPECTED (stored hashes predate the new payload fields).

---

## File Structure

- **Modify** `src/agents/resumable.ts` — `surfaceHash(options, personaSurface?)`, payload gains `persona` + `skills`.
- **Modify** `src/agents/resolve.ts` — build + return `personaSurface` (interface + return literal).
- **Modify** `src/moderator/session.ts:178`, `src/agents/direct.ts:142` — pass `resolved.personaSurface`.
- **Test** `test/session-surface.test.ts` — additive hash cases.
- **Test** `test/resolve-agent.test.ts` — memo-exclusion guarantee at the resolve level.

---

## Task 1: surfaceHash gains persona + skills

**Files:**
- Modify: `src/agents/resumable.ts:24-31`
- Test: `test/session-surface.test.ts`

**Interfaces:**
- Produces: `surfaceHash(options: Options, personaSurface?: string): string` — omitted param hashes `persona: null` (back-compat).

- [ ] **Step 1: Add failing tests** (append inside the existing `describe("surfaceHash")` in `test/session-surface.test.ts`; the file's `opts` helper is `const opts = (o: Partial<Options>): Options => o as Options;`)

```typescript
  it("personaSurface changes the hash; omitting it matches today's callers", () => {
    const base = opts({ allowedTools: ["A"], permissionMode: "dontAsk" });
    const h = surfaceHash(base);
    expect(surfaceHash(base, "persona v1")).not.toBe(h);
    expect(surfaceHash(base, "persona v1")).toBe(surfaceHash(base, "persona v1")); // stable
    expect(surfaceHash(base, "persona v2")).not.toBe(surfaceHash(base, "persona v1")); // edit invalidates
  });

  it("skills change the hash, order-insensitively", () => {
    const base = opts({ allowedTools: ["A"], permissionMode: "dontAsk" });
    const h = surfaceHash(opts({ ...base, skills: ["s1", "s2"] }), "p");
    expect(surfaceHash(opts({ ...base, skills: ["s2", "s1"] }), "p")).toBe(h);
    expect(surfaceHash(opts({ ...base, skills: ["s1"] }), "p")).not.toBe(h);
  });
```

- [ ] **Step 2: Run — expect the 2 new tests FAIL** (persona/skills currently ignored)

Run: `npx vitest run test/session-surface.test.ts`
Expected: 2 failed (new), all pre-existing pass.

- [ ] **Step 3: Implement** — replace `surfaceHash` in `src/agents/resumable.ts`:

```typescript
/** Hash of the resolved surface — tools + static persona scope (specs 2026-07-19 + 2026-07-20):
 *  a resumed session whose tool surface OR static persona changed must NOT resume. The dynamic
 *  memo/moderator blocks stay excluded — nightly re-renders never invalidate (hermes continuity). */
export function surfaceHash(options: Options, personaSurface?: string): string {
  const payload = JSON.stringify({
    tools: [...(options.allowedTools ?? [])].sort(),
    servers: Object.keys(options.mcpServers ?? {}).sort(),
    mode: options.permissionMode ?? null,
    persona: personaSurface ?? null,
    skills: [...(options.skills ?? [])].sort(),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
```

- [ ] **Step 4: Run — all green** (`npx vitest run test/session-surface.test.ts`; pre-existing "ignores systemPrompt and model" must still pass — options.systemPrompt stays unhashed)

- [ ] **Step 5: Commit**

```bash
git add src/agents/resumable.ts test/session-surface.test.ts
git commit -m "feat(sessions): surfaceHash folds in static personaSurface + skills

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Jbb7hWYN78tUtQAEvQ7LDL"
```

---

## Task 2: resolve exposes personaSurface (memo excluded)

**Files:**
- Modify: `src/agents/resolve.ts` (interface ~:44, assembly ~:186, return ~:252)
- Test: `test/resolve-agent.test.ts`

**Interfaces:**
- Consumes: existing `base.systemPrompt`, `dept.department`, `dept.mission`, `memo` locals at the assembly site.
- Produces: `ResolvedAgent.personaSurface: string` — static half only.

- [ ] **Step 1: Add failing test** (append to `describe("resolveAgent")` in `test/resolve-agent.test.ts`; harness: real registry + in-memory store, `setup()` returns `{ registry, store, resolve }`)

```typescript
  it("personaSurface = static half only: memo text reaches systemPrompt but NEVER personaSurface", () => {
    const { resolve, registry, store } = setup();
    // Pick any agent whose department declares a memoDomain; seed a pending teaching — it renders
    // into the memo block ("## Pending (not yet distilled)") via memoContextForDomain.
    const name = [...registry.agents.keys()].find((n) => {
      const def = registry.agents.get(n)!;
      return !!registry.departments.get(def.department)?.memoDomain;
    })!;
    const domain = registry.departments.get(registry.agents.get(name)!.department)!.memoDomain;
    store.addTeaching({ text: "DISTINCTIVE-MEMO-MARKER-9137", domain, kind: "preference", origin: "user-stated" });
    const r = resolve(name, origin)!;
    expect(r.options.systemPrompt).toContain("DISTINCTIVE-MEMO-MARKER-9137"); // memo IS in the prompt
    expect(r.personaSurface).not.toContain("DISTINCTIVE-MEMO-MARKER-9137");   // …but NOT in the hashable surface
    expect(r.personaSurface).toContain(`## Pillar: ${registry.agents.get(name)!.department}`);
    expect(r.options.systemPrompt).toContain(r.personaSurface.slice(0, 60)); // surface is a prefix slice of the real prompt
  });
```

- [ ] **Step 2: Run — expect FAIL** (`personaSurface` undefined)

Run: `npx vitest run test/resolve-agent.test.ts`

- [ ] **Step 3: Implement.** In `src/agents/resolve.ts`:

Interface (after `labels`):
```typescript
  /** Static prompt half — persona + contextFiles + pillar + mission, memo EXCLUDED. Seams feed
   *  this to surfaceHash so definition edits invalidate sessions but nightly memo churn never does. */
  personaSurface: string;
```

At the assembly site — `base` is built at :206; add directly after the existing `contextBlock` const (:186):
```typescript
    const personaSurfaceOf = (baseSystemPrompt: string) =>
      [baseSystemPrompt, `## Pillar: ${dept.department}`, dept.mission.trim()].filter(Boolean).join("\n\n");
```
…and since `base` exists only from :206, simplest correct placement: compute AFTER `base` (:206), before the return:
```typescript
    const personaSurface = [base.systemPrompt, `## Pillar: ${dept.department}`, dept.mission.trim()]
      .filter(Boolean).join("\n\n"); // memo deliberately excluded — the no-churn guarantee
```
(Use this single-const form; drop the helper. `base.systemPrompt` may be string-typed union — if tsc complains about `Options["systemPrompt"]` being non-string, coerce via `String(base.systemPrompt ?? "")`.)

Return literal (:252):
```typescript
    return { canonical, kind: def.kind, def, options, ceiling, labels, personaSurface };
```

- [ ] **Step 4: Run — green** (`npx vitest run test/resolve-agent.test.ts` + `npx tsc --noEmit`)

- [ ] **Step 5: Commit**

```bash
git add src/agents/resolve.ts test/resolve-agent.test.ts
git commit -m "feat(agents): ResolvedAgent.personaSurface — static prompt half, memo excluded

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Jbb7hWYN78tUtQAEvQ7LDL"
```

---

## Task 3: seams pass it; deploy + live smoke

**Files:**
- Modify: `src/moderator/session.ts:178`, `src/agents/direct.ts:142`

**Interfaces:**
- Consumes: `resolved.personaSurface` (Task 2), `surfaceHash(options, personaSurface?)` (Task 1).

- [ ] **Step 1: Wire both seams** (mechanical, one line each):

`src/moderator/session.ts:178`: `surfaceHash(finalOptions)` → `surfaceHash(finalOptions, resolved.personaSurface)`
`src/agents/direct.ts:142`: `surfaceHash(finalOptions)` → `surfaceHash(finalOptions, resolved.personaSurface)`

- [ ] **Step 2: Full suite + tsc both roots**

Run: `npx vitest run` then `npx tsc --noEmit` and `cd ui2 && npx tsc --noEmit`
Expected: suite ≥ current count, 0 failures (read the "Tests" line); tsc clean. If any test mocks resumable.js without a `personaSurface`-tolerant surfaceHash, the additive param means no change needed — investigate only if red.

- [ ] **Step 3: Commit**

```bash
git add src/moderator/session.ts src/agents/direct.ts
git commit -m "feat(sessions): both resume seams hash the static personaSurface

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Jbb7hWYN78tUtQAEvQ7LDL"
```

- [ ] **Step 4: Build + deploy**

```bash
npm run build && launchctl kickstart -k gui/501/com.ihab.aios && sleep 6
```
(ui2 untouched — no ui2 rebuild.) Expect one-time fleet reset: every session starts fresh on its first post-deploy turn (stored hashes predate the new fields). NOT a regression.

- [ ] **Step 5: Live smoke — continuity preserved (memo churn does not invalidate)**

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 120 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" http://localhost:4280/api/chat -d '{"target":"hermes","text":"Say A."}' >/dev/null
S1=$(sqlite3 data/aios.sqlite "SELECT value FROM kv WHERE key LIKE 'moderator-session:%web%' LIMIT 1;")
curl -s -m 120 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" http://localhost:4280/api/chat -d '{"target":"hermes","text":"Say B."}' >/dev/null
S2=$(sqlite3 data/aios.sqlite "SELECT value FROM kv WHERE key LIKE 'moderator-session:%web%' LIMIT 1;")
echo "S1=$S1"; echo "S2=$S2"; [ "$S1" = "$S2" ] && echo "CONTINUITY OK (resumed)" || echo "UNEXPECTED: session changed"
```
(Adjust the kv key pattern to the actual stored key if the LIKE misses — inspect with `SELECT key FROM kv WHERE key LIKE '%session%';`.)

- [ ] **Step 6: Live smoke — persona edit invalidates**

Hand-edit one persona line in a low-stakes agent's YAML (e.g. append a marker sentence to `agents/<name>.yaml`'s persona/systemPrompt field — hand-edit via Edit tool is allowed; only programmatic edits must splice). Then:

```bash
launchctl kickstart -k gui/501/com.ihab.aios && sleep 6   # registry reloads at boot
# direct turn to that agent, capture its session kv before/after — expect a NEW session id (fresh)
```
Assert the stored session id for that agent's direct chat changed / the turn started fresh. REVERT the YAML marker afterward and restart again.

- [ ] **Step 7: Final gate + push**

```bash
npx vitest run 2>&1 | grep -E "Tests |Test Files "
npx tsc --noEmit
git log --oneline origin/main..HEAD
git push origin main
```

---

## Self-Review

**Spec coverage:** personaSurface exposure (§1) → Task 2; hash extension (§2) → Task 1; seams (§3) → Task 3; one-time reset note → Task 3 Step 4; no-churn test (spec Testing) → Task 1 (hash level) + Task 2 (resolve level, the memo-marker test); resume-gate invalidation → existing resumeFor tests + Task 3 Step 6 live. ✅
**Placeholders:** none — every step has exact code/commands. ✅
**Type consistency:** `surfaceHash(options, personaSurface?)` matches between Task 1 impl, Task 3 call sites; `personaSurface: string` on the interface matches the return literal and the test's `r.personaSurface`. ✅
