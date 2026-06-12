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
  tools: run_playbook, job_status, vault_read/write/list, propose_action
        ▼
Action Gate (every outward effect: trust ledger, approval queue, audit log)
        ▼
Playbook Engine (deterministic: stage order, review-loop caps, retries, budgets)
        ▼
Specialists (one Agent SDK session per task: role prompt + tool allowlist + cwd)
        │
        ├── SQLite (data/aios.sqlite — job queue, stage state, actions, trust, session ids)
        └── Obsidian vault (~/Desktop/AI-Vault/AIOS — artifacts, daily log, knowledge)
```

### Earned autonomy (Action Gate)

Outward actions (e.g. `vault.write`, `test.echo`) pass through a trust gate. Supervised
types queue for your approval — reply `/approve <id>` or `/reject <id> [reason]` in any
chat, tap the Telegram buttons, or use the **approvals** tab in Mission Control. After a
streak of approvals (default 10 over 30+ days) the gate proposes promoting the type to
autonomous; the promotion itself needs your approval. Any rejection demotes instantly,
and the **trust** tab shows the ledger with a manual demote button. `vault_write` is
seeded autonomous by default (`AIOS_TRUST_SEED`); everything else starts supervised.

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

### Talking to specialists directly

- **Via the moderator:** *"Ask the architect what it thinks about event sourcing here"* —
  the moderator consults the specialist inline (`ask_specialist` tool) and relays the answer.
- **Direct chat:** start a message with `@role` (or `role:`) to bypass the moderator and
  talk one-on-one — `@architect how would you structure the cache?`. Each specialist keeps
  its own conversation memory per chat. Roles: `researcher`, `architect`, `reviewer`,
  `developer`, `tester`, `code-reviewer`.

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
mode per role).

## Skills

Give agents deep, on-demand expertise without bloating their prompts. A skill is a folder
in `skills-plugin/skills/<name>/` with a `SKILL.md` (frontmatter `name` + `description`,
body = the playbook). The description sits in the agent's context; the full file loads
only when relevant.

To add one: create the folder + `SKILL.md`, then list its name in the role's `skills`
array in `src/agents/roles/index.ts`. Shipped examples: `market-sizing`
(market-researcher), `design-tokens` (ui-ux-designer). Write-capable roles (developer, tester) run with bypassed permissions but
are confined to the job's project directory under `~/projects`.

## Finance agent (bound group chats)

A dedicated ledger-backed agent for team finances. Bind your team's group chat to it and
every message there goes to the finance agent (financial topics only) instead of the
moderator:

```bash
AIOS_FINANCE_COMPANY=IDAMA
AIOS_FINANCE_MEMBERS=Name1,Name2,Name3,Name4,Name5
AIOS_CHAT_BINDINGS=telegram:-1001234567890=finance
```

Team members report expenses in plain language ("paid 40 for the domain"); the agent
records them in SQLite (exact integer-cent math), answers who-paid-what from the ledger,
and on request computes the monthly settlement: total, equal split across the members,
balances, and a minimal who-pays-whom transfer plan. Settlement reports are saved to the
vault under `finance/<company>/`.

Telegram group setup: add the bot to the group, then in @BotFather run `/setprivacy` →
**Disable** so the bot can read all group messages (not just /commands). Send any message
in the group, read its chat id from the daemon log, put it in `AIOS_CHAT_BINDINGS`.

## Mission Control UI

A live web dashboard served by the daemon at `http://localhost:4280`:

- **Board** — kanban of jobs (queued/in-progress/completed/failed) with per-stage progress; click into a job for the live pipeline flow + every artifact.
- **Agents** — roster with live activity, tools, skills, and guard status.
- **Chat** — talk to the moderator or any specialist from the browser (same sessions as Telegram).
- **Config** — edit env settings (secrets masked) and playbook YAML (validated + hot-reloaded); restart the daemon with one click.
- **Costs** — usage-equivalents per agent and per day (covered by subscription).
- **Telemetry rail** — every event streaming live (SSE).

Rebuild after UI changes: `cd ui && npm run build` (daemon serves `ui/dist`).

### Remote access via Tailscale

The UI binds to localhost only. To reach it from your phone/laptop anywhere:

```bash
# one-time: install Tailscale on the Mac + your phone, log into the same tailnet
tailscale serve --bg 4280
```

Then open `https://<your-mac-name>.<tailnet>.ts.net` from any of your devices.
Optional extra lock: set `AIOS_UI_TOKEN=<random string>` in `.env` — the UI will
ask for it once per browser.

## Safety notes

- The moderator refuses `project_dir` outside `AIOS_PROJECTS_ROOT` (default `~/projects`).
- Set `TELEGRAM_ALLOWED_USER_IDS` — an open bot means anyone on Telegram can drive
  agents with write access to your machine.
- Secrets live in `.env` only; nothing secret is written to the vault.
