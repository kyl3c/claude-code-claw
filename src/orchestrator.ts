import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { spawn } from "child_process";
import { log, logError } from "./log.js";

// --- Types ---

export interface Thread {
  id: string;
  sessionId?: string;
  spaceName: string;
  summary: string;
  status: "idle" | "busy";
  lastActive: string; // ISO
}

export interface QueueItem {
  threadId: string;
  spaceName: string;
  message: string; // full assembled input (datetime + telos + memory + attachments + text)
  textInput: string; // raw user text (for summary generation)
  messageName?: string;
  timestamp: string;
}

// --- Paths ---

const THREADS_PATH = "data/sessions/threads.json";
const QUEUE_PATH = "data/sessions/queue.json";

// --- State ---

let threads: Thread[] = [];
let queue: QueueItem[] = [];

// External inFlight set — set by init(), used by isSpaceBusy()
let inFlightRef: Set<string> | null = null;

// --- Init ---

export function initOrchestrator(inFlight: Set<string>): void {
  inFlightRef = inFlight;
  loadThreads();
  loadQueue();

  // Reset any threads stuck as "busy" from a previous crash
  let fixed = 0;
  for (const t of threads) {
    if (t.status === "busy") {
      t.status = "idle";
      fixed++;
    }
  }
  if (fixed > 0) {
    log(`[orchestrator] reset ${fixed} stuck thread(s) to idle`);
    saveThreads();
  }
}

// --- Persistence ---

export function loadThreads(): void {
  if (existsSync(THREADS_PATH)) {
    try {
      const data = JSON.parse(readFileSync(THREADS_PATH, "utf-8"));
      threads = data.threads ?? [];
      log(`[orchestrator] loaded ${threads.length} thread(s)`);
    } catch {
      threads = [];
      log("[orchestrator] created empty threads registry");
    }
  } else {
    mkdirSync(dirname(THREADS_PATH), { recursive: true });
    threads = [];
    saveThreads();
    log("[orchestrator] created empty threads registry");
  }
}

function saveThreads(): void {
  writeFileSync(THREADS_PATH, JSON.stringify({ threads }, null, 2));
}

export function loadQueue(): void {
  if (existsSync(QUEUE_PATH)) {
    try {
      queue = JSON.parse(readFileSync(QUEUE_PATH, "utf-8"));
      if (queue.length > 0) {
        log(`[orchestrator] loaded ${queue.length} queued message(s)`);
      }
    } catch {
      queue = [];
    }
  } else {
    queue = [];
    saveQueue();
  }
}

function saveQueue(): void {
  writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
}

// --- Thread CRUD ---

function generateThreadId(): string {
  const hex = Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return `thread_${hex}`;
}

export function createThread(spaceName: string): Thread {
  const thread: Thread = {
    id: generateThreadId(),
    spaceName,
    summary: "",
    status: "idle",
    lastActive: new Date().toISOString(),
  };
  threads.push(thread);
  saveThreads();
  log(`[orchestrator] created thread ${thread.id} for ${spaceName}`);
  return thread;
}

export function getThread(threadId: string): Thread | undefined {
  return threads.find((t) => t.id === threadId);
}

export function getThreadsForSpace(spaceName: string): Thread[] {
  return threads.filter((t) => t.spaceName === spaceName);
}

export function getMostRecentThread(spaceName: string): Thread | undefined {
  const spaceThreads = getThreadsForSpace(spaceName);
  if (spaceThreads.length === 0) return undefined;
  return spaceThreads.reduce((latest, t) =>
    new Date(t.lastActive) > new Date(latest.lastActive) ? t : latest,
  );
}

// --- Thread session management ---

export function getThreadSession(threadId: string): string | undefined {
  return getThread(threadId)?.sessionId;
}

export function setThreadSession(threadId: string, sessionId: string): void {
  const thread = getThread(threadId);
  if (thread) {
    thread.sessionId = sessionId;
    thread.lastActive = new Date().toISOString();
    saveThreads();
  }
}

export function deleteThreadSession(threadId: string): void {
  const thread = getThread(threadId);
  if (thread) {
    delete thread.sessionId;
    saveThreads();
  }
}

// --- Thread status ---

export function markBusy(threadId: string): void {
  const thread = getThread(threadId);
  if (thread) {
    thread.status = "busy";
    thread.lastActive = new Date().toISOString();
    saveThreads();
  }
}

export function markIdle(threadId: string): void {
  const thread = getThread(threadId);
  if (thread) {
    thread.status = "idle";
    thread.lastActive = new Date().toISOString();
    saveThreads();
  }
}

export function isThreadBusy(threadId: string): boolean {
  return getThread(threadId)?.status === "busy";
}

/**
 * Check if any thread in a space is busy OR if the spaceName itself is in inFlight.
 * The latter handles scheduler/heartbeat backward compat (they add spaceName directly).
 */
export function isSpaceBusy(spaceName: string): boolean {
  if (inFlightRef?.has(spaceName)) return true;
  return getThreadsForSpace(spaceName).some((t) => t.status === "busy");
}

// --- Queue ---

export function enqueueMessage(item: QueueItem): void {
  queue.push(item);
  saveQueue();
  log(
    `[orchestrator] enqueued message for thread ${item.threadId}: ${item.textInput.slice(0, 80)}`,
  );
}

export function dequeueNext(threadId: string): QueueItem | null {
  const idx = queue.findIndex((q) => q.threadId === threadId);
  if (idx === -1) return null;
  const [item] = queue.splice(idx, 1);
  saveQueue();
  log(`[orchestrator] dequeued message for thread ${threadId}`);
  return item;
}

// --- Routing ---

/**
 * Route a message to the appropriate thread for a space.
 * - 0 threads: create new thread
 * - 1 thread: use it
 * - 2+ threads: ask haiku to pick the best match (or create new)
 */
export async function routeMessage(
  textInput: string,
  spaceName: string,
): Promise<string> {
  const spaceThreads = getThreadsForSpace(spaceName);

  if (spaceThreads.length === 0) {
    const thread = createThread(spaceName);
    return thread.id;
  }

  if (spaceThreads.length === 1) {
    return spaceThreads[0].id;
  }

  // 2+ threads — ask haiku to route
  const threadList = spaceThreads
    .map((t) => `- ${t.id}: ${t.summary || "(no summary yet)"}`)
    .join("\n");

  const routingPrompt = `You are a message router. Given the user's message and existing conversation threads, decide which thread this message belongs to, or if it should start a new thread.

Existing threads:
${threadList}

User's message:
${textInput}

Reply with ONLY the thread ID (e.g., thread_a1b2c3d4) or the word NEW if this message should start a new conversation thread. No explanation.`;

  try {
    const result = await callHaiku(routingPrompt);
    const trimmed = result.trim();

    if (trimmed === "NEW") {
      const thread = createThread(spaceName);
      log(`[orchestrator] haiku routed to NEW thread ${thread.id}`);
      return thread.id;
    }

    // Validate that the returned thread ID exists in this space
    const match = spaceThreads.find((t) => t.id === trimmed);
    if (match) {
      log(`[orchestrator] haiku routed to existing thread ${match.id}`);
      return match.id;
    }

    // Haiku returned something unexpected — default to most recent
    log(
      `[orchestrator] haiku returned unexpected "${trimmed}", defaulting to most recent`,
    );
    return getMostRecentThread(spaceName)!.id;
  } catch (err) {
    logError("[orchestrator] routing failed, defaulting to most recent:", err);
    return getMostRecentThread(spaceName)!.id;
  }
}

// --- Summary ---

/**
 * Update a thread's summary based on the latest exchange.
 * Fire-and-forget — errors are logged but not propagated.
 */
export async function updateSummary(
  threadId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  const thread = getThread(threadId);
  if (!thread) return;

  const currentSummary = thread.summary;
  const summaryPrompt = `You maintain a brief summary of an ongoing conversation thread. Update the summary based on the latest exchange.

${currentSummary ? `Current summary: ${currentSummary}` : "This is the start of the conversation."}

Latest exchange:
User: ${userText.slice(0, 500)}
Assistant: ${assistantText.slice(0, 500)}

Reply with ONLY an updated 1-2 sentence summary of what this conversation thread is about. No explanation, no quotes.`;

  try {
    const result = await callHaiku(summaryPrompt);
    thread.summary = result.trim();
    saveThreads();
    log(`[orchestrator] updated summary for ${threadId}: ${thread.summary.slice(0, 80)}`);
  } catch (err) {
    logError(`[orchestrator] summary update failed for ${threadId}:`, err);
  }
}

// --- Pruning ---

const STALE_HOURS = 4;
const MAX_THREADS_PER_SPACE = 8;

/**
 * Remove threads that have been idle for too long and cap per-space thread count.
 */
export function pruneStaleThreads(spaceName: string): void {
  const now = Date.now();
  const staleMs = STALE_HOURS * 60 * 60 * 1000;

  const before = threads.length;
  threads = threads.filter((t) => {
    if (t.spaceName !== spaceName) return true;
    if (t.status === "busy") return true;
    const age = now - new Date(t.lastActive).getTime();
    if (age > staleMs) {
      log(`[orchestrator] pruned stale thread ${t.id} (idle ${(age / 3600000).toFixed(1)}h)`);
      return false;
    }
    return true;
  });

  // Cap per-space threads (keep most recent)
  const spaceThreads = threads
    .filter((t) => t.spaceName === spaceName)
    .sort(
      (a, b) =>
        new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime(),
    );

  if (spaceThreads.length > MAX_THREADS_PER_SPACE) {
    const toRemove = new Set(
      spaceThreads.slice(MAX_THREADS_PER_SPACE).map((t) => t.id),
    );
    threads = threads.filter((t) => !toRemove.has(t.id));
    log(
      `[orchestrator] capped threads for ${spaceName}: removed ${toRemove.size} excess`,
    );
  }

  if (threads.length !== before) {
    saveThreads();
  }
}

/**
 * Clear all threads for a space (used by /reset).
 */
export function clearThreadsForSpace(spaceName: string): void {
  const removed = threads.filter((t) => t.spaceName === spaceName).length;
  threads = threads.filter((t) => t.spaceName !== spaceName);
  // Also clear any queued messages for this space
  queue = queue.filter((q) => q.spaceName !== spaceName);
  saveThreads();
  saveQueue();
  if (removed > 0) {
    log(`[orchestrator] cleared ${removed} thread(s) for ${spaceName}`);
  }
}

// --- Display ---

export function formatThreadList(spaceName: string): string {
  const spaceThreads = getThreadsForSpace(spaceName);
  if (spaceThreads.length === 0) {
    return "No active threads.";
  }

  const lines = spaceThreads
    .sort(
      (a, b) =>
        new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime(),
    )
    .map((t) => {
      const age = Date.now() - new Date(t.lastActive).getTime();
      const ageStr =
        age < 60_000
          ? "just now"
          : age < 3600_000
            ? `${Math.floor(age / 60_000)}m ago`
            : `${(age / 3600_000).toFixed(1)}h ago`;
      const status = t.status === "busy" ? " `[busy]`" : "";
      return `*${t.id}*${status} — ${ageStr}\n  ${t.summary || "(no summary)"}`;
    });

  const queueCount = queue.filter((q) => q.spaceName === spaceName).length;
  const queueLine =
    queueCount > 0 ? `\n\n_${queueCount} message(s) queued_` : "";

  return lines.join("\n\n") + queueLine;
}

// --- Haiku helper ---

function callHaiku(prompt: string): Promise<string> {
  const args = [
    "-p",
    "--model",
    "claude-haiku-4-5",
    "--output-format",
    "stream-json",
    "--max-turns",
    "1",
    "--",
    prompt,
  ];

  return new Promise<string>((resolve, reject) => {
    const proc = spawn("claude", args, { cwd: process.cwd() });
    proc.stdin.end();

    let resultText: string | undefined;
    let buffer = "";

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Haiku timed out after 30s"));
    }, 30_000);

    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "result") {
            resultText = msg.result;
          }
        } catch {
          // skip
        }
      }
    });

    proc.stderr.on("data", () => {
      // ignore stderr
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer);
          if (msg.type === "result") resultText = msg.result;
        } catch {
          // skip
        }
      }
      if (resultText !== undefined) {
        resolve(resultText);
      } else {
        reject(new Error(`Haiku exited with code ${code} and no output`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
