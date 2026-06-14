import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadPlaybook, type Playbook } from "../engine/playbook.js";
import { packSchema, type Pack, type PackRegistry } from "./types.js";

export interface LoadedPacks extends PackRegistry {
  playbooks: Map<string, Playbook>;
}

/** Scans <dir>: top-level *.yaml = packless playbooks; each subdir with pack.yaml = a pack. */
export function loadPacks(dir: string, log: (line: string) => void = () => {}): LoadedPacks {
  const playbooks = new Map<string, Playbook>();
  const packs = new Map<string, Pack>();
  const pillarOf = new Map<string, string>();
  const roleCount = new Map<string, Set<string>>(); // role -> set of pillars

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      loadPackDir(full, entry, { playbooks, packs, pillarOf, roleCount }, log);
    } else if (entry.endsWith(".yaml") || entry.endsWith(".yml")) {
      try {
        const pb = loadPlaybook(full);
        playbooks.set(pb.name, pb);
      } catch (err) {
        log(`playbook ${entry} skipped: ${(err as Error).message}`);
      }
    }
  }

  const roleOf = new Map<string, string>();
  for (const [role, pillars] of roleCount) {
    if (pillars.size === 1) roleOf.set(role, [...pillars][0]);
  }
  return { playbooks, packs, pillarOf, roleOf };
}

function loadPackDir(
  dirPath: string,
  dirName: string,
  acc: { playbooks: Map<string, Playbook>; packs: Map<string, Pack>; pillarOf: Map<string, string>; roleCount: Map<string, Set<string>> },
  log: (line: string) => void,
): void {
  const manifestPath = join(dirPath, "pack.yaml");
  if (!existsSync(manifestPath)) return; // a plain subdir, not a pack
  let pack: Pack;
  try {
    pack = packSchema.parse(parse(readFileSync(manifestPath, "utf8")));
  } catch (err) {
    log(`pack ${dirName} skipped: invalid manifest — ${(err as Error).message}`);
    return;
  }
  if (acc.packs.has(pack.pillar)) {
    log(`pack ${dirName} skipped: duplicate pillar "${pack.pillar}"`);
    return;
  }
  const loaded: Playbook[] = [];
  for (const name of pack.playbooks) {
    const pbPath = join(dirPath, `${name}.yaml`);
    if (!existsSync(pbPath)) {
      log(`pack ${dirName} skipped: playbook file missing — ${name}.yaml`);
      return;
    }
    try {
      loaded.push(loadPlaybook(pbPath));
    } catch (err) {
      log(`pack ${dirName} skipped: playbook ${name} invalid — ${(err as Error).message}`);
      return;
    }
  }
  acc.packs.set(pack.pillar, pack);
  for (const pb of loaded) {
    acc.playbooks.set(pb.name, pb);
    acc.pillarOf.set(pb.name, pack.pillar);
  }
  for (const role of pack.roles) {
    const set = acc.roleCount.get(role) ?? new Set<string>();
    set.add(pack.pillar);
    acc.roleCount.set(role, set);
  }
}
