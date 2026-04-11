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
  initOrchestrator,
  routeMessage,
  getThreadSession,
  setThreadSession,
  markBusy,
  markIdle,
  isThreadBusy,
  isSpaceBusy,
  enqueueMessage,
  dequeueNext,
  updateSummary,
  pruneStaleThreads,
  clearThreadsForSpace,
  getMostRecentThread,
  formatThreadList,
  type QueueItem,
} from "./orchestrator.js";
import {
  loadSchedules,
  handleScheduleCommand,
  startSchedulerLoop,
} from "./scheduler.js";
import { loadTelosContext, getCurrentDatetime, getTelosSummary, getTelosFile, getTimezone, setTimezone } from "./telos.js";
import { loadMemoryContext, listMemoryFiles, searchMemory } from "./memory.js";
import {
  parseHeartbeatConfig,
  startHeartbeatLoop,
  getHeartbeatStatus,
} from "./heartbeat.js";
import { log, logError } from "./log.js";


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
const CLAUDE_STALL_TIMEOUT_MS =
  Number(process.env.CLAUDE_STALL_TIMEOUT_MS) || 2 * 60 * 1000;
const CLAUDE_PROGRESS_TIMEOUT_MS =
  Number(process.env.CLAUDE_PROGRESS_TIMEOUT_MS) || 5 * 60 * 1000;

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
  log(`Reactions client ready (impersonating ${REACTION_USER_EMAIL})`);
}

// --- Tool emoji map ---

let toolEmoji: Record<string, string> = {};
try {
  toolEmoji = JSON.parse(readFileSync("tool-emoji.json", "utf-8"));
  log(`Loaded ${Object.keys(toolEmoji).length} tool emoji mapping(s)`);
} catch {
  // No custom map — tool reactions disabled
}

// --- Heartbeat config & concurrency guard ---

const heartbeatConfig = parseHeartbeatConfig();
const inFlight = new Set<string>();

async function callClaudeGuarded(
  input: string,
  spaceName: string,
): Promise<string | null> {
  if (isSpaceBusy(spaceName)) return null;
  // Heartbeat doesn't create threads — uses spaceName session directly
  inFlight.add(spaceName);
  try {
    const result = await callClaude(input, spaceName);
    return result.text;
  } finally {
    inFlight.delete(spaceName);
  }
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
  // Sanitize filename: replace non-ASCII whitespace (e.g. U+202F narrow no-break space
  // used by modern OS time formatting before AM/PM) with regular spaces
  const safeFilename = filename.replace(/[\u00A0\u202F\u2007\u2009\u200A]/g, " ");
  const savePath = path.resolve(
    "data",
    "workspace",
    "user-files",
    `${Date.now()}-${safeFilename}`,
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
      log(`[attachment] downloaded ${filename} -> ${filePath}`);
    } catch (err) {
      logError(`[attachment] failed to download ${filename}:`, err);
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
    logError(`Failed to react with ${emoji} on ${messageName}:`, err);
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

function isSilent(response: string): boolean {
  const trimmed = response.trim();
  return !trimmed || /^silent$/i.test(trimmed);
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
      logError(`Failed to send to ${spaceName}:`, err);
      throw err;
    }
  }
}

// --- Claude bridge ---

const SOUL_PATH = "SOUL.md";
const MCP_HEADLESS_CONFIG = "mcp-headless.json";

async function callClaude(
  input: string,
  spaceName: string,
  onToolCall?: (toolName: string) => void,
  ephemeral?: boolean,
  explicitSessionId?: string,
): Promise<{ text: string; sessionId?: string }> {
  const sessionId = ephemeral
    ? undefined
    : explicitSessionId ?? getSession(spaceName);
  const args = [
    "-p",
    "--model",
    MODEL,
    "--output-format",
    "stream-json",
    "--verbose",
    "--append-system-prompt-file",
    SOUL_PATH,
    "--strict-mcp-config",
    "--mcp-config",
    MCP_HEADLESS_CONFIG,
    "--chrome",
  ];
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  args.push('--', input);

  return new Promise<{ text: string; sessionId?: string }>((resolve, reject) => {
    const proc = spawn("claude", args, {
      cwd: process.cwd(),
      env: { ...process.env, SSH_AUTH_SOCK: "" },
    });
    proc.stdin.end();

    let resultText: string | undefined;
    let resultSessionId: string | undefined;
    let buffer = "";
    let timedOut = false;
    let lastActivity = Date.now();
    let lastProgress = Date.now();
    let gotInit = false;
    let toolCount = 0;

    function killStale(reason: string) {
      if (timedOut) return;
      timedOut = true;
      const phase = gotInit ? `init OK, ${toolCount} tool(s)` : "never initialized (MCP startup hung?)";
      log(`[claude] ${reason} [${phase}]`);
      proc.kill();
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
      reject(new Error(reason));
    }

    const timeout = setTimeout(() => {
      killStale(`Claude timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`);
    }, CLAUDE_TIMEOUT_MS);

    const stallCheck = setInterval(() => {
      const staleSec = (Date.now() - lastActivity) / 1000;
      if (staleSec >= CLAUDE_STALL_TIMEOUT_MS / 1000) {
        clearInterval(stallCheck);
        killStale(`Claude stalled (no output for ${(staleSec).toFixed(0)}s)`);
      }
    }, 15_000);

    const progressCheck = setInterval(() => {
      const noProgressSec = (Date.now() - lastProgress) / 1000;
      if (noProgressSec >= CLAUDE_PROGRESS_TIMEOUT_MS / 1000) {
        clearInterval(progressCheck);
        killStale(`Claude no progress for ${noProgressSec.toFixed(0)}s (${toolCount} tool(s), has output but no tool calls or result)`);
      }
    }, 15_000);

    function processLine(line: string) {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "system" && msg.subtype === "init") {
          gotInit = true;
          lastProgress = Date.now();
          const mcpServers: { name: string; status: string }[] = msg.mcp_servers ?? [];
          const failed = mcpServers.filter((s: { status: string }) => s.status !== "connected");
          if (failed.length > 0) {
            log(`[claude] init: ${mcpServers.length} MCP servers, ${failed.length} not connected: ${failed.map((s: { name: string; status: string }) => `${s.name}(${s.status})`).join(", ")}`);
          } else {
            log(`[claude] init: ${mcpServers.length} MCP servers all connected`);
          }
        } else if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block.type === "tool_use" && block.name) {
              toolCount++;
              lastProgress = Date.now();
              const inputStr = block.input ? JSON.stringify(block.input) : '';
              const truncated = inputStr.length > 200 ? inputStr.slice(0, 200) + '…' : inputStr;
              log(`[claude] tool: ${block.name} ${truncated}`);
              onToolCall?.(block.name);
            }
          }
        } else if (msg.type === "result") {
          lastProgress = Date.now();
          resultText = msg.result;
          resultSessionId = msg.session_id;
        }
      } catch {
        // skip unparseable lines
      }
    }

    proc.stdout.on("data", (chunk: Buffer) => {
      lastActivity = Date.now();
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      logError(`[claude stderr] ${chunk.toString()}`);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      clearInterval(stallCheck);
      clearInterval(progressCheck);
      // If we already rejected via timeout/stall, don't touch the settled promise
      // (otherwise the stale-session retry spawns a zombie process whose result is lost)
      if (timedOut) return;
      if (buffer.trim()) processLine(buffer);

      if (resultText !== undefined) {
        // Persist session for spaceName-based callers (heartbeat compat)
        if (resultSessionId && !ephemeral && !explicitSessionId) {
          setSession(spaceName, resultSessionId);
        }
        resolve({ text: resultText, sessionId: resultSessionId });
      } else if (sessionId) {
        // Stale session — retry without resume
        log(
          `[${spaceName}] session ${sessionId} is stale, retrying without resume`,
        );
        if (!explicitSessionId) {
          deleteSession(spaceName);
        }
        // Retry without any session — caller will persist the new one
        callClaude(input, spaceName, onToolCall, ephemeral).then(resolve, reject);
      } else {
        reject(new Error(`Claude exited with code ${code} and no output`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      clearInterval(stallCheck);
      clearInterval(progressCheck);
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

  const rawTextInput = (
    event.message?.argumentText ??
    event.message?.text ??
    ""
  ).trim();
  const attachments = event.message?.attachment;
  if (!rawTextInput && !attachments?.length) return;

  // Detect btw prefix for parallel tasks
  const isBtw = rawTextInput.toLowerCase().startsWith("btw ");
  const textInput = isBtw ? rawTextInput.slice(4).trim() : rawTextInput;

  log(
    `[${spaceName}]${isBtw ? " [btw]" : ""} ${event.message?.sender?.displayName}: ${textInput.slice(0, 100)}${attachments?.length ? ` [+${attachments.length} attachment(s)]` : ""}`,
  );

  const messageName = event.message?.name;

  // btw messages bypass orchestrator entirely — unchanged ephemeral behavior
  if (isBtw) {
    try {
      if (messageName) await reactToMessage(messageName, "👀");
      const attachmentPrefix = await processAttachments(attachments);
      const telosContext = loadTelosContext();
      const memoryContext = loadMemoryContext();
      const datetime = getCurrentDatetime();
      const input = [datetime, telosContext, memoryContext, attachmentPrefix, textInput].filter(Boolean).join("\n\n");

      const reactedEmojis = new Set<string>();
      const response = await callClaude(input, spaceName, (toolName) => {
        const emoji = toolEmoji[toolName];
        if (emoji && messageName && !reactedEmojis.has(emoji)) {
          reactedEmojis.add(emoji);
          reactToMessage(messageName, emoji);
        }
      }, true); // ephemeral
      if (!isSilent(response.text)) {
        await sendMessage(spaceName, response.text);
      } else {
        log(`[send] silent — suppressed for ${spaceName}`);
      }
      if (messageName) await reactToMessage(messageName, "✅");
    } catch (err: any) {
      logError(`Error handling btw message:`, err);
      if (messageName) await reactToMessage(messageName, "❌");
      await sendMessage(spaceName, `Error: ${err.message ?? err}`).catch(() => {});
    }
    return;
  }

  // Command routing (text-only, no orchestrator involvement)
  if (textInput.startsWith("/")) {
    try {
      if (messageName) await reactToMessage(messageName, "👀");

      if (textInput === "/reset" || textInput === "/clear") {
        // Flush memories using most recent thread's session
        const recentThread = getMostRecentThread(spaceName);
        const sessionId = recentThread?.sessionId ?? getSession(spaceName);
        if (sessionId) {
          const today = new Date().toISOString().split("T")[0];
          const flushPrompt = `This session is about to reset. Review the conversation and save any important preferences, decisions, facts, or action items to the appropriate file in data/memory/ (preferences.md, decisions.md, facts.md, or daily/${today}.md). Use the Write or Edit tool. If nothing worth saving, reply with just: MEMORY_FLUSH_NONE`;
          try {
            const flushResult = await callClaude(flushPrompt, spaceName, undefined, false, sessionId);
            if (!flushResult.text.includes("MEMORY_FLUSH_NONE")) {
              await sendMessage(spaceName, "Saved memories before reset.");
            }
          } catch (err) {
            logError("[memory flush] failed (non-fatal):", err);
          }
        }
        clearThreadsForSpace(spaceName);
        deleteSession(spaceName);
        await sendMessage(spaceName, "Session reset. All threads cleared. Next message starts fresh.");
      } else if (textInput === "/threads") {
        await sendMessage(spaceName, formatThreadList(spaceName));
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
      } else if (textInput === "/timezone") {
        await sendMessage(spaceName, `Current timezone: \`${getTimezone()}\`\nChange with: \`/timezone America/New_York\``);
      } else if (textInput.startsWith("/timezone ")) {
        const tz = textInput.slice("/timezone ".length).trim();
        try {
          new Date().toLocaleString("en-US", { timeZone: tz });
          setTimezone(tz);
          await sendMessage(spaceName, `Timezone set to \`${tz}\``);
        } catch {
          await sendMessage(spaceName, `Invalid timezone: \`${tz}\`. Use IANA format like \`America/Los_Angeles\`, \`America/Denver\`, \`US/Eastern\`.`);
        }
      } else if (textInput === "/heartbeat" && heartbeatConfig) {
        await sendMessage(spaceName, getHeartbeatStatus(heartbeatConfig));
      } else if (textInput === "/memory") {
        await sendMessage(spaceName, listMemoryFiles());
      } else if (textInput.startsWith("/memory search ")) {
        const query = textInput.slice("/memory search ".length).trim();
        if (!query) {
          await sendMessage(spaceName, "Usage: `/memory search <query>`");
        } else {
          const results = searchMemory(query);
          if (results.length === 0) {
            await sendMessage(spaceName, `No memory matches for "${query}".`);
          } else {
            const formatted = results
              .map((r, i) => `*${i + 1}.* \`${r.file}\` (score: ${r.score.toFixed(2)})\n${r.snippet}`)
              .join("\n\n");
            await sendMessage(spaceName, formatted);
          }
        }
      } else if (textInput === "/memory flush") {
        const recentThread = getMostRecentThread(spaceName);
        const sessionId = recentThread?.sessionId ?? getSession(spaceName);
        if (!sessionId) {
          await sendMessage(spaceName, "No active session to flush.");
        } else {
          const today = new Date().toISOString().split("T")[0];
          const flushPrompt = `Review this conversation and save any important preferences, decisions, facts, or action items to the appropriate file in data/memory/ (preferences.md, decisions.md, facts.md, or daily/${today}.md). Use the Write or Edit tool. If nothing worth saving, reply with just: MEMORY_FLUSH_NONE`;
          const flushResult = await callClaude(flushPrompt, spaceName, undefined, false, sessionId);
          if (flushResult.text.includes("MEMORY_FLUSH_NONE")) {
            await sendMessage(spaceName, "Nothing new to save.");
          } else {
            await sendMessage(spaceName, "Memories saved.");
          }
        }
      } else {
        // Unknown command — fall through to regular message handling below
        await handleRegularMessage(spaceName, textInput, attachments, messageName);
        return;
      }

      if (messageName) await reactToMessage(messageName, "✅");
    } catch (err: any) {
      logError(`Error handling command:`, err);
      if (messageName) await reactToMessage(messageName, "❌");
      await sendMessage(spaceName, `Error: ${err.message ?? err}`).catch(() => {});
    }
    return;
  }

  // Regular message — route through orchestrator
  await handleRegularMessage(spaceName, textInput, attachments, messageName);
}

async function handleRegularMessage(
  spaceName: string,
  textInput: string,
  attachments: NonNullable<ChatEvent["message"]>["attachment"],
  messageName?: string,
): Promise<void> {
  // Download attachments before routing (file paths must be stable for queueing)
  const attachmentPrefix = await processAttachments(attachments);

  // Route to thread
  const threadId = await routeMessage(textInput, spaceName);

  // Build full input
  const telosContext = loadTelosContext();
  const memoryContext = loadMemoryContext();
  const datetime = getCurrentDatetime();
  const input = [datetime, telosContext, memoryContext, attachmentPrefix, textInput].filter(Boolean).join("\n\n");

  // If thread is busy, enqueue
  if (isThreadBusy(threadId)) {
    enqueueMessage({
      threadId,
      spaceName,
      message: input,
      textInput,
      messageName,
      timestamp: new Date().toISOString(),
    });
    await sendMessage(spaceName, "I'm still working on something — your message is queued and will be processed next.");
    if (messageName) await reactToMessage(messageName, "🕐");
    return;
  }

  // Process immediately
  markBusy(threadId);
  inFlight.add(threadId);

  try {
    if (messageName) await reactToMessage(messageName, "👀");

    const threadSessionId = getThreadSession(threadId);
    const reactedEmojis = new Set<string>();
    const response = await callClaude(input, spaceName, (toolName) => {
      const emoji = toolEmoji[toolName];
      if (emoji && messageName && !reactedEmojis.has(emoji)) {
        reactedEmojis.add(emoji);
        reactToMessage(messageName, emoji);
      }
    }, false, threadSessionId);

    if (!isSilent(response.text)) {
      await sendMessage(spaceName, response.text);
    } else {
      log(`[send] silent — suppressed for ${spaceName}`);
    }

    // Persist session to thread and also update spaceName default
    if (response.sessionId) {
      setThreadSession(threadId, response.sessionId);
      setSession(spaceName, response.sessionId);
    }

    // Update thread summary (fire-and-forget)
    updateSummary(threadId, textInput, response.text).catch((err) => {
      logError("[summary] update failed (non-fatal):", err);
    });

    if (messageName) await reactToMessage(messageName, "✅");
  } catch (err: any) {
    logError(`Error handling message:`, err);
    if (messageName) await reactToMessage(messageName, "❌");
    await sendMessage(spaceName, `Error: ${err.message ?? err}`).catch(() => {});
  } finally {
    markIdle(threadId);
    inFlight.delete(threadId);
    pruneStaleThreads(spaceName);

    // Process next queued message for this thread
    const next = dequeueNext(threadId);
    if (next) {
      processQueuedMessage(threadId, next);
    }
  }
}

async function processQueuedMessage(
  threadId: string,
  item: QueueItem,
): Promise<void> {
  if (item.messageName) await reactToMessage(item.messageName, "👀");

  markBusy(threadId);
  inFlight.add(threadId);

  try {
    const threadSessionId = getThreadSession(threadId);
    const reactedEmojis = new Set<string>();
    const response = await callClaude(item.message, item.spaceName, (toolName) => {
      const emoji = toolEmoji[toolName];
      if (emoji && item.messageName && !reactedEmojis.has(emoji)) {
        reactedEmojis.add(emoji);
        reactToMessage(item.messageName!, emoji);
      }
    }, false, threadSessionId);

    if (!isSilent(response.text)) {
      await sendMessage(item.spaceName, response.text);
    } else {
      log(`[send] silent — suppressed for ${item.spaceName}`);
    }

    if (response.sessionId) {
      setThreadSession(threadId, response.sessionId);
      setSession(item.spaceName, response.sessionId);
    }

    updateSummary(threadId, item.textInput, response.text).catch((err) => {
      logError("[summary] update failed (non-fatal):", err);
    });

    if (item.messageName) await reactToMessage(item.messageName, "✅");
  } catch (err: any) {
    logError(`Error processing queued message:`, err);
    if (item.messageName) await reactToMessage(item.messageName, "❌");
    await sendMessage(item.spaceName, `Error: ${err.message ?? err}`).catch(() => {});
  } finally {
    markIdle(threadId);
    inFlight.delete(threadId);

    // Chain: process next queued message if any
    const next = dequeueNext(threadId);
    if (next) {
      processQueuedMessage(threadId, next);
    }
  }
}

// --- Main ---

async function main(): Promise<void> {
  loadSessions();
  initOrchestrator(inFlight);
  loadSchedules();

  const subscription = pubsub.subscription(SUBSCRIPTION!);

  subscription.on("message", (message: Message) => {
    message.ack();
    try {
      const event: ChatEvent = JSON.parse(message.data.toString());
      handleEvent(event);
    } catch (err) {
      logError("Failed to parse Pub/Sub message:", err);
    }
  });

  subscription.on("error", (err) => {
    logError("Pub/Sub subscription error:", err);
  });

  startSchedulerLoop(sendMessage, MODEL, CLAUDE_TIMEOUT_MS, inFlight);

  if (heartbeatConfig) {
    startHeartbeatLoop(heartbeatConfig, callClaudeGuarded, sendMessage);
  }

  log(`Listening on ${SUBSCRIPTION}`);
}

main().catch((err) => {
  logError("Fatal:", err);
  process.exit(1);
});
