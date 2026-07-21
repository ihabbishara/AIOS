# Re-hire retired agents

**Date:** 2026-07-21
**Status:** Approved
**Cycle:** ⑦b (deferred from ② hire/fire)

## Problem

Retire (cycle ②) archives an agent's manifest to `agents/_retired/<name>.yaml` (flat, department preserved inside the yaml) and the loader's `_`-prefix skip keeps the archive inert. There is no way back except hand-moving the file and restarting. The Staff UI shows no trace of retired agents.

## Design

### Builders (`src/web/agents-admin.ts` — pure, tested)

- `listRetired(archiveDir: string): Array<{ name: string; department?: string; kind?: string; title?: string; error?: string }>` — reads `agents/_retired/*.yaml`, parses each with `agentSchema`; a file that fails to parse yields `{ name, error }` instead of throwing (the list endpoint never 500s on one bad file). Missing/empty dir → `[]`.
- `validateRehire(name: string, archiveDir: string, registry: LoadedRegistry): { ok: true; manifest: HireBody; from: string; to: string } | { ok: false; status: number; error: string }`
  - 404 when `agents/_retired/<name>.yaml` is absent; 400 when the yaml fails `agentSchema`.
  - Runs the parsed manifest through the existing `validateHire` (reuse, not duplication) — this brings name/alias collision, department-exists, kind, caps-known, and **dept-wall** checks for free. A retired life agent holding `vault-write` is correctly rejected today even if it was legal when retired.
  - On success returns the archive path (`from`) and the restore path `agents/<department>/<name>.yaml` (`to`).

### Route (`src/web/server.ts` — thin, untested, mirrors retire)

- `GET /api/agents/retired` → `listRetired(join(config.agentsDir, "_retired"))`.
- `POST /api/agents/<name>/rehire` → `validateRehire`; on ok: `renameSync(from, to)`, then `reloadPacks()` inside try/catch — on throw, `renameSync(to, from)` compensates (roster must stay reloadable, same never-brick pattern as retire) and 500s. On success: `buildAgentProfile` of the re-hired agent (same response shape as hire).
- **Move, not re-render**: the archived yaml is restored byte-identical. `renderAgentYaml` would drop fields the hire form doesn't know (maxTurns, permissionMode overrides, aliases, hand edits). Validation reads the parsed manifest; the file itself just moves.

### UI (ui2 Staff org view)

- Collapsed "Retired" section below the department roster: rows (name, title, dept) + a Rehire button per row. Errors (400/404/409/500) surface the response `error` body inline, same pattern as retire's TwoStepButton. Section renders only when `GET /api/agents/retired` returns a non-empty list.

### Tests (root `test/`, vitest — builders only)

- `listRetired`: missing dir → []; valid archive parsed; unparseable file → `{name, error}` entry alongside good ones.
- `validateRehire`: absent name → 404; name collision (agent with same name hired since) → 400 with collision error; wall violation in archived manifest (life + vault-write) → 400 wall error; happy path returns correct from/to paths.
- Route wiring untested per project constraint. Live proof at ship: hire a throwaway → retire it → shows in retired list → rehire → chats → retire again + delete archive file (cleanup).

## Not doing (YAGNI)

- Retire history/versioning (one archived yaml per name; a re-retire overwrites).
- Bulk rehire; editing the archived manifest before rehire (hand-edit the file instead).
- Purge/delete-forever endpoint.
