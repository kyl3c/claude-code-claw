Guide me through the full setup of cc-remote-agent. Walk through each step interactively, checking for success before moving on. If anything fails, help me troubleshoot before continuing.

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

## Step 6: Configure `.env`

```bash
cp .env.example .env
```

Fill in the values from the previous steps:
- `GOOGLE_CHAT_SUBSCRIPTION` = the full subscription resource name from Step 3
- `GOOGLE_APPLICATION_CREDENTIALS` = path to the `service-account-key.json` from Step 4

Ask me whether I want to enable streaming responses (`STREAM_RESPONSES=true`) — explain that it progressively updates messages in Chat as Claude generates them, rather than waiting for the full response.

## Step 7: Install and Run

```bash
npm install
npm start
```

Verify that the console shows "Listening on ..." without any errors. If there are errors, help me troubleshoot.

## Step 8: Test

1. In Google Chat, search for the bot by the app name from Step 5
2. Add it to a space or start a DM with it
3. Send a test message like "Hello!"
4. Verify a response comes back

If the test works, congratulate me — setup is complete! If not, help me debug.
