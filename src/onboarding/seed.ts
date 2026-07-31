// src/onboarding/seed.ts — the capability catalog is PRODUCT data, but the loader reads it from
// the user's agents dir. Provisioning a fresh install therefore has to plant a copy. Never
// overwrite: an existing catalog may carry the user's own capability edits.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const CAPABILITIES_FILE = "_capabilities.yaml";

export function seedCapabilities(agentsDir: string, templatesDir: string): boolean {
  const source = join(templatesDir, CAPABILITIES_FILE);
  if (!existsSync(source)) throw new Error(`capability catalog missing at ${source}`);
  mkdirSync(agentsDir, { recursive: true });
  const target = join(agentsDir, CAPABILITIES_FILE);
  if (existsSync(target)) return false;
  copyFileSync(source, target);
  return true;
}
