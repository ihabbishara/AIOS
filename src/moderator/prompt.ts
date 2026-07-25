// src/moderator/prompt.ts — GENERATED blocks only. The static Chief-of-Staff prompt lives in
// agents/operations/neo.yaml (org-model spec §5); these blocks are appended at session build.
export type RosterEntry = { name: string; title: string; charter: string; department: string };

function firstSentence(text: string): string {
  return text.trim().split(/(?<=\.)\s/)[0];
}

function buildTeamBlock(roster: RosterEntry[]): string {
  if (!roster.length) return "";
  const byDept = new Map<string, RosterEntry[]>();
  for (const a of roster) {
    const arr = byDept.get(a.department) ?? [];
    arr.push(a);
    byDept.set(a.department, arr);
  }
  const lines = [...byDept.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dept, agents]) => {
      const members = agents
        .map((a) => `${a.name} (${a.title}) — ${firstSentence(a.charter)}`)
        .join("; ");
      return `**${dept}**: ${members}`;
    });
  return `## Your team\n${lines.join("\n")}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Wall-clock context, prepended to each user message (same seam as the attachment block).
 *
 * NOT a system-prompt section, deliberately: the SDK does not re-apply systemPrompt when it
 * RESUMES a session, so a clock rendered there freezes at session-creation time and then
 * contradicts reality — live-observed, neo anchored on a two-hour-old "last time" and refused
 * a relative reminder. The per-turn line is the only channel that reaches a resumed session,
 * and being the sole source of "now" it cannot disagree with a stale copy.
 */
export function nowLine(now: Date): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offMin = -now.getTimezoneOffset();
  const offset = `${offMin < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}`;
  return `[Current time: ${weekday} ${date} ${time} (${zone}, UTC${offset}) — use this as "now" to ` +
    `resolve relative times yourself ("in 2 minutes", "tonight", "tomorrow at 9") into the absolute ISO ` +
    `timestamp add_reminder needs or the hh:mm add_routine takes; never ask the user what time it is.]`;
}

/** Everything the YAML prompt cannot carry: live roster, playbook list, machine paths, memo.
 *  The clock is NOT here on purpose — see nowLine. */
export function moderatorBlocks(args: {
  playbooks: Array<{ name: string; description: string }>;
  projectsRoot: string;
  memoBlock?: string;
  roster?: RosterEntry[];
}): string {
  const teamBlock = buildTeamBlock(args.roster ?? []);
  return `${teamBlock}

## Available playbooks
${args.playbooks.map((p) => `- ${p.name}: ${p.description}`).join("\n")}

Playbooks are organized into pillars (money, code, research, lifeops, …). When you run a \
pillar playbook, its specialist automatically gets that pillar's persona, preferences, and \
tools — just pick the right playbook with run_playbook.

## Project directories
Before starting a software job, make sure you know the target project directory (must be under \
${args.projectsRoot}). Ask if unclear. New projects: propose a new directory under ${args.projectsRoot}.${
    args.memoBlock ? `\n\n${args.memoBlock}` : ""}`;
}
