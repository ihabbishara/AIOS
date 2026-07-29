# Vault Reads Any File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `vault_read` reaches non-markdown artifacts (deck.html) via literal-then-.md read, and `vault_write` writes extension-carrying names literally.

**Architecture:** Two-method change in `VaultWriter` (readNote probes literal path then `.md` fallback; writeNote coerces to `.md` only when the basename has no dot) plus tool-description copy updates in the pack and moderator servers. Nothing else moves.

**Tech Stack:** TypeScript, node:fs, vitest.

## Global Constraints

- Trunk-based, explicit `git add <paths>` only; `agents/_retired/` stays untracked.
- Suite baseline 197 files / 1533 pass + 2 skip; both roots `npx tsc --noEmit` clean.
- `listNotes` stays `.md`-only (memory indexer walks it); `writeGoalArtifact`/`readGoalArtifact` untouched.

---

### Task 1: readNote literal-then-.md + writeNote extension-aware

**Files:**
- Modify: `src/vault/writer.ts:84-90` (writeNote), `:111-115` (readNote)
- Test: `test/vault-writer.test.ts`

**Interfaces:**
- Produces: `readNote(relPath)` returns literal file content when the exact path exists, else the `.md`-appended variant, else `undefined`. `writeNote(relPath, content)` appends `.md` only when `relPath`'s basename contains no dot. Signatures unchanged.

- [ ] **Step 1: Write the failing tests** — append to `test/vault-writer.test.ts`:

```ts
describe("non-markdown vault files (vault-read-files spec)", () => {
  it("readNote reaches a literal .html file and still falls back to .md for bare names", () => {
    const w = tmpVault();
    w.writeFile("goals/x/deck.html", "<html>deck</html>");
    expect(w.readNote("goals/x/deck.html")).toBe("<html>deck</html>");
    w.writeNote("notes/plan", "# plan");
    expect(w.readNote("notes/plan")).toBe("# plan"); // bare name → plan.md fallback
    expect(w.readNote("notes/plan.md")).toBe("# plan"); // exact .md unchanged
    expect(w.readNote("goals/x/missing.html")).toBeUndefined();
  });

  it("writeNote keeps dotted basenames literal but still coerces bare names", () => {
    const w = tmpVault();
    const dotted = w.writeNote("notes/report.v2", "data");
    expect(dotted.endsWith("report.v2")).toBe(true);
    expect(w.readNote("notes/report.v2")).toBe("data");
    const bare = w.writeNote("notes/v1.2/plan", "p"); // dot in DIR must not suppress coercion
    expect(bare.endsWith("plan.md")).toBe(true);
  });

  it("traversal is still blocked for extension paths", () => {
    const w = tmpVault();
    expect(() => w.readNote("../escape.html")).toThrow(/escapes vault/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/vault-writer.test.ts`
Expected: FAIL — `readNote("goals/x/deck.html")` returns `undefined` (probed `deck.html.md`), and `writeNote("notes/report.v2")` path ends `report.v2.md`.

- [ ] **Step 3: Implement** — in `src/vault/writer.ts` replace the two methods:

```ts
  writeNote(relPath: string, content: string): string {
    // Coerce to .md only when the basename is extensionless — deck.html / report.v2 write
    // literally; a dot in a directory name (notes/v1.2/plan) does not count (spec §write).
    const literal = relPath.split("/").pop()!.includes(".");
    const path = join(this.root, literal ? relPath : `${relPath}.md`);
    this.assertContained(resolve(path), relPath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    return path;
  }
```

```ts
  readNote(relPath: string): string | undefined {
    // Literal-then-.md (spec §read): the exact path wins; bare names keep their .md sugar.
    const exact = join(this.root, relPath);
    this.assertContained(resolve(exact), relPath);
    if (existsSync(exact)) return readFileSync(exact, "utf8");
    if (relPath.endsWith(".md")) return undefined;
    const md = join(this.root, `${relPath}.md`);
    this.assertContained(resolve(md), relPath);
    return existsSync(md) ? readFileSync(md, "utf8") : undefined;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/vault-writer.test.ts`
Expected: PASS all.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/vault/writer.ts test/vault-writer.test.ts
git commit -m "feat(vault): reads reach non-markdown files, writes keep dotted names literal"
```

---

### Task 2: Tool copy — "markdown note" → "file (markdown by default)"

**Files:**
- Modify: `src/packs/server.ts:84,91`, `src/moderator/tools.ts:272,291`

**Interfaces:**
- Consumes: Task 1's behavior; copy-only change.

- [ ] **Step 1: Update descriptions** — `src/packs/server.ts`:

```ts
    "Read a file from the vault (markdown by default; extensions like .html/.csv read literally; path relative to the AIOS folder).",
```

```ts
    "Write a file to the vault (markdown by default; dotted names like deck.html write literally; audited through the Action Gate).",
```

`src/moderator/tools.ts:272` (vault_write description head) — replace `"Write a markdown note to the Obsidian vault (audited through the action gate). "` with:

```ts
    "Write a file to the Obsidian vault (markdown by default; dotted names write literally; audited through the action gate). " +
```

`src/moderator/tools.ts:291`:

```ts
    "Read a file from the vault (markdown by default; extensions like .html read literally; path relative to AIOS folder, e.g. jobs/2026-06-11-foo/design.md).",
```

- [ ] **Step 2: Verify + commit**

Run: `npx tsc --noEmit` → clean. Any test asserting the old copy: `grep -rn "markdown note" test/` → update only if a literal-string assertion breaks (`npx vitest run` decides).

```bash
git add src/packs/server.ts src/moderator/tools.ts
git commit -m "docs(tools): vault read/write descriptions cover non-markdown files"
```

---

### Task 3: Full verification + deploy

- [ ] **Step 1:** `npx vitest run` → ≥ 1536 passed + 2 skipped, 197 files. `npx tsc --noEmit` + `(cd ui2 && npx tsc --noEmit)` clean.
- [ ] **Step 2:** `npm run build && launchctl kickstart -k gui/501/com.ihab.aios` (no ui2 changes). Live probe: `TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)`; ask neo via chat or use sqlite to confirm daemon up via `/api/health`; then verify the real artifact: `curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" http://127.0.0.1:4280/api/chat -d '{"target":"","text":"vault_read goals/2026-07-26-investor-deck-algeria-eu-export-intermediary/deck.html and report the first 100 characters"}'` — expect the HTML head, not "Not found".
- [ ] **Step 3:** `git push`.
