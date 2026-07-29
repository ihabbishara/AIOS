# Vault reads any file — literal-then-.md read, extension-aware write

**Date:** 2026-07-29
**Status:** approved design, pre-plan

## Context

`VaultWriter.readNote` (src/vault/writer.ts:112) appends `.md` to any path not already
ending in `.md`, and `writeNote` (:85) coerces the same way. Non-markdown artifacts are
therefore write-impossible and read-invisible through the vault tools: goal f83d56cf's
`deck.html` (84KB) had to be delivered by human `cp`, and its verification nodes could not
attest the file existed — `vault_read("…/deck.html")` looked for `deck.html.md`.

## Decisions (user-confirmed)

- **Read = literal-then-.md fallback:** try the exact path first; if absent and the path
  does not end in `.md`, retry with `.md` appended. `deck.html` exact-hits, `plan` →
  `plan.md` keeps working, and even an extensionless literal file is readable.
- **Write = extension-aware:** append `.md` only when the basename (last `/` segment)
  contains no dot. `writeNote("goals/x/deck.html")` and `writeNote("report.v2")` write
  literally; `writeNote("notes/plan")` still becomes `notes/plan.md`. A dot in a directory
  name (`notes/v1.2/plan`) does not suppress coercion — only the basename counts.
- `listNotes` stays `.md`-only: the memory indexer walks it, and HTML/CSV in listings would
  pollute second-brain recall. Artifact reads are by known name from goal context.

## Changes

1. `src/vault/writer.ts` `readNote`: containment-check and probe the literal path; on miss,
   if `!relPath.endsWith(".md")`, probe `${relPath}.md`. Both candidates go through
   `assertContained`. Returns `undefined` when neither exists.
2. `src/vault/writer.ts` `writeNote`: coerce to `.md` only when
   `!relPath.split("/").pop()!.includes(".")`.
3. Tool copy: `src/packs/server.ts` vault_read ("Read a markdown note…") and vault_write
   ("Write a markdown note…") become "…a file (markdown by default)…"; same wording update
   for the moderator's vault_read (src/moderator/tools.ts:291) and vault_write (:272).

## Untouched

`listNotes`, `writeGoalArtifact`/`readGoalArtifact` (already literal), the vault.write
executor (calls writeNote, inherits the new rule), memory indexer, no new tools, no binary
handling (readFileSync utf8 — a .png read returns mojibake, the agent's problem).

## Testing

`test/vault-writer.test.ts` additions: literal `.html` round-trip (`writeFile` then
`readNote("….html")`); bare name still falls back to `.md`; exact `.md` read unchanged;
`writeNote("x/report.v2")` writes literally while `writeNote("plan")` coerces;
`readNote("../escape.html")` still throws. Suite baseline 197 files / 1533 pass + 2 skip
holds; both tsc clean.
