# Releasing AIOS to npm

> **Not currently published.** The package was removed from the registry on 2026-09-04; AIOS is
> distributed by cloning this repo (see the README's Install section). Everything below still
> applies the day it goes back — every section is something that actually went wrong once — and
> the packaging itself is still exercised on every run by `test/publish-allowlist.test.ts`, which
> checks what `npm pack` really produces. Note that `0.1.0` and `0.1.1` are permanently claimed
> even though they are gone: unpublishing frees the bytes, never the version number.

Published as **[`@ihabbishara/aios`](https://www.npmjs.com/package/@ihabbishara/aios)** — a scoped
package, because both `aios` and `create-aios` were already taken on the public registry.

This is the runbook. Most of it exists because the first publish went wrong in ways that were not
obvious, and every section below is something that actually happened rather than something that
might.

## What ships, and why it is an allowlist

`package.json` carries a `files` allowlist, not an ignore list. That is deliberate: this repo has
contained a client's agent manifest and prompt, and an ignore list fails open — anything nobody
thought about ships. An allowlist fails closed.

```
dist/src/     compiled runtime           templates/    org templates + capability catalogue
ui2/dist/     cockpit AND setup wizard   launchd/      the plist template
playbooks/    the 7 stock playbooks      .env.example  setup reference
```

Three of those are load-bearing in non-obvious ways:

- **`ui2/dist/` is not optional.** Both the cockpit and the setup wizard resolve their assets from
  it (`config.uiDist`). Omit it and a new user installs, boots, and gets a 404 on the very first
  screen of onboarding. This was the actual blocker on the first attempt, and it is invisible
  locally because your working tree always has the directory.
- **`templates/_capabilities.yaml` cannot be dropped.** `seedCapabilities()` throws without it, so
  the daemon will not boot. It is also the file that must never carry a `client.*` capability —
  it is copied into *every* new install.
- **`dist/src/`, not `dist/`.** `tsconfig` compiles `test/` too, so `dist/test/` exists and would
  otherwise ship compiled test fixtures.

Deliberately absent: `agents/` (the user's own org — untracked entirely), `docs/`, `test/`, `src/`,
`scripts/`, `.env`, `data/`.

`test/publish-allowlist.test.ts` asserts all of this against what `npm pack` *actually* produces,
not against the shape of the `files` array — the array can look correct while `.gitignore` or a
stray directory changes the real payload.

## Two traps in the build

**`files` overrides `.gitignore`.** Both `dist/` and `ui2/dist/` are gitignored, and both ship.
That is not a bug; it is why the allowlist has to be read as the source of truth.

**`npm pack` ships whatever is on disk.** Both build outputs are gitignored, so publishing without
building first produces a tarball that is stale or has no code at all — and looks completely
successful. Hence:

```json
"prepack": "npm run build && npm --prefix ui2 run build"
```

`npm run build` is `rm -rf dist && tsc`, cleaned first because `tsc` never prunes outputs whose
source was deleted or renamed. Without the clean, `dist/` accumulates modules that no longer exist
in `src/` and the tarball ships them as dead code.

One consequence: `prepack` runs on `npm pack` as well as `npm publish`, and `vite` writes its build
banner to **stdout**. Anything parsing `npm pack --json` must pass `--ignore-scripts` or it will
choke on the banner.

## Credentials — the part that will waste your afternoon

The account enforces 2FA on publish. npm will reject the publish with:

```
E403  Two-factor authentication or granular access token with bypass 2fa enabled
      is required to publish packages.
```

Only two credential types get past this:

- a **classic Automation** token (Access Tokens → Classic → Automation), or
- a **granular** token with *bypass two-factor authentication* enabled

A classic **Publish** token is not enough — it still demands an interactive OTP. A **read-only**
token authenticates `npm whoami` perfectly well and then fails at the `PUT`, which is the
confusing case: everything looks logged in.

`npm publish --otp=<code>` is **not** a workaround when authenticating by token. It returns the
same error, so it reads like a bad code when it is really the wrong credential type.

Set it so npm writes the file itself rather than hand-editing:

```bash
npm config set //registry.npmjs.org/:_authToken <token>
```

Then confirm the value actually changed before spending another attempt — during the first release
the same rejected token was re-supplied three times, because the file was edited without the
`_authToken` line changing:

```bash
T=$(grep _authToken ~/.npmrc | cut -d= -f2- | tr -d '"'\'' ')
echo "len ${#T} fp $(echo -n "$T" | shasum | cut -c1-8)"
```

A fingerprint that has not moved means npm is about to send the same credential again. Length is a
useful hint too: `npm_` + 36 = 40 characters is the *classic* format; granular tokens are roughly
twice that.

## Verifying before you publish

`npm publish --dry-run` validates the tarball but stops short of the `PUT`, so it never exercises
the 2FA gate. It cannot tell you the credential works.

What it also cannot tell you is whether the package *runs*. And there is a wrong way to check that,
which 0.1.0 shipped through: extracting the tarball and booting **inside** it.

```bash
cd /tmp/pkgtest/package && node dist/src/index.js     # DON'T -- proves nothing
```

`buildConfig` resolves paths against `process.cwd()`. Booting from inside the package makes cwd the
package root, which is the one layout where a cwd-relative asset path resolves by accident. Every
shipped asset appears to work and then does not for a single real user. 0.1.0 passed this check and
still answered `503 UI not built yet` on the first screen of onboarding, because a real install puts
cwd in the *consumer's* project, where `ui2/dist` does not exist.

Install it the way a stranger would instead — a scratch project, cwd outside the package:

```bash
npm pack --pack-destination /tmp
mkdir -p /tmp/pkgtest && cd /tmp/pkgtest && npm init -y >/dev/null
npm install /tmp/ihabbishara-aios-<version>.tgz          # resolves deps for real
env -u CLAUDE_CODE_OAUTH_TOKEN AIOS_UI_PORT=4392 \
    AIOS_DATA_DIR=/tmp/pkgtest/data AIOS_VAULT_PATH=/tmp/pkgtest/vault \
    node node_modules/.bin/aios
```

Expect `setup mode: open http://localhost:4392 to begin onboarding`, and expect `/`, the JS bundle
and the CSS bundle to all return 200. The isolated port, data dir and vault matter — without them
you will collide with the running daemon or write into your real workspace.

Then confirm the split that the accidental-resolution bug hides, because a 200 alone does not prove
the paths are right — only that they happened to resolve:

```bash
node --input-type=module -e "
import { loadConfig } from '@ihabbishara/aios/dist/src/config.js';
const c = loadConfig(process.cwd());
console.log(c.uiDist, c.templatesDir, c.playbooksDir);   // -> node_modules/@ihabbishara/aios/...
console.log(c.agentsDir, c.dataDir, c.envPath);          // -> the consumer's cwd
"
```

Shipped assets must resolve **into the package**; user data must resolve **into the cwd**. Anything
added to the `files` allowlist has to go through `packageAsset()` in `src/config.ts` or it will
repeat the 0.1.0 failure. `test/config-ui-dist.test.ts` pins both halves — note that its original
version asserted the *broken* cwd-relative behaviour, which is part of why the bug survived review.

## Publishing

```bash
npm publish
```

## After: the registry lies for a few minutes

A successful publish prints `+ @ihabbishara/aios@<version>` and the debug log records
`http fetch PUT 200`. Immediately afterwards, `npm view` and a plain registry `GET` will **404** —
authenticated or not, for several minutes.

This is not a failed publish and not npm's local cache. Tarballs reach the CDN immediately;
the packument (the metadata document reads go through) propagates more slowly. Check the artifact
directly instead:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  https://registry.npmjs.org/@ihabbishara/aios/-/aios-<version>.tgz
```

A `200` there means the release landed. You can go further and prove the published bytes are the
ones you validated, by comparing against the shasum `npm publish` printed:

```bash
curl -s -o /tmp/published.tgz https://registry.npmjs.org/@ihabbishara/aios/-/aios-<version>.tgz
shasum /tmp/published.tgz
```

**Do not re-run `npm publish` while the packument is missing.** The version is already claimed and
a retry will 409.

## Version policy

Unpublishing is only freely available for 72 hours; after that the name and version are permanent.
Bump `version` in `package.json` for every release — a version is claimed the moment the `PUT`
returns 200, whether or not reads can see it yet.
