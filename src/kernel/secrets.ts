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
  // Anchored to a secret-looking FILENAME, not any path containing the word: the old
  // unanchored form denied node_modules/.../tokenize.js and src/kernel/secrets.ts,
  // breaking ordinary builds inside the sandbox (spec 2026-07-25).
  /(^|\/)[\w.-]*(token|credential|secret)s?(\.(json|ya?ml|txt|pem|key|ini|conf|env))?$/i,
];

/** SBPL deny lines (moved verbatim from code/exec.ts). Superset of the path
 *  patterns plus credential stores a shell could `cat` by absolute path. */
export function sbplSecretDenyLines(): string[] {
  return [
    '(deny file-read* (regex #"/\\.ssh/") (regex #"/\\.aws/") (regex #"/\\.gnupg/") (regex #"/\\.config/"))',
    // NOTE: SBPL's regex flavour needs `-` FIRST inside a bracket ([-a-z] not [a-z-]) and
    // rejects \w there; it is case-insensitive by default. Keep this equivalent to the JS
    // pattern above — the two guard the same files from different sides.
    '(deny file-read* (regex #"/projects/AIOS/") (regex #"\\.env($|\\.)") (regex #"(^|/)[-a-zA-Z0-9_.]*(token|credential|secret)s?(\\.(json|ya?ml|txt|pem|key|ini|conf|env))?$"))',
    '(deny file-read* (regex #"/\\.npmrc$") (regex #"/\\.netrc$") (regex #"/\\.docker/") (regex #"/\\.kube/") (regex #"/Library/Keychains/"))',
  ];
}

/** Env vars allowed into the sandbox child (moved verbatim from exec.ts jailEnv KEEP). */
export const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL", "TZ"];
