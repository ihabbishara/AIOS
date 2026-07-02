import { join } from "node:path";
import { loadRegistry } from "../../src/agents/registry/loader.js";
import { buildExtras } from "../../src/agents/registry/extras.js";

export function testRegistry() {
  return loadRegistry(
    join(process.cwd(), "agents"),
    join(process.cwd(), "playbooks"),
    buildExtras({ vaultPath: "/tmp/v", vaultSubdir: "AIOS", financeCompany: "IDAMA", financeMembers: [{ name: "Ihab" }] }),
  );
}
