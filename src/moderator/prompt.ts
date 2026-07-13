// src/moderator/prompt.ts — GENERATED blocks only. The static Chief-of-Staff prompt lives in
// agents/operations/hermes.yaml (org-model spec §5); these blocks are appended at session build.
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

/** Everything the YAML prompt cannot carry: live roster, playbook list, machine paths, memo. */
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
