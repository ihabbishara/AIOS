// src/kernel/secrets.ts — THE single secret denylist. Three consumers:
// paths.ts isSecretPath (path guard), exec.ts sandboxProfile (SBPL), exec.ts
// jailEnv (child env). Change secrets policy HERE and nowhere else.

/** Path-form denylist (moved verbatim from code/paths.ts). */
export const SECRET_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.config(\/|$)/,
  /(^|\/)projects\/AIOS(\/|$)/,
  /\.env(\.[^/]+)?$/,
  /(token|credential|secret)/i,
];

/** SBPL deny lines (moved verbatim from code/exec.ts). Superset of the path
 *  patterns plus credential stores a shell could `cat` by absolute path. */
export function sbplSecretDenyLines(): string[] {
  return [
    '(deny file-read* (regex #"/\\.ssh/") (regex #"/\\.aws/") (regex #"/\\.gnupg/") (regex #"/\\.config/"))',
    '(deny file-read* (regex #"/projects/AIOS/") (regex #"\\.env($|\\.)") (regex #"(token|credential|secret)"))',
    '(deny file-read* (regex #"/\\.npmrc$") (regex #"/\\.netrc$") (regex #"/\\.docker/") (regex #"/\\.kube/") (regex #"/Library/Keychains/"))',
  ];
}

/** Env vars allowed into the sandbox child (moved verbatim from exec.ts jailEnv KEEP). */
export const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL", "TZ"];
