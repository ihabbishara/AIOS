import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

function today(): string {
  return new Date().toISOString().slice(0, 10);
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
    for (const dir of ["jobs", "knowledge", "daily", "notes"]) {
      mkdirSync(join(this.root, dir), { recursive: true });
    }
  }

  jobDirName(slug: string): string {
    return `${today()}-${slug}`;
  }

  jobDir(jobDirName: string): string {
    const dir = join(this.root, "jobs", jobDirName);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  writeJobArtifact(
    jobDirName: string,
    fileName: string,
    content: string,
    frontmatter: Record<string, string | number | boolean> = {},
  ): string {
    const dir = this.jobDir(jobDirName);
    const fm = Object.entries({ created: new Date().toISOString(), ...frontmatter })
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
    const path = join(dir, fileName);
    writeFileSync(path, `---\n${fm}\n---\n\n${content}\n`);
    return path;
  }

  readJobArtifact(jobDirName: string, fileName: string): string | undefined {
    const path = join(this.root, "jobs", jobDirName, fileName);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  writeNote(relPath: string, content: string): string {
    const path = join(this.root, relPath.endsWith(".md") ? relPath : `${relPath}.md`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  /** Copy an external file into the vault (e.g. invoice evidence). Returns the absolute path. */
  storeFile(relDir: string, fileName: string, srcPath: string): string {
    const dir = join(this.root, relDir);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, fileName);
    copyFileSync(srcPath, dest);
    return dest;
  }

  /** Write any file (no .md coercion) — e.g. CSV exports. Returns the absolute path. */
  writeFile(relPath: string, content: string): string {
    const path = join(this.root, relPath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  readNote(relPath: string): string | undefined {
    const path = join(this.root, relPath.endsWith(".md") ? relPath : `${relPath}.md`);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  listNotes(relDir = ""): string[] {
    const dir = join(this.root, relDir);
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
    const path = join(this.root, "daily", `${today()}.md`);
    mkdirSync(join(this.root, "daily"), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, `# ${today()}\n\n`);
    appendFileSync(path, `- ${new Date().toISOString().slice(11, 16)} ${line}\n`);
  }
}
