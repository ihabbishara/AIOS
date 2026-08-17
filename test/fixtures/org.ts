// test/fixtures/org.ts — the org the suite asserts against.
//
// These tests used to load the repo's own `agents/` directory. That coupled them to one machine's
// live org: the counts moved when the operator hired, `registry-live-tree` carried a hand-written
// comment explaining why the number was 17 *that week*, and a failure could not distinguish "the
// product broke" from "someone hired an agent". It also meant `agents/` had to stay tracked in
// git, which is why a fresh clone booted into the operator's org instead of the setup wizard.
//
// So the org under test is committed here instead, and `agents/` becomes what it always should
// have been: user data. This is a snapshot of that org minus the clients department — a client's
// agent is one operator's, not product — carrying the PRODUCT capability catalogue from
// templates/, not the operator's copy.
//
// Playbooks are genuinely product data and stay tracked at the repo root, so they are shared.
import { join } from "node:path";

export const FIXTURE_AGENTS_DIR = join(import.meta.dirname, "org", "agents");
export const FIXTURE_PLAYBOOKS_DIR = join(import.meta.dirname, "..", "..", "playbooks");

/** What the fixture org contains, asserted in registry-live-tree so a silent edit is caught. */
export const FIXTURE_AGENT_COUNT = 16;
export const FIXTURE_DEPARTMENTS = ["engineering", "finance", "life", "operations", "research"];
