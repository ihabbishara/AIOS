#!/usr/bin/env bash
#
# scripts/onboarding-sandbox.sh — run the onboarding wizard against an EMPTY install, without
# touching the live one.
#
# Why this exists: onboarding bugs are structurally invisible on a developer's machine. The org
# here is hand-written and correct, `~/projects` exists, and `agents/` is populated — so the
# daemon never enters setup mode and the new-user paths are never executed. Walking this sandbox
# once (2026-08-11) found four bugs that 215 green onboarding tests did not.
#
# The isolation rests on one fact: loadConfig() resolves `root = process.cwd()`, so `.env`,
# `agents/`, and `data/` all come from the working directory. Running from .sandbox/ therefore
# gives a genuinely empty install while still using this repo's build, templates and playbooks.
#
#   ./scripts/onboarding-sandbox.sh          start it (prints the URL)
#   ./scripts/onboarding-sandbox.sh reset    delete the sandbox and start fresh
#   ./scripts/onboarding-sandbox.sh stop     stop it and leave the state for inspection
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="$REPO/.sandbox"
PORT="${AIOS_SANDBOX_PORT:-4291}"
CMD="${1:-start}"

port_pids() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true; }

stop() {
  local pids; pids="$(port_pids)"
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill 2>/dev/null || true
    sleep 1
    echo "stopped the sandbox on :$PORT"
  else
    echo "nothing listening on :$PORT"
  fi
}

case "$CMD" in
  stop)  stop; exit 0 ;;
  reset) stop; rm -rf "$SANDBOX"; echo "removed $SANDBOX" ;;
  start) ;;
  *) echo "usage: $0 [start|reset|stop]" >&2; exit 2 ;;
esac

if [ -n "$(port_pids)" ]; then
  echo "port $PORT is already in use — run '$0 stop', or set AIOS_SANDBOX_PORT" >&2
  exit 1
fi

if [ ! -f "$REPO/dist/src/index.js" ]; then
  echo "no build found — running npm run build first"
  (cd "$REPO" && npm run build >/dev/null)
fi
if [ ! -f "$REPO/ui2/dist/index.html" ]; then
  echo "no ui2 build found — running its build first (this is what the wizard renders)"
  (cd "$REPO/ui2" && npm run build >/dev/null)
fi

# agents/ empty and no token is exactly what puts bootMode() into "setup".
# projects/ must exist: it is the cwd every hand-off is spawned in, and a missing one fails deep
# in the SDK as "the Claude binary cannot start — likely a libc/architecture mismatch".
mkdir -p "$SANDBOX"/{agents,data,projects,workspace}

cd "$SANDBOX"
# -u on both credentials: an exported token would skip setup mode and boot a normal daemon
# against an empty org, which is not the thing under test.
env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY \
  AIOS_UI_PORT="$PORT" \
  AIOS_PLAYBOOKS_DIR="$REPO/playbooks" \
  AIOS_TEMPLATES_DIR="$REPO/templates" \
  AIOS_UI_DIST="$REPO/ui2/dist" \
  AIOS_PROJECTS_ROOT="$SANDBOX/projects" \
  AIOS_VAULT_PATH="$SANDBOX/workspace" \
  node "$REPO/dist/src/index.js" > "$SANDBOX/sandbox.log" 2>&1 &

for _ in $(seq 1 40); do
  [ -n "$(port_pids)" ] && break
  sleep 1
done

if [ -z "$(port_pids)" ]; then
  echo "the sandbox did not come up — last lines of $SANDBOX/sandbox.log:" >&2
  tail -20 "$SANDBOX/sandbox.log" >&2
  exit 1
fi

cat <<EOF

  Onboarding sandbox is up:  http://localhost:$PORT

  It is a genuinely empty install — the wizard will ask for a token, a workspace, and run a
  real interview. Nothing it does touches your live install on :4280.

  The auth step wants a subscription token: run \`claude setup-token\` and paste the result,
  or paste the one already in this repo's .env.

  state   $SANDBOX          (agents/ data/ workspace/ — inspect after provisioning)
  log     $SANDBOX/sandbox.log
  stop    ./scripts/onboarding-sandbox.sh stop
  fresh   ./scripts/onboarding-sandbox.sh reset && ./scripts/onboarding-sandbox.sh

EOF
