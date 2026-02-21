# claude-code-claw

An [OpenClaw](https://github.com/openclaw/openclaw) style bot powered by [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It bridges Google Chat messages to Claude via Pub/Sub, giving you a persistent AI assistant with full access to Claude Code's tool-use capabilities, memory, etc. 

As with all software, there are risks to running this. You are responsible for mitigating them. This is just a proof of concept inspired by the [NanoClaw](https://github.com/qwibitai/nanoclaw) project (a smaller codebase OpenClaw with containerization by default).

**Do not run this on your main computer.** Use an isolated machine (VM, container, cloud instance) with least-privilege access. This bot executes Claude Code with tool-use capabilities — treat it like any other agent that can run arbitrary commands.

It's not currently self-editing like OpenClaw. I like it this way for security/reliability, but I can understand why some people like it.

## Features

- **Persistent sessions** — each Chat space maintains its own conversation history with Claude
- **Emoji reactions** — 👀 when processing, ✅ when done, ❌ on error
- **Scheduled prompts** — set up cron-based recurring prompts (e.g., daily briefings)
- **Message chunking** — long responses are automatically split to fit Google Chat's message limits
- **Personality via SOUL.md** — customize the bot's behavior and tone through a simple markdown file

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
```

Edit `.env` with your values (see [Configuration](#configuration) below). Edit `CLAUDE.md` and `SOUL.md` to customize the bot's instructions and personality.

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
## Commands

| Command | Description |
|---|---|
| `/reset` | Clear the current session and start fresh |
| `/schedule "<cron>" <prompt>` | Schedule a recurring prompt (e.g., `/schedule "0 9 * * *" morning briefing`) |
| `/schedules` | List active schedules in the current space |
| `/unschedule <id>` | Delete a schedule by ID |

## Project Structure

```
src/
  main.ts        # Pub/Sub listener, message routing, Claude bridge
  sessions.ts    # Per-space session persistence
  scheduler.ts   # Cron-based scheduled prompts
data/            # Runtime data (gitignored)
.claude/
  commands/
    setup.md     # Interactive setup guide (run with `claude /setup`)
```

## Customization

- **`SOUL.md`** — defines the bot's personality and communication style. Edit this to change how the bot responds. (Copied from `SOUL.example.md` during setup, gitignored so your edits stay local.)
- **`CLAUDE.md`** — project-level instructions that Claude Code uses for context. Add domain-specific guidance here. (Copied from `CLAUDE.example.md` during setup, gitignored so your edits stay local.)

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
