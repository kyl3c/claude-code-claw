import path from "path";
import { readFileSync, writeFileSync } from "fs";
import { PubSub, type Message } from "@google-cloud/pubsub";
import { ChatServiceClient } from "@google-apps/chat";
import { GoogleAuth } from "google-auth-library";
import { spawn } from "child_process";
import {
  loadSessions,
  getSession,
  setSession,
  deleteSession,
} from "./sessions.js";
import {
  loadSchedules,
  handleScheduleCommand,
  startSchedulerLoop,
} from "./scheduler.js";
import { loadTelosContext, getTelosSummary, getTelosFile } from "./telos.js";


// --- Types ---

interface ChatEvent {
  type: string;
  space?: {
    name?: string;
    displayName?: string;
    spaceType?: string;
  };
  message?: {
    name?: string;
    createTime?: string;
    sender?: {
      name?: string;
      displayName?: string;
      type?: string;
    };
    text?: string;
    argumentText?: string;
    attachment?: Array<{
      name?: string;
      contentName?: string;
      contentType?: string;
      attachmentDataRef?: {
        resourceName?: string;
      };
    }>;
  };
  user?: {
    name?: string;
    displayName?: string;
  };
}

// --- Config ---

const SUBSCRIPTION = process.env.GOOGLE_CHAT_SUBSCRIPTION;
if (!SUBSCRIPTION) {
  console.error("GOOGLE_CHAT_SUBSCRIPTION is required");
  process.exit(1);
}

const MAX_MESSAGE_LENGTH = 4096;
const MODEL = process.env.ANTHROPIC_MODEL || "sonnet";
const CLAUDE_TIMEOUT_MS =
  Number(process.env.CLAUDE_TIMEOUT_MS) || 10 * 60 * 1000;

// --- Clients ---

const pubsub = new PubSub();
const chatClient = new ChatServiceClient();
const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/chat.bot"],
});

// DWD client for reactions (impersonates a real user)
const REACTION_USER_EMAIL = process.env.REACTION_USER_EMAIL;
let reactionsClient: ChatServiceClient | undefined;
if (REACTION_USER_EMAIL) {
  const credentials = JSON.parse(
    readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf-8"),
  );
  const reactionsAuth = new GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/chat.messages.reactions.create",
    ],
    clientOptions: { subject: REACTION_USER_EMAIL },
  });
  reactionsClient = new ChatServiceClient({ authClient: await reactionsAuth.getClient() as any });
  console.log(`Reactions client ready (impersonating ${REACTION_USER_EMAIL})`);
}

// --- Tool emoji map ---

let toolEmoji: Record<string, string> = {};
try {
  toolEmoji = JSON.parse(readFileSync("tool-emoji.json", "utf-8"));
  console.log(`Loaded ${Object.keys(toolEmoji).length} tool emoji mapping(s)`);
} catch {
  // No custom map — tool reactions disabled
}

// --- Attachments ---

async function downloadAttachment(
  resourceName: string,
  filename: string,
): Promise<string> {
  const client = await auth.getClient();
  const url = `https://chat.googleapis.com/v1/media/${resourceName}?alt=media`;
  const res = await client.request<ArrayBuffer>({
    url,
    responseType: "arraybuffer",
  });
  const savePath = path.resolve(
    "data",
    "workspace",
    "user-files",
    `${Date.now()}-${filename}`,
  );
  writeFileSync(savePath, Buffer.from(res.data));
  return savePath;
}

async function processAttachments(
  attachments: NonNullable<ChatEvent["message"]>["attachment"],
): Promise<string> {
  if (!attachments?.length) return "";
  const lines: string[] = [];
  for (const att of attachments) {
    const resourceName = att.attachmentDataRef?.resourceName;
    const filename = att.contentName || "attachment";
    if (!resourceName) continue;
    try {
      const filePath = await downloadAttachment(resourceName, filename);
      lines.push(
        `The user attached ${filename} at ${filePath}. Use the Read tool to read this file, then respond to their message.`,
      );
      console.log(`[attachment] downloaded ${filename} -> ${filePath}`);
    } catch (err) {
      console.error(`[attachment] failed to download ${filename}:`, err);
    }
  }
  return lines.join("\n");
}

// --- Reactions ---

async function reactToMessage(
  messageName: string,
  emoji: string,
): Promise<void> {
  if (!reactionsClient) return;
  try {
    await reactionsClient.createReaction({
      parent: messageName,
      reaction: { emoji: { unicode: emoji } },
    });
  } catch (err) {
    console.error(`Failed to react with ${emoji} on ${messageName}:`, err);
  }
}

// --- Utilities ---

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}

async function sendMessage(spaceName: string, text: string): Promise<void> {
  const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
  for (const chunk of chunks) {
    try {
      await chatClient.createMessage({
        parent: spaceName,
        message: { text: chunk },
      });
    } catch (err) {
      console.error(`Failed to send to ${spaceName}:`, err);
      throw err;
    }
  }
}

// --- Claude bridge ---

const SOUL_PATH = "SOUL.md";

async function callClaude(
  input: string,
  spaceName: string,
  onToolCall?: (toolName: string) => void,
): Promise<string> {
  const sessionId = getSession(spaceName);
  const args = [
    "-p",
    "--model",
    MODEL,
    "--output-format",
    "stream-json",
    "--verbose",
    "--append-system-prompt-file",
    SOUL_PATH,
    "--chrome",
  ];
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  args.push(input);

  return new Promise<string>((resolve, reject) => {
    const proc = spawn("claude", args, { cwd: process.cwd() });
    proc.stdin.end();

    let resultText: string | undefined;
    let resultSessionId: string | undefined;
    let buffer = "";

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Claude timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`));
    }, CLAUDE_TIMEOUT_MS);

    function processLine(line: string) {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block.type === "tool_use" && block.name) {
              console.log(`[claude] tool: ${block.name}`);
              onToolCall?.(block.name);
            }
          }
        } else if (msg.type === "result") {
          resultText = msg.result;
          resultSessionId = msg.session_id;
        }
      } catch {
        // skip unparseable lines
      }
    }

    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      console.error(`[claude stderr] ${chunk.toString()}`);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (buffer.trim()) processLine(buffer);

      if (resultText !== undefined) {
        if (resultSessionId) setSession(spaceName, resultSessionId);
        resolve(resultText);
      } else if (sessionId) {
        // Stale session — retry without resume
        console.log(
          `[${spaceName}] session ${sessionId} is stale, retrying without resume`,
        );
        deleteSession(spaceName);
        callClaude(input, spaceName, onToolCall).then(resolve, reject);
      } else {
        reject(new Error(`Claude exited with code ${code} and no output`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// --- Message handler ---

async function handleEvent(event: ChatEvent): Promise<void> {
  // Only handle MESSAGE events
  if (event.type !== "MESSAGE") return;

  // Skip bot's own messages
  if (event.message?.sender?.type === "BOT") return;

  const spaceName = event.space?.name;
  if (!spaceName) return;

  const textInput = (
    event.message?.argumentText ??
    event.message?.text ??
    ""
  ).trim();
  const attachments = event.message?.attachment;
  if (!textInput && !attachments?.length) return;

  console.log(
    `[${spaceName}] ${event.message?.sender?.displayName}: ${textInput.slice(0, 100)}${attachments?.length ? ` [+${attachments.length} attachment(s)]` : ""}`,
  );

  const messageName = event.message?.name;

  // React 👀 before processing (must await since callClaude blocks the event loop)
  if (messageName) await reactToMessage(messageName, "👀");

  try {
    // Command routing (text-only, skip if just attachments)
    if (textInput === "/reset") {
      deleteSession(spaceName);
      await sendMessage(
        spaceName,
        "Session reset. Next message starts a fresh conversation.",
      );
    } else if (
      textInput === "/schedules" ||
      textInput.startsWith("/schedule ") ||
      textInput.startsWith("/unschedule ")
    ) {
      const result = handleScheduleCommand(textInput, spaceName);
      await sendMessage(spaceName, result);
    } else if (textInput === "/telos") {
      await sendMessage(spaceName, getTelosSummary());
    } else if (textInput.startsWith("/telos ")) {
      const fileName = textInput.slice("/telos ".length).trim();
      const content = getTelosFile(fileName);
      if (content) {
        await sendMessage(spaceName, content);
      } else {
        await sendMessage(spaceName, `TELOS file \`${fileName}\` not found. Use \`/telos\` to list available files.`);
      }
    } else {
      // Process attachments and build final input
      const attachmentPrefix = await processAttachments(attachments);
      const telosContext = loadTelosContext();
      const input = [telosContext, attachmentPrefix, textInput].filter(Boolean).join("\n\n");

      // Claude bridge
      const reactedEmojis = new Set<string>();
      const response = await callClaude(input, spaceName, (toolName) => {
        const emoji = toolEmoji[toolName];
        if (emoji && messageName && !reactedEmojis.has(emoji)) {
          reactedEmojis.add(emoji);
          reactToMessage(messageName, emoji);
        }
      });
      await sendMessage(spaceName, response);
    }

    // React ✅ on success
    if (messageName) await reactToMessage(messageName, "✅");
  } catch (err: any) {
    console.error(`Error handling message:`, err);
    // React ❌ on error
    if (messageName) await reactToMessage(messageName, "❌");
    await sendMessage(spaceName, `Error: ${err.message ?? err}`).catch(
      () => {},
    );
  }
}

// --- Main ---

async function main(): Promise<void> {
  loadSessions();
  loadSchedules();

  const subscription = pubsub.subscription(SUBSCRIPTION!);

  subscription.on("message", (message: Message) => {
    message.ack();
    try {
      const event: ChatEvent = JSON.parse(message.data.toString());
      handleEvent(event);
    } catch (err) {
      console.error("Failed to parse Pub/Sub message:", err);
    }
  });

  subscription.on("error", (err) => {
    console.error("Pub/Sub subscription error:", err);
  });

  startSchedulerLoop(sendMessage, MODEL, CLAUDE_TIMEOUT_MS);

  console.log(`Listening on ${SUBSCRIPTION}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
