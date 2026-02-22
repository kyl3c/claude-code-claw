Guide me through the full setup of claude-code-claw. Walk through each step interactively, checking for success before moving on. If anything fails, help me troubleshoot before continuing.

## Step 1: Check Prerequisites

Verify that the required tools are installed:

1. Run `node --version` — must be v18 or higher
2. Run `claude --version` — Claude Code CLI must be installed
3. Run `gcloud --version` — Google Cloud SDK must be installed

If any are missing, tell me exactly how to install them and stop until I confirm they're ready.

## Step 2: GCP Project Setup

Ask me for my GCP project ID (or help me create a new project).

Then run:
```bash
gcloud config set project <PROJECT_ID>
gcloud services enable chat.googleapis.com pubsub.googleapis.com
```

Confirm both APIs are enabled before continuing.

## Step 3: Create Pub/Sub Topic and Subscription

Ask me what I'd like to name the topic (suggest a default like `chat-bot`).

```bash
gcloud pubsub topics create <TOPIC_NAME>
gcloud pubsub subscriptions create <TOPIC_NAME>-sub --topic=<TOPIC_NAME>
```

Note the full subscription resource name (`projects/<PROJECT_ID>/subscriptions/<TOPIC_NAME>-sub`) — we'll need it for `.env`.

## Step 4: Create Service Account

```bash
gcloud iam service-accounts create chat-bot --display-name="Chat Bot"
```

Grant the necessary roles:
```bash
gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="serviceAccount:chat-bot@<PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber"

gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="serviceAccount:chat-bot@<PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/chat.bot"
```

Download the key file:
```bash
gcloud iam service-accounts keys create service-account-key.json \
  --iam-account=chat-bot@<PROJECT_ID>.iam.gserviceaccount.com
```

## Step 5: Configure Google Chat App (Manual — Console UI)

This step can't be automated. Walk me through it:

1. Go to [Google Cloud Console → APIs & Services → Google Chat API → Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat)
2. Fill in:
   - **App name**: Choose a name for your bot
   - **Avatar URL**: Optional — leave blank or provide a URL
   - **Description**: Brief description of your bot
   - **Functionality**: Check "Receive 1:1 messages" and "Join spaces and group conversations"
   - **Connection settings**: Select "Cloud Pub/Sub" and enter the full topic name: `projects/<PROJECT_ID>/topics/<TOPIC_NAME>`
   - **Visibility**: Choose who can discover and use the bot
3. Click **Save**

Ask me to confirm when this is done before continuing.

## Step 6: Emoji Reactions (Optional)

Ask: "Do you want the bot to add emoji reactions to messages as it processes them? (e.g. 🔍 when searching, 📖 when reading files). This is cosmetic — everything works fine without it, but it gives nice visual feedback."

**If yes:**

Explain that this requires **Domain-Wide Delegation (DWD)** because the Google Chat API only allows *users* (not bots) to create reactions. The service account will impersonate a real Workspace user.

Walk through these steps:

1. First, get the service account's **Client ID** (not the email):
   ```bash
   gcloud iam service-accounts describe chat-bot@<PROJECT_ID>.iam.gserviceaccount.com --format="value(uniqueId)"
   ```
   Note this number — we'll need it next.

2. Go to [Google Admin Console → Security → API Controls → Domain-wide Delegation](https://admin.google.com/ac/owl/domainwidedelegation)
3. Click **Add new** and enter:
   - **Client ID**: the number from step 1
   - **OAuth scopes**: `https://www.googleapis.com/auth/chat.messages.reactions.create`
4. Click **Authorize**

Ask the user to confirm when this is done. Then ask for their Workspace email address — this is the user the service account will impersonate for reactions. Save it for the `.env` step.

Also copy the emoji map:
```bash
cp tool-emoji.example.json tool-emoji.json
```

Explain they can customize `tool-emoji.json` to map tool names to emoji, including MCP tools (e.g. `"mcp__whoop__get_recent_workouts": "🏋️"`).

**If no:**

Skip this step entirely. Do NOT copy `tool-emoji.example.json`. No DWD setup needed. Note that we'll leave `REACTION_USER_EMAIL` unset in `.env`.

## Step 7: Configure Environment and Personality

```bash
cp .env.example .env
cp CLAUDE.example.md CLAUDE.md
cp SOUL.example.md SOUL.md
mkdir -p data/workspace
mkdir -p data/telos && cp telos/*.md data/telos/
```

Fill in `.env` with the values from the previous steps:
- `GOOGLE_CHAT_SUBSCRIPTION` = the full subscription resource name from Step 3
- `GOOGLE_APPLICATION_CREDENTIALS` = path to the `service-account-key.json` from Step 4
- `REACTION_USER_EMAIL` = the email from Step 6 (only if they chose emoji reactions; otherwise leave it commented out)

Explain that:
- `CLAUDE.md` contains project-level instructions for Claude
- `SOUL.md` defines the bot's personality and tone
- `data/telos/` contains TELOS personal context files — these give the AI persistent context about who you are (mission, goals, beliefs, challenges, etc.) so every response is aligned with your life. The template files have placeholder content you can replace with your own.

Ask if I want to customize these files now or keep the defaults. Suggest starting with `data/telos/MISSION.md` and `data/telos/GOALS.md` — these have the highest impact on response quality.

## Step 8: Heartbeat (Optional)

Ask: "Do you want to enable periodic heartbeat checks? The heartbeat runs on a timer (default every 30 minutes) and checks a user-maintained checklist — things like urgent emails, upcoming calendar events, overdue tasks. If nothing needs attention, the check is silently suppressed. You only get notified when something actually needs your attention."

**If yes:**

```bash
cp heartbeat.example.md data/heartbeat.md
```

Ask for these settings (suggest defaults):
- **Space ID**: Which Google Chat space should heartbeat alerts go to? (They'll need the space name, e.g. `spaces/AAAA...`. They can find this in the Chat URL or by sending a test message and checking the logs.)
- **Interval**: How often to check, in minutes (default: 30)
- **Active hours**: When to run checks, e.g. `7-23` for 7am–11pm (default: 7-23)
- **Timezone**: IANA timezone like `America/Denver`, `America/New_York`, `Europe/London` (default: America/Denver)

Add these to `.env`:
```
HEARTBEAT_SPACE=spaces/<SPACE_ID>
HEARTBEAT_INTERVAL_MINUTES=30
HEARTBEAT_ACTIVE_HOURS=7-23
HEARTBEAT_TIMEZONE=<TIMEZONE>
```

Explain that they should edit `data/heartbeat.md` with their own checklist items. The bot will check each item and only alert when something genuinely needs attention. The checklist works best with items the bot can actually check via its available tools (e.g., MCP servers for Gmail, calendar, Asana).

**If no:**

Skip this step entirely. Leave `HEARTBEAT_SPACE` unset in `.env` — the heartbeat feature is completely disabled when this variable is absent.

## Step 9: Configure MCP Servers (Optional)

MCP (Model Context Protocol) servers give the bot access to external tools and services. The config file `.mcp.json` is gitignored since it contains local paths.

Start by copying the example:
```bash
cp .mcp.example.json .mcp.json
```

Explain that each MCP server entry needs:
- A name (the key)
- A `command` to run (e.g., `npx`, `node`, `python3`)
- `args` for that command

Ask: "Do you want to add any MCP servers now? Common examples include Playwright (browser automation), or custom servers you've built. You can always add more later by editing `.mcp.json`."

For each server they want to add, collect the command and args, then write the entry into `.mcp.json`.

If they don't want to add any, that's fine — leave the example server or clear it to an empty `"mcpServers": {}`.

## Step 10: Configure Tool Permissions

Now let's set up `.claude/settings.json` so the bot has the right tool permissions. This file is gitignored since it contains machine-specific settings.

### Discover MCP Servers

If `.mcp.json` has servers configured, read it and show the user each server:
- The server name
- The command it runs (so they can understand what it does)

Ask: "Which of these MCP servers do you want to allow the bot to use? You can pick all, some, or none."

For each server they approve, we'll need to discover its tools. Since we can't query the server at setup time, ask the user if they want to:
1. **Allow all tools** from that server — use a note that they can refine later
2. **Skip it** for now

Collect the list of approved server names.

If `.mcp.json` has no servers, skip the MCP discovery and move on to built-in permissions.

### Built-in Tool Permissions

Ask the user which built-in Claude Code permissions they want to enable (suggest all as defaults):
- `Read(**)` — allow reading any file in the project
- `WebSearch` — allow web searches
- `WebFetch` — allow fetching web content
- `Bash(git log:*)` — allow viewing git history

### Edit Permissions

Ask: "Which directories should the bot be able to edit files in?"

Suggest these defaults:
- `Edit(data/schedules.json)` — required for the scheduler
- `Edit(data/workspace/**)` — general workspace for the bot

Let them add additional paths if they want (e.g., `Edit(src/**)` for code editing).

### Generate settings.json

Create `.claude/settings.json` with this structure:

```json
{
  "permissions": {
    "allow": [
      // MCP tools: for each approved server, add a comment and its tools
      // Built-in permissions they chose
      // Edit permissions they chose
    ],
    "deny": [],
    "ask": []
  },
  "enableAllProjectMcpServers": true
}
```

For MCP servers where the user chose "allow all tools", add a note that they should run the bot once, check what tools are available, and refine the list if needed. For now, leave a placeholder comment in the file explaining this.

**Important**: Since we can't enumerate MCP tools at setup time, tell the user:
> "After first run, you can check which tools each server offers and add them explicitly to the allow list. For now, Claude will prompt you to approve each tool the first time it's used — you can then add approved ones to settings.json."

Write the file and confirm it looks correct before continuing.

## Step 11: Install and Run

```bash
npm install
npm start
```

Verify that the console shows "Listening on ..." without any errors. If there are errors, help me troubleshoot.

## Step 12: Test

1. In Google Chat, search for the bot by the app name from Step 5
2. Add it to a space or start a DM with it
3. Send a test message like "Hello!"
4. Verify a response comes back

If the test works, congratulate me — setup is complete! If not, help me debug.
