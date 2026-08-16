/**
 * One-shot smoke test against the RUNNING daemon. Usage:
 *   npx tsx scripts/smoke.ts "your message"
 *   npx tsx scripts/smoke.ts --target halalo "run one read-only check"
 *
 * It used to boot the whole stack itself, but that wiring rotted: it built a JobManager from
 * src/engine/jobs.ts, which no longer exists, so the script had been unrunnable since the goal
 * engine replaced it — importing a module deleted from the source tree. Rebuilding it would mean
 * duplicating boot.ts, and `npm run dev` (--cli) already covers "boot a stack and talk to it".
 *
 * So this is the other useful thing instead, and the one that was missing: prove a DEPLOYED daemon
 * actually answers — the check you want after a restart, when the question is whether the process
 * now serving is wired correctly.
 */
import "dotenv/config";
import { loadConfig } from "../src/config.js";

const argv = process.argv.slice(2);
const t = argv.indexOf("--target");
const target = t === -1 ? "" : (argv[t + 1] ?? "");
if (t !== -1) argv.splice(t, 2);
const text = argv.join(" ") || "Say hello and tell me which playbooks you have.";

const config = loadConfig();
const token = process.env.AIOS_UI_TOKEN;
if (!token) {
  console.error("AIOS_UI_TOKEN is not set — the daemon's API is token-gated. Check .env.");
  process.exit(1);
}

const base = `http://127.0.0.1:${config.uiPort}`;
console.log(`> ${target ? `@${target} ` : ""}${text}`);

const res = await fetch(`${base}/api/chat`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ target, text }),
}).catch((err: unknown) => {
  // The most common failure by far is "no daemon", and a bare ECONNREFUSED does not say so.
  console.error(`could not reach the daemon at ${base} — is it running? (${(err as Error).message})`);
  process.exit(1);
});

if (!res.ok) {
  console.error(`daemon answered ${res.status}: ${(await res.text()).slice(0, 500)}`);
  process.exit(1);
}

const body = (await res.json()) as { reply: string | null; attachments?: Array<{ url?: string }> };
console.log(`\n--- reply ---\n${body.reply ?? "(no reply)"}`);
if (body.attachments?.length) console.log(`\n[${body.attachments.length} attachment(s)]`);
