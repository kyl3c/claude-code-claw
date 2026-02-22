# claude-code-claw

An [OpenClaw](https://github.com/openclaw/openclaw) style bot powered by [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It bridges Google Chat messages to Claude via Pub/Sub, giving you a persistent AI assistant with full access to Claude Code's tool-use capabilities, memory, etc. 

As with all software, there are risks to running this. You are responsible for mitigating them. This is just a proof of concept inspired by the [NanoClaw](https://github.com/qwibitai/nanoclaw) project (a smaller codebase OpenClaw with containerization by default).

**Do not run this on your main computer.** Use an isolated machine (VM, container, cloud instance) with least-privilege access. This bot executes Claude Code with tool-use capabilities — treat it like any other agent that can run arbitrary commands.

It's not currently self-editing like OpenClaw. I like it this way for security/reliability, but I can understand why some people like it.

## Features

- **Persistent sessions** — each Chat space maintains its own conversation history with Claude
- **Emoji reactions** *(optional)* — reacts with tool-specific emoji as Claude works (requires Domain-Wide Delegation)
- **Scheduled prompts** — set up cron-based recurring prompts (e.g., daily briefings)
- **Message chunking** — long responses are automatically split to fit Google Chat's message limits
- **Personality via SOUL.md** — customize the bot's behavior and tone through a simple markdown file
- **TELOS personal context** — give the AI persistent context about who you are (mission, goals, beliefs, challenges) so every response is aligned with your life
- **Heartbeat checks** *(optional)* — periodic context-aware checks against a user-maintained checklist (emails, calendar, tasks). Silent when nothing needs attention (`HEARTBEAT_OK` is suppressed), alerts only when something requires action

## How It Works

```
Google Chat → Pub/Sub Topic → claude-code-claw → Claude Code CLI → Google Chat API
```

1. A Google Chat app is configured to publish events to a Pub/Sub topic
2. This agent subscribes to the topic and receives messages in real-time
3. Messages are forwarded to Claude Code CLI (`claude -p`) with session persistence
4. Claude's responses are sent back to the originating Chat space via the Google Chat API

## Quick Start

If you have [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed, the fastest way to get started is the interactive setup command:

```bash
claude /setup
```

This walks you through the entire GCP configuration step by step. For manual setup, read on.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- A [Google Workspace](https://workspace.google.com/) account — **Google Chat apps require Google Workspace**; free consumer Gmail accounts (`@gmail.com`) do not have access to the Google Chat API
- A [Google Cloud](https://cloud.google.com/) project with billing enabled
- [gcloud CLI](https://cloud.google.com/sdk/docs/install) installed and authenticated

## Manual Setup

### 1. Enable GCP APIs

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services enable chat.googleapis.com pubsub.googleapis.com
```

### 2. Create Pub/Sub Topic and Subscription

```bash
gcloud pubsub topics create chat-bot
gcloud pubsub subscriptions create chat-bot-sub --topic=chat-bot
```

### 3. Create Service Account

```bash
gcloud iam service-accounts create chat-bot --display-name="Chat Bot"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:chat-bot@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:chat-bot@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/chat.bot"

gcloud iam service-accounts keys create service-account-key.json \
  --iam-account=chat-bot@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

### 4. Configure Google Chat App

1. Go to [Google Cloud Console → Google Chat API → Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat)
2. Set **App name**, **Description**, and optionally an **Avatar URL**
3. Under **Functionality**, enable "Receive 1:1 messages" and "Join spaces and group conversations"
4. Under **Connection settings**, select **Cloud Pub/Sub** and enter your topic: `projects/YOUR_PROJECT_ID/topics/chat-bot`
5. Under **Visibility**, check the box for "Make this Chat app available to specific people and groups in yourWorkspace"
6. Type your email in the input box below
7. Click **Save**

### 5. Configure Environment

```bash
cp .env.example .env
cp CLAUDE.example.md CLAUDE.md
cp SOUL.example.md SOUL.md
cp tool-emoji.example.json tool-emoji.json
mkdir -p data/telos && cp telos/*.md data/telos/
cp heartbeat.example.md data/heartbeat.md
```

Edit `.env` with your values (see [Configuration](#configuration) below). Edit `CLAUDE.md` and `SOUL.md` to customize the bot's instructions and personality. Edit files in `data/telos/` to provide personal context (see [TELOS](#telos-personal-context)).

### 6. Install and Run

```bash
npm install
npm start
```

You should see `Listening on projects/YOUR_PROJECT_ID/subscriptions/chat-bot-sub` in the console.

## Configuration

| Variable | Description | Required |
|---|---|---|
| `GOOGLE_CHAT_SUBSCRIPTION` | Full Pub/Sub subscription resource name (e.g., `projects/my-project/subscriptions/chat-bot-sub`) | Yes |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to GCP service account key JSON file | Yes |
| `REACTION_USER_EMAIL` | Email of a Workspace user for emoji reactions (requires Domain-Wide Delegation — see below) | No |

### Emoji Reactions (Optional)

The bot can add emoji reactions to messages as it works (e.g. 🔍 when searching, 📖 when reading files). This requires **Domain-Wide Delegation (DWD)** because the Google Chat API only allows *users* (not bots) to create reactions. The service account impersonates a real Workspace user to add them.

**To enable emoji reactions:**

1. **Enable DWD on the service account** — Go to [Google Admin Console → Security → API Controls → Domain-wide Delegation](https://admin.google.com/ac/owl/domainwidedelegation) and add the service account's **Client ID** with the scope: `https://www.googleapis.com/auth/chat.messages.reactions.create`
2. **Set `REACTION_USER_EMAIL`** in `.env` to a real Workspace user email (e.g. your own)
3. **Customize mappings** in `tool-emoji.json` — maps tool names to emoji (e.g. `"Read": "📖"`, `"mcp__whoop__get_recent_workouts": "🏋️"`)

If `REACTION_USER_EMAIL` is not set, reactions are silently disabled — everything else works normally.

## Commands

| Command | Description |
|---|---|
| `/reset` | Clear the current session and start fresh |
| `/schedule "<cron>" <prompt>` | Schedule a recurring prompt (e.g., `/schedule "0 9 * * *" morning briefing`) |
| `/schedules` | List active schedules in the current space |
| `/unschedule <id>` | Delete a schedule by ID |
| `/telos` | List loaded TELOS context files and their sizes |
| `/telos <file>` | Show contents of a specific TELOS file (e.g., `/telos goals`) |
| `/heartbeat` | Show heartbeat status (interval, active hours, checklist state) |

## Project Structure

```
src/
  main.ts        # Pub/Sub listener, message routing, Claude bridge
  sessions.ts    # Per-space session persistence
  scheduler.ts   # Cron-based scheduled prompts
  telos.ts       # TELOS context loading module
  heartbeat.ts   # Periodic heartbeat checks
telos/           # TELOS template files (checked into repo)
data/            # Runtime data (gitignored)
  telos/         # Your personal TELOS files (gitignored)
.claude/
  commands/
    setup.md     # Interactive setup guide (run with `claude /setup`)
```

## Customization

- **`SOUL.md`** — defines the bot's personality and communication style. Edit this to change how the bot responds. (Copied from `SOUL.example.md` during setup, gitignored so your edits stay local.)
- **`CLAUDE.md`** — project-level instructions that Claude Code uses for context. Add domain-specific guidance here. (Copied from `CLAUDE.example.md` during setup, gitignored so your edits stay local.)
- **`tool-emoji.json`** — maps tool names to emoji reactions shown during processing. The bot reacts with the corresponding emoji when Claude uses a tool (e.g. 📖 for Read, 🔍 for Grep). Add your own MCP tool mappings here, e.g. `"mcp__whoop__get_recent_workouts": "🏋️"`. (Copied from `tool-emoji.example.json` during setup, gitignored so your edits stay local.)

### TELOS Personal Context

TELOS gives the AI persistent context about who you are — mission, goals, beliefs, challenges, and more — so every response is aligned with your actual life. Inspired by Daniel Miessler's [PAI (Personal AI Infrastructure)](https://danielmiessler.com/) approach.

The `telos/` directory contains template files. During setup, these are copied to `data/telos/` where you customize them with your own content. The bot loads all `.md` files from `data/telos/` on every prompt. See [`telos/README.md`](telos/README.md) for details on each file.

### Heartbeat

The heartbeat runs periodic checks against a user-maintained checklist — emails, calendar, tasks, etc. — in a single context-aware API call using `--resume`, so the agent has full conversation history. If nothing needs attention, the agent responds `HEARTBEAT_OK` and the message is silently suppressed (no spam). Only actual alerts are delivered to Google Chat.

**Setup:**

1. Copy the template: `cp heartbeat.example.md data/heartbeat.md`
2. Edit `data/heartbeat.md` with your own checklist items
3. Set `HEARTBEAT_SPACE` in `.env` to the space where alerts should be sent

**Environment variables:**

| Variable | Description | Default |
|---|---|---|
| `HEARTBEAT_SPACE` | Google Chat space for heartbeat alerts (omit to disable) | *(disabled)* |
| `HEARTBEAT_INTERVAL_MINUTES` | Minutes between checks | `30` |
| `HEARTBEAT_ACTIVE_HOURS` | Active window in `start-end` format (24h) | `7-23` |
| `HEARTBEAT_TIMEZONE` | IANA timezone for active hours | `America/Denver` |

**Transcript pruning:** When a heartbeat returns `HEARTBEAT_OK`, the heartbeat exchange is automatically pruned from the Claude CLI session transcript (JSONL file) to keep context clean. Only heartbeats that surfaced real alerts remain in history.

**Concurrency:** The heartbeat uses a guarded `callClaude` wrapper — if a user message is already being processed, the heartbeat tick is skipped. Interactive messages are never blocked.

## Adding MCP Servers

You can extend the bot with [MCP servers](https://modelcontextprotocol.io/) to give Claude access to additional tools (APIs, databases, services, etc.). Add a `.mcp.json` file to the project root:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "python3",
      "args": ["/path/to/my_mcp_server.py"]
    }
  }
}
```

Each entry defines a server name and the command to launch it via stdio transport. You can add multiple servers:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest"
      ]
    }
  }
}
```

You may also need to allow the MCP tools in `.claude/settings.local.json` under `permissions.allow` (e.g., `"mcp__my-server__my_tool"`). The `.mcp.json` file can be checked in to share servers across deployments, or added to `.gitignore` if your setup is specific to your machine.

## License

[MIT](LICENSE)
