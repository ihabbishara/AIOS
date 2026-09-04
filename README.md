# AI-OS

A local, always-on multi-agent system built on the Claude Agent SDK. You chat with
**Hermes, your Chief of Staff**, from Telegram, Slack, or a local terminal; he delegates work
to a team of named specialists (Athena the architect, Vulcan the engineer, Minos the reviewer,
Argus in QA, Odin the researcher, and more) through deterministic **playbooks**, and
persists everything as markdown in a local vault (`~/AIOS/workspace` — point
`AIOS_VAULT_PATH` at an Obsidian vault if you keep one).

- **Runs on your Claude subscription** — no API key, no per-token billing.
- **No public ports** — Telegram long-polling and Slack Socket Mode are outbound-only.
- **Resumable** — jobs survive daemon restarts; Hermes remembers conversations.

## The Staff

Agents are YAML manifests in `agents/`, and that directory is **yours** — the setup wizard writes
it on first run and nothing ships with it. So the table below is not what you receive; it is one
worked example, the reference org the test suite runs against, to show the shape a staff takes.
Your own comes out of the Org Architect interview and will have different names and departments:

| Dept | Name | Title | Legacy alias |
|---|---|---|---|
| Operations | **Hermes** | Chief of Staff | rami, moderator |
| Engineering | **Athena** | Architect / Eng Lead | architect, kai |
| Engineering | **Vulcan** | Senior Engineer | developer, maya |
| Engineering | **Argus** | QA Engineer | tester, tarek |
| Engineering | **Themis** | Code Reviewer | code-reviewer, nadia |
| Engineering | **Atlas** | DevOps | devops, omar |
| Engineering | **Odin** | Eng Researcher | researcher, ziad |
| Research | **Clio** | Analyst / Librarian | analyst, lina |
| Research | **Janus** | Market Researcher | market-researcher, sami |
| Research | **Venus** | UI/UX Designer | ui-ux-designer, dalia |
| Research | **Minos** | Research Reviewer | reviewer, yara |
| Finance | **Midas** | CFO (private) | cfo, faris |
| Finance | **Juno** | Bookkeeper (group) | finance, salim |
| Life | **Jasmine** | Personal Ops | jasmine |

Aliases: `@developer` → Vulcan, `@cfo` → Midas, `@finance` → Juno (old arabic names also still work).
Private agents (Midas, Jasmine) refuse requests from group/shared chats.

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
        └── Vault (~/AIOS/workspace — artifacts, daily log, knowledge; AIOS_VAULT_PATH moves it)
```

### Earned autonomy (Action Gate)

Outward actions (e.g. `vault.write`, `test.echo`) pass through a trust gate. Supervised
types queue for your approval — reply `/approve <id>` or `/reject <id> [reason]` in any
chat, tap the Telegram buttons, or use the **approvals** tab in Mission Control. After a
streak of approvals (default 10 over 30+ days) the gate proposes promoting the type to
autonomous; the promotion itself needs your approval. Any rejection demotes instantly,
and the **trust** tab shows the ledger with a manual demote button. `vault_write` is
seeded autonomous by default (`AIOS_TRUST_SEED`); everything else starts supervised.

### Heartbeat (briefs & reminders)

The daemon sends a **morning brief** (07:30) and **evening close** (21:00) to
`AIOS_PRIMARY_CHAT` (e.g. `telegram:12345`) — pending approvals, autonomous-action
digests, finished/failed jobs, trust changes, and the day's reminders, narrated by
the moderator. Raw briefs are archived in the vault under `briefs/`. Ask for
reminders in chat ("remind me Friday 15:00 to call the accountant") — they ping the
chat where you set them. Say "stop pinging me about X" to add a triage rule.
Anchor times: `AIOS_ANCHOR_MORNING` / `AIOS_ANCHOR_EVENING`.

### Voice

Send a Telegram voice note — it's transcribed locally (whisper.cpp), answered, and
the reply comes back as a voice note with the text attached. In Mission Control's
chat, the 🎙 button records from your mic and plays the spoken reply. Everything
runs on-device (kokoro TTS, `say` fallback) — no audio leaves the Mac.

Setup: `brew install whisper-cpp ffmpeg` (models auto-download on first use).
Config: `AIOS_VOICE_ENABLED`, `AIOS_WHISPER_MODEL` (base|small|medium),
`AIOS_TTS_VOICE` (kokoro voice id, or `say`).

### Email & Calendar (first senses)

Connect Google accounts once: create a GCP project → enable **Gmail API** +
**Google Calendar API** → OAuth consent screen (External, add yourself as test
user) → Credentials → **Create OAuth client → Desktop app** → copy id/secret,
then run `npx tsx scripts/google-auth.ts personal` (repeat per account) and
restart the daemon.

The daemon then watches your inbox (urgent mail pings you; the rest lands in
briefs as a digest) and calendar (meeting reminders 15 min ahead; agenda in the
morning brief). Ask the moderator things like *"what's unread?"* or *"draft a
reply to Hannah saying I'll confirm Monday"* — drafts, sends, archives, and
labels all go through the approval gate and earn autonomy like everything else.
Polling: `AIOS_GMAIL_POLL_SECONDS` (120), `AIOS_CALENDAR_POLL_SECONDS` (300),
`AIOS_MEETING_PING_MINUTES` (15), `AIOS_GMAIL_SKIP_CATEGORIES` (promotions,social).

## Install

Install from source. It is a daemon with its own database, vault and org, so give it a directory
of its own rather than adding it to an existing project. Node 22.5 or newer.

```bash
git clone git@github.com:ihabbishara/AIOS.git && cd AIOS
npm install
cd ui2 && npm install && npm run build && cd ..   # the browser UI, wizard included
cp .env.example .env
npm run dev
```

The `ui2` build is not optional — it is both the cockpit and the setup wizard, so without it the
very first screen of onboarding has nothing to serve.

A fresh clone boots into a browser setup wizard at `http://localhost:4280` — token first, then
the Org Architect interviews you and provisions your own staff. You do not inherit anyone else's:
`agents/` is untracked, so a clone arrives empty and the wizard creates your org on first run.
That empty `agents/` is also what puts the daemon into setup mode, so nothing else has to be
configured to reach the wizard.

There is no npm package. One was published as `@ihabbishara/aios` and has been removed, so
`npm install @ihabbishara/aios` will 404 — clone instead.

Releasing a new version is documented in [docs/RELEASING.md](docs/RELEASING.md).

## Configure

The wizard walks you through all of these: Claude auth, workspace, then a **Connect** step for
Telegram (with automatic chat-id capture — message your bot once and the wizard picks up the
id), Slack, and image generation. Every channel is optional there, and everything can also be
done by hand below or later from Mission Control → System → Config.

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
2. The wizard captures your chat id automatically: message your new bot once and confirm the
   prompt — it fills `AIOS_PRIMARY_CHAT` and adds you to `TELEGRAM_ALLOWED_USER_IDS`. Doing it
   by hand instead: message [@userinfobot](https://t.me/userinfobot) for your numeric id, set
   `TELEGRAM_ALLOWED_USER_IDS=<your id>` and `AIOS_PRIMARY_CHAT=telegram:<your id>`.
3. Adding the bot to a group? Send `/setprivacy` to @BotFather and choose **Disable**, or the
   bot cannot see group messages.

### 3. Slack (optional)

Create an app at api.slack.com → enable **Socket Mode** → app-level token with
`connections:write` (`SLACK_APP_TOKEN`) → bot token with `chat:write`,
`app_mentions:read`, `im:history`, `channels:history` (`SLACK_BOT_TOKEN`) → subscribe to
`message.im` / `message.channels` events → install to workspace.

### 4. Image generation — Nano Banana (optional)

Set `GEMINI_API_KEY` (aistudio.google.com → API keys) and agents with the `media-gen`
capability can call `generate_image` (~$0.04 per image). When the key is present during
onboarding, the wizard proposes `media-gen` on your worker and lead agents — visible and
removable on the review screen.

## Run

```bash
npm run dev          # local REPL channel (plus any configured bots)
npm test             # engine + playbook unit tests
npx tsx scripts/smoke.ts "hello"   # one-shot smoke test against a RUNNING daemon
npx tsx scripts/smoke.ts --target athena "who are you?"   # address one agent
```

### Run as a daemon (launchd)

```bash
npm run build
sed "s|{{ROOT}}|$PWD|g; s|{{NODE}}|$(which node)|g" launchd/aios.plist.template \
  > ~/Library/LaunchAgents/com.aios.daemon.plist
launchctl load ~/Library/LaunchAgents/com.aios.daemon.plist
tail -f data/aios.log
```

`KeepAlive` restarts it on crash; `RunAtLoad` starts it at login. Unload with
`launchctl unload ~/Library/LaunchAgents/com.aios.daemon.plist`. launchd hands agents only
`/usr/bin:/bin:/usr/sbin:/sbin`, so if node or the tools the daemon shells out to live under
your home (nvm, `~/.local/bin`), add those directories to the plist's `PATH` — plists expand
neither `~` nor `$HOME`.

## Usage

Talk to the bot like a colleague:

- *"I have an idea for a CLI tool that does X — let's discuss."* → normal conversation.
- *"Build it in ~/projects/my-tool."* → moderator starts a `code_task` job (default
  `build`, sandboxed): research → design (architect ⇄ reviewer, max 3 rounds) → implement →
  test-and-fix (max 2 rounds) → code review → report back to your chat. Modes: `build`
  (sandboxed worktree), `analyze` (read-only audit), `inplace` (edits your real checkout —
  not sandboxed, by explicit request only).
- *"Research the best local vector databases."* → `research-report` job.
- Every artifact lands in the vault: `~/AIOS/workspace/AIOS/goals/<date>-<slug>/`.

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

Roles are compiled from the agent manifests in `agents/<department>/<name>.yaml` — charter,
persona, prompt, `kind`, and the `capabilities` that resolve into a tool allowlist and permission
mode. `src/agents/roles/index.ts` holds only the `RoleDef` type they compile into.

## Skills

Give agents deep, on-demand expertise without bloating their prompts. A skill is a folder
in `skills-plugin/skills/<name>/` with a `SKILL.md` (frontmatter `name` + `description`,
body = the playbook). The description sits in the agent's context; the full file loads
only when relevant.

To add one: create the folder + `SKILL.md`, then list its name in the `skills:` array of the
agent's own manifest (`agents/<department>/<name>.yaml`). Shipped examples: `market-sizing`
(market-researcher), `design-tokens` (ui-ux-designer). Write-capable roles (developer, tester) run with bypassed permissions but
are confined to the job's project directory under `~/projects`.

## Finance agent (bound group chats)

A dedicated ledger-backed agent for team finances. Bind your team's group chat to it and
every message there goes to the finance agent (financial topics only) instead of the
moderator:

```bash
AIOS_FINANCE_COMPANY=ACME
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

Rebuild after UI changes: `cd ui2 && npm run build` (daemon serves `ui2/dist`).

### Remote access via Tailscale

The UI binds to localhost only. To reach it from your phone/laptop anywhere:

```bash
# one-time: install Tailscale on the Mac + your phone, log into the same tailnet
tailscale serve --bg 4280
```

Then open `https://<your-mac-name>.<tailnet>.ts.net` from any of your devices.
Optional extra lock: set `AIOS_UI_TOKEN=<random string>` in `.env` — the UI will
ask for it once per browser.

## Full autonomy mode

**Agents are autonomous by default.** Every **unguarded, non-sandboxed** agent runs with the
SDK's full built-in surface — shell, file access, network — with no allowlist enforcement, so
a job never stalls waiting for you to approve a tool. A persistent **FULL AUTONOMY** badge sits
in the top bar so the mode is always visible.

The alternative is **granular** mode: each agent may use only the tools its capabilities grant,
and a request for anything else is denied, parked for review, and turned into a
`permission.grant` you approve by hand. It is the more restrictive setting, and it is also why
a job can stall for hours on a missing tool. Set `AIOS_FULL_AUTONOMY=0` (System → Config →
Security, then restart) to switch to it. `false`, `no` and `off` work too — turning autonomy
**off** is deliberately forgiving, so a value meant to restrict your agents never does the
opposite. Any other value, including unset, leaves autonomy on.

Reach for granular mode when you want the guard rails everywhere rather than on the agents you
chose. The per-agent levers below work in either mode.

What it does **not** change:

- **Guarded agents are exempt, bit for bit.** Any agent with a guard capability (`aws-readonly`,
  `ledger-confine`, `ops-guardrail`, …) keeps its guards, its clamped tool list, and its
  permission mode. That is the lever: if an agent touches client infrastructure or money,
  give it a guard and full autonomy will never widen it.
- **The code sandbox is exempt.** Sandboxed agents keep their workspace jail — full autonomy
  never lets file tools escape a goal workspace.
- **Domain tools do not spread.** Money and ledger tools stay physically attached to the
  agents whose capabilities grant them.
- **Approvals still work.** The action gate, trust tiers, and always-supervised actions
  (`permission.grant`, `trust.promote`) are untouched, and agents still ask you questions
  mid-job (Telegram ping, dashboard Queue, `@agent` replies).

Honest costs while the mode is on: unguarded agents can run arbitrary commands on this
machine as your user, so prompt-injected content (a hostile email, a poisoned web page) is a
real risk — keep guards on anything sensitive; per-role tool revokes from Mission Control
stop binding for unguarded agents; and denial telemetry goes quiet for them (nothing is
denied, so nothing is logged). Flipping the flag also resets stored chat sessions once —
agents start their next conversation fresh.

## Safety notes

- The moderator refuses `project_dir` outside `AIOS_PROJECTS_ROOT` (default `~/projects`).
- Set `TELEGRAM_ALLOWED_USER_IDS` — an open bot means anyone on Telegram can drive
  agents with write access to your machine.
- Secrets live in `.env` only; nothing secret is written to the vault.
