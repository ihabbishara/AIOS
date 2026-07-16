/**
 * One-time backfill of the daily-note gap the JobManager→GoalEngine migration (964e27a, 2026-07-03)
 * left behind. Reconstructs `daily/<date>.md` from goal rows for dates that have no file yet — never
 * appends to an existing file, so it is safe to re-run (a second run writes nothing).
 *   npx tsx scripts/backfill-daily.ts
 */
import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { buildBackfillDays } from "../src/vault/daily-log.js";

const SINCE = "2026-07-03"; // migration day — daily notes went silent here

const config = loadConfig();
const store = new Store(config.dbPath);
const vault = new VaultWriter(config.vaultPath, config.vaultSubdir);
const dailyDir = join(vault.root, "daily");
mkdirSync(dailyDir, { recursive: true });

const existingDates = new Set(
  readdirSync(dailyDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)),
);
const goals = store.listGoals(10_000).filter((g) => g.created_at >= SINCE);
const days = buildBackfillDays(goals, existingDates);

let written = 0;
for (const [date, lines] of days) {
  const path = join(dailyDir, `${date}.md`);
  if (existsSync(path)) continue; // belt-and-braces; buildBackfillDays already excluded these
  writeFileSync(path, `# ${date}\n\n${lines.join("\n")}\n`);
  written++;
}

console.log(`backfill-daily: ${written} file(s) written, ${existingDates.size} date(s) already present, ${goals.length} goal(s) scanned since ${SINCE}`);
