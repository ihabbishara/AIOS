// src/web/env-file.ts — .env upsert shared by the config PUT and the onboarding auth step.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export function updateEnvFile(envPath: string, key: string, value: string): void {
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n") : [];
  // A file ending in "\n" splits to a trailing "" — appending past it would leave a blank line.
  while (lines[lines.length - 1] === "") lines.pop();
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(envPath, lines.join("\n").replace(/\n*$/, "\n"));
}
