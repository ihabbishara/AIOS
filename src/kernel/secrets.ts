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
  // A secret STORE is a dotfile or carries a data extension — "named like a secret" alone is
  // not enough. Substring matching denied tokenize.js; matching any name ending in the word
  // denied real npm packages (jsonwebtoken, js-tokens, gtoken, @anthropic-ai/sdk/lib/credentials)
  // and broke `npm install` inside the sandbox. Both regressions are pinned in tests.
  /(^|\/)(\.[\w.-]*(token|credential|secret)s?|[\w.-]*(token|credential|secret)s?\.(json|ya?ml|txt|pem|key|ini|conf|env))$/i,
];

/** SBPL deny lines (moved verbatim from code/exec.ts). Superset of the path
 *  patterns plus credential stores a shell could `cat` by absolute path. */
export function sbplSecretDenyLines(): string[] {
  return [
    '(deny file-read* (regex #"/\\.ssh/") (regex #"/\\.aws/") (regex #"/\\.gnupg/") (regex #"/\\.config/"))',
    // NOTE: SBPL's regex flavour needs `-` FIRST inside a bracket ([-a-z] not [a-z-]) and
    // rejects \w there; it is case-insensitive by default. Keep this equivalent to the JS
    // pattern above — the two guard the same files from different sides.
    '(deny file-read* (regex #"/projects/AIOS/") (regex #"\\.env($|\\.)") (regex #"(^|/)(\\.[-a-zA-Z0-9_.]*(token|credential|secret)s?|[-a-zA-Z0-9_.]*(token|credential|secret)s?\\.(json|ya?ml|txt|pem|key|ini|conf|env))$"))',
    '(deny file-read* (regex #"/\\.npmrc$") (regex #"/\\.netrc$") (regex #"/\\.docker/") (regex #"/\\.kube/") (regex #"/Library/Keychains/"))',
  ];
}

/** Env vars allowed into the sandbox child (moved verbatim from exec.ts jailEnv KEEP). */
export const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL", "TZ"];
