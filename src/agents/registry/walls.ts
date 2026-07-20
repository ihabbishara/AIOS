// src/agents/registry/walls.ts — per-department privacy walls (spec 2026-07-20).
// Single source of truth: validateHire enforces at hire time, lifeops-privacy pins at test time.

export interface DeptWall {
  /** Exact fully-qualified tool names this department's agents may never carry. */
  bannedTools: string[];
  /** Pattern ban applied to every fully-qualified tool name. */
  bannedToolPattern?: RegExp;
}

export const DEPT_WALLS: Record<string, DeptWall> = {
  life: {
    bannedTools: ["mcp__aios-pack__vault_write", "mcp__aios-pack__propose_action"],
    bannedToolPattern: /propose|gate|email|git|calendar/i,
  },
};

/** Offending tools for this department, [] when unwalled or clean. */
export function deptWallViolations(dept: string, tools: string[]): string[] {
  const wall = DEPT_WALLS[dept];
  if (!wall) return [];
  return tools.filter(
    (t) => wall.bannedTools.includes(t) || (wall.bannedToolPattern?.test(t) ?? false),
  );
}
