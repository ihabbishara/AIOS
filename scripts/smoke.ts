/**
 * One-shot smoke test: boots the stack without channels, sends one message
 * to the moderator, prints the reply. Usage:
 *   npx tsx scripts/smoke.ts "your message"
 */
import { loadConfig, assertAuth } from "../src/config.js";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadPlaybooks } from "../src/engine/playbook.js";
import { JobManager } from "../src/engine/jobs.js";
import { runSpecialist } from "../src/agents/runner.js";
import { Moderator } from "../src/moderator/session.js";

const message = process.argv.slice(2).join(" ") || "Say hello and tell me which playbooks you have.";

const config = loadConfig();
assertAuth();
const store = new Store(config.dbPath);
const vault = new VaultWriter(config.vaultPath, config.vaultSubdir);
vault.init();
const playbooks = loadPlaybooks(config.playbooksDir);

let jobDone: ((v: void) => void) | undefined;
const jobFinished = new Promise<void>((r) => (jobDone = r));
let jobStarted = false;

const jobs = new JobManager({
  store,
  vault,
  run: runSpecialist,
  playbooks,
  wallTimeMs: config.jobWallTimeMs,
  maxConcurrent: 1,
  model: config.specialistModel,
  onComplete: async (outcome) => {
    console.log(`\n[job ${outcome.ok ? "done" : "FAILED"}] ${outcome.job.title} -> jobs/${outcome.jobDirName}/`);
    const report = await moderator.handle("cli", "smoke", outcome.ok
      ? `[JOB-COMPLETE] Job "${outcome.job.title}" finished. Artifacts: ${outcome.artifactFiles.join(", ")} under jobs/${outcome.jobDirName}/. Report to the user.`
      : `[JOB-FAILED] ${outcome.error}`);
    console.log(`\n--- job report ---\n${report}`);
    jobDone?.();
  },
  log: (l) => console.log(`  ${l}`),
});

const moderator = new Moderator({
  store,
  jobs,
  vault,
  projectsRoot: config.projectsRoot,
  model: config.moderatorModel,
  log: (l) => console.log(`  ${l}`),
});

console.log(`> ${message}`);
const reply = await moderator.handle("cli", "smoke", message);
console.log(`\n--- moderator reply ---\n${reply}`);

if (store.listJobs(1).some((j) => j.status === "queued" || j.status === "running")) {
  jobStarted = true;
  console.log("\n[waiting for background job to finish...]");
  await jobFinished;
}
store.close();
process.exit(0);
