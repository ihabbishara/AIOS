import { join } from "node:path";
import { loadRegistry } from "../../src/agents/registry/loader.js";
import { buildExtras } from "../../src/agents/registry/extras.js";
import type { RoleDef } from "../../src/agents/roles/index.js";

export function testRegistry() {
  return loadRegistry(
    join(process.cwd(), "agents"),
    join(process.cwd(), "playbooks"),
    buildExtras({ vaultPath: "/tmp/v", vaultSubdir: "AIOS", financeCompany: "IDAMA", financeMembers: [{ name: "Ihab" }] }),
  );
}

let cached: ReturnType<typeof testRegistry> | null = null;

/** Compiled-from-YAML role lookup by canonical name OR legacy alias (cfo → midas, etc.).
 *  Replaces the deleted legacy `roles` map as the tests' oracle — pins production truth. */
export function roleOf(nameOrAlias: string): RoleDef {
  cached ??= testRegistry();
  const name = cached.agentOf.get(nameOrAlias) ?? nameOrAlias;
  const agent = cached.agents.get(name);
  if (!agent) throw new Error(`roleOf: no agent for "${nameOrAlias}"`);
  return agent.role;
}
