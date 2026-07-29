import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const p2 = (n: number) => String(n).padStart(2, "0");

/** LOCAL calendar date `YYYY-MM-DD`. Daily notes and goal dirs are the user's days, not UTC's —
 *  toISOString() (UTC) filed a 01:25-local entry into the previous day for any positive offset. */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** LOCAL wall-clock `HH:MM`. */
export function localHM(d: Date = new Date()): string {
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function today(): string {
  return localDate();
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "job";
}

export class VaultWriter {
  readonly root: string;

  constructor(vaultPath: string, subdir: string) {
    this.root = join(vaultPath, subdir);
  }

  init(): void {
    // `jobs/` retired with JobManager (goals/ is its successor) — no longer created.
    for (const dir of ["knowledge", "daily", "notes"]) {
      mkdirSync(join(this.root, dir), { recursive: true });
    }
  }

  /** Caller-supplied relative paths must resolve inside the vault — blocks `../` traversal. */
  private assertContained(absPath: string, relPath: string): void {
    const base = resolve(this.root);
    if (absPath !== base && !absPath.startsWith(base + sep)) {
      throw new Error(`path escapes vault: ${relPath}`);
    }
  }

  goalDirName(slug: string): string {
    return `${today()}-${slug}`;
  }

  private goalDir(goalDirName: string): string {
    const dir = join(this.root, "goals", goalDirName);
    this.assertContained(resolve(dir), goalDirName);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  writeGoalArtifact(
    goalDirName: string,
    fileName: string,
    content: string,
    frontmatter: Record<string, string | number | boolean> = {},
  ): string {
    const dir = this.goalDir(goalDirName);
    const fm = Object.entries({ created: new Date().toISOString(), ...frontmatter })
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
    const path = join(dir, fileName);
    this.assertContained(resolve(path), fileName);
    writeFileSync(path, `---\n${fm}\n---\n\n${content}\n`);
    return path;
  }

  readGoalArtifact(goalDirName: string, fileName: string): string | undefined {
    const path = join(this.root, "goals", goalDirName, fileName);
    this.assertContained(resolve(path), join(goalDirName, fileName));
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  writeNote(relPath: string, content: string): string {
    // Coerce to .md only when the basename is extensionless — deck.html / report.v2 write
    // literally; a dot in a directory name (notes/v1.2/plan) does not count (spec §write).
    const literal = relPath.split("/").pop()!.includes(".");
    const path = join(this.root, literal ? relPath : `${relPath}.md`);
    this.assertContained(resolve(path), relPath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  /** Copy an external file into the vault (e.g. invoice evidence). Returns the absolute path. */
  storeFile(relDir: string, fileName: string, srcPath: string): string {
    const dir = join(this.root, relDir);
    const dest = join(dir, fileName);
    this.assertContained(resolve(dest), join(relDir, fileName));
    mkdirSync(dir, { recursive: true });
    copyFileSync(srcPath, dest);
    return dest;
  }

  /** Write any file (no .md coercion) — e.g. CSV exports. Returns the absolute path. */
  writeFile(relPath: string, content: string): string {
    const path = join(this.root, relPath);
    this.assertContained(resolve(path), relPath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  readNote(relPath: string): string | undefined {
    // Literal-then-.md (spec §read): the exact path wins; bare names keep their .md sugar.
    const exact = join(this.root, relPath);
    this.assertContained(resolve(exact), relPath);
    if (existsSync(exact)) return readFileSync(exact, "utf8");
    if (relPath.endsWith(".md")) return undefined;
    const md = join(this.root, `${relPath}.md`);
    this.assertContained(resolve(md), relPath);
    return existsSync(md) ? readFileSync(md, "utf8") : undefined;
  }

  listNotes(relDir = ""): string[] {
    const dir = join(this.root, relDir);
    this.assertContained(resolve(dir), relDir);
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    const walk = (d: string, prefix: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(d, entry.name), `${prefix}${entry.name}/`);
        else if (entry.name.endsWith(".md")) out.push(`${prefix}${entry.name}`);
      }
    };
    walk(dir, relDir ? `${relDir}/` : "");
    return out;
  }

  appendDaily(line: string): void {
    const path = join(this.root, "daily", `${localDate()}.md`);
    mkdirSync(join(this.root, "daily"), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, `# ${localDate()}\n\n`);
    appendFileSync(path, `- ${localHM()} ${line}\n`);
  }
}
