# Capture recall tuning

**Date:** 2026-07-21
**Status:** Approved
**Cycle:** ⑤

## Problem

The post-turn extractor (`src/memory/capture.ts`, `EXTRACT_SYSTEM`, haiku one-shot) captured 8 teachings across ~247 chat exchanges (~3%). Verified healthy in cycle ③ but doubly conservative:

- **USER-stated-only rule** — facts the assistant surfaced and the user confirmed are never captured (the biggest recall hole).
- **"Almost every exchange has NOTHING durable: default to []"** — a skepticism prior that suppresses borderline durable items.
- Meanwhile precision already leaks: teaching #8 "Media surfacing is live on Telegram" is AIOS dev-state, not a durable personal fact — the noise class is real and unaddressed by the current prompt.

Posture decision (user): **wider net + explicit excludes** — more recall AND a precision guard, not max-recall-forget-later.

## Design

### 1. Prompt rewrite — `EXTRACT_SYSTEM` only, mechanics untouched

The new system prompt keeps the JSON contract (`{"text","kind","domain"}`, kind `preference|fact`, domain `inbox|money|code|research|lifeops|general` or null) and changes the capture rules:

- **Capture**: durable facts and preferences about the user and their world that the user **stated or confirmed** in the exchange. Assistant-surfaced information counts when the user acknowledges or acts on it.
- **Categories named in the prompt**: people and relationships; recurring obligations and deadlines; stable preferences and constraints; places; ongoing personal projects.
- **Excludes named in the prompt**: AIOS/system/development state and feature status; transient task outcomes ("deployed", "fixed", "done today"); content quoted from emails, calendar invites, web pages, or tool/recall output (untrusted); speculation the user did not confirm.
- **Prior**: "Most exchanges yield 0–2 items; return [] when nothing qualifies" (replaces the always-empty default).
- KNOWN-list skip rule stays verbatim.

`extractLLM` mechanics, `captureTurn` dedup/routing, fail-silent behavior, single-exchange window: unchanged.

### 2. Eval harness — `scripts/eval-capture.ts` (manual gate, not vitest)

LLM-dependent, so it never enters the suite. Run manually with subscription auth, like other scripts.

- **Fixtures**: ~20 labeled cases in `scripts/fixtures/capture-eval.json`: `{ name, userText, replyText, expect: string[], reject: string[] }` — `expect` = lowercase substrings that must appear in some captured text; `reject` = substrings that must NOT appear in any captured text.
  - Recall cases: assistant-surfaced fact + user confirmation; deadline/obligation statements; family/people facts; preference statements phrased indirectly.
  - Noise traps: AIOS dev-state chatter (the #8 class); transient task status; small-talk.
  - Injection traps: exchange containing quoted email/web text with fact-shaped content — must not be captured.
- **Runner**: imports the real `extractLLM`, runs each fixture, prints per-case PASS/FAIL with captured texts, then aggregate counts (expect-hits / expect-total, reject-violations). `--model <id>` flag to compare haiku vs sonnet. `--old` flag runs the pre-change prompt (kept as a constant in the script) for side-by-side numbers.
- **Gate**: new prompt strictly ≥ old on expect-hits, zero reject-violations, at haiku. Sonnet considered only if haiku demonstrably fails the gate.

### 3. Ship

Prompt goes live on daemon restart (normal build + kickstart deploy). Suite unchanged — existing capture tests mock `extract` and pin mechanics, which this cycle does not touch.

## Not doing (YAGNI)

- Multi-turn context window for the extractor (single exchange stays; no cross-turn fixtures this cycle).
- Confidence thresholds or model-side scoring.
- Extractor model upgrade by default — data from the eval decides, and only with user sign-off.
- Distill/ground pipeline changes; forgetNow tooling changes.
- Automated eval in CI — the eval is a manual pre-ship gate.
