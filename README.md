# AI-OS

A local, always-on multi-agent system built on the Claude Agent SDK. You chat with a
**Moderator** from Telegram, Slack, or a local terminal; it delegates work to a team of
specialists (researcher, architect, reviewer, developer, tester, code reviewer) through
deterministic **playbooks**, and persists everything to an Obsidian vault.

- **Runs on your Claude subscription** — no API key, no per-token billing.
- **No public ports** — Telegram long-polling and Slack Socket Mode are outbound-only.
- **Resumable** — jobs survive daemon restarts; the moderator remembers conversations.

## Architecture

```
Telegram / Slack / CLI
        │
        ▼
Moderator (persistent Agent SDK session per chat)
  tools: run_playbook, job_status, vault_read/write/list
        ▼
Playbook Engine (deterministic: stage order, review-loop caps, retries, budgets)
        ▼
Specialists (one Agent SDK session per task: role prompt + tool allowlist + cwd)
        │
        ├── SQLite (data/aios.sqlite — job queue, stage state, session ids)
        └── Obsidian vault (~/Desktop/AI-Vault/AIOS — artifacts, daily log, knowledge)
```

## Setup

```bash
npm install
cp .env.example .env
```

### 1. Claude subscription auth (no API key)

```bash
claude setup-token
```

Log in with your normal Claude account. Paste the resulting token into `.env` as
`CLAUDE_CODE_OAUTH_TOKEN`. The token is valid for one year.

> From June 15, 2026, Agent SDK usage on subscription plans draws from a separate
> monthly Agent SDK credit pool — still part of your subscription, not API billing.

### 2. Telegram

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token into
   `TELEGRAM_BOT_TOKEN`.
2. Get your numeric user id (message [@userinfobot](https://t.me/userinfobot)) and set
   `TELEGRAM_ALLOWED_USER_IDS=<your id>` so only you can use the bot.

### 3. Slack (optional)

Create an app at api.slack.com → enable **Socket Mode** → app-level token with
`connections:write` (`SLACK_APP_TOKEN`) → bot token with `chat:write`,
`app_mentions:read`, `im:history`, `channels:history` (`SLACK_BOT_TOKEN`) → subscribe to
`message.im` / `message.channels` events → install to workspace.

## Run

```bash
npm run dev          # local REPL channel (plus any configured bots)
npm test             # engine + playbook unit tests
npx tsx scripts/smoke.ts "hello"   # one-shot smoke test
```

### Run as a daemon (launchd)

```bash
npm run build
cp launchd/com.ihab.aios.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ihab.aios.plist
tail -f data/aios.log
```

`KeepAlive` restarts it on crash; `RunAtLoad` starts it at login. Unload with
`launchctl unload ~/Library/LaunchAgents/com.ihab.aios.plist`.

## Usage

Talk to the bot like a colleague:

- *"I have an idea for a CLI tool that does X — let's discuss."* → normal conversation.
- *"Build it in ~/projects/my-tool."* → moderator starts the `software-feature` job:
  research → design (architect ⇄ reviewer, max 3 rounds) → implement → test-and-fix
  (max 2 rounds) → code review → report back to your chat.
- *"Research the best local vector databases."* → `research-report` job.
- Every artifact lands in Obsidian: `AI-Vault/AIOS/jobs/<date>-<slug>/`.

## Playbooks

Workflows are YAML in `playbooks/` — add new ones without touching code:

```yaml
name: my-workflow
description: What it does (the moderator reads this to pick playbooks)
needsProjectDir: false
stages:
  - type: single   # one specialist pass
    id: gather
    role: researcher
  - type: loop     # producer ⇄ critic until approve or maxRounds
    id: draft
    producer: architect
    critic: reviewer
    maxRounds: 3
  - type: verify   # runner checks, fixer fixes, re-check up to maxRounds
    id: check
    runner: tester
    fixer: developer
    maxRounds: 2
```

Roles live in `src/agents/roles/index.ts` (system prompt + tool allowlist + permission
mode per role). Write-capable roles (developer, tester) run with bypassed permissions but
are confined to the job's project directory under `~/projects`.

## Safety notes

- The moderator refuses `project_dir` outside `AIOS_PROJECTS_ROOT` (default `~/projects`).
- Set `TELEGRAM_ALLOWED_USER_IDS` — an open bot means anyone on Telegram can drive
  agents with write access to your machine.
- Secrets live in `.env` only; nothing secret is written to the vault.
