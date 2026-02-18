import { PubSub, type Message } from '@google-cloud/pubsub';
import { ChatServiceClient } from '@google-apps/chat';
import { execFileSync, spawn } from 'child_process';
import { loadSessions, getSession, setSession, deleteSession } from './sessions.js';
import { loadSchedules, handleScheduleCommand, startSchedulerLoop } from './scheduler.js';

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
  };
  user?: {
    name?: string;
    displayName?: string;
  };
}

// --- Config ---

const SUBSCRIPTION = process.env.GOOGLE_CHAT_SUBSCRIPTION;
if (!SUBSCRIPTION) {
  console.error('GOOGLE_CHAT_SUBSCRIPTION is required');
  process.exit(1);
}

const MAX_MESSAGE_LENGTH = 4096;
const STREAM = process.env.STREAM_RESPONSES === 'true';
const MODEL = process.env.ANTHROPIC_MODEL || 'sonnet';

// --- Clients ---

const pubsub = new PubSub();
const chatClient = new ChatServiceClient();

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
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
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

const SOUL_PATH = 'SOUL.md';

function callClaude(input: string, spaceName: string): string {
  const sessionId = getSession(spaceName);
  const args = ['-p', '--model', MODEL, '--output-format', 'json', '--append-system-prompt-file', SOUL_PATH];
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  args.push(input);

  let output: string;
  try {
    output = execFileSync('claude', args, {
      timeout: 5 * 60 * 1000,
      encoding: 'utf-8',
      cwd: process.cwd(),
    });
  } catch (err) {
    if (sessionId) {
      console.log(`[${spaceName}] session ${sessionId} is stale, retrying without resume`);
      deleteSession(spaceName);
      return callClaude(input, spaceName);
    }
    throw err;
  }

  const parsed = JSON.parse(output);

  if (parsed.session_id) {
    setSession(spaceName, parsed.session_id);
  }

  return parsed.result || output;
}

class StaleSessionError extends Error {
  constructor(code: number | null) {
    super(`Claude process exited with code ${code} and no output`);
  }
}

interface StreamResult {
  text: string;
  sessionId?: string;
}

async function callClaudeStreaming(
  input: string,
  spaceName: string,
  onUpdate: (text: string) => void,
): Promise<StreamResult> {
  const sessionId = getSession(spaceName);
  const args = ['-p', '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--append-system-prompt-file', SOUL_PATH];
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  args.push(input);

  return new Promise<StreamResult>((resolve, reject) => {
    const proc = spawn('claude', args, { cwd: process.cwd() });
    proc.stdin.end();

    let accumulated = '';
    let resultSessionId: string | undefined;
    let resultText: string | undefined;
    let buffer = '';

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('Claude streaming timed out after 5 minutes'));
    }, 5 * 60 * 1000);

    function processLine(line: string) {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'stream_event' && msg.event?.type === 'content_block_start' && msg.event.content_block?.type === 'tool_use') {
          const tool = msg.event.content_block;
          console.log(`[claude] tool: ${tool.name}`);
        } else if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
          accumulated += msg.event.delta.text;
          onUpdate(accumulated);
        } else if (msg.type === 'result') {
          resultText = msg.result;
          resultSessionId = msg.session_id;
        }
      } catch {
        // skip unparseable lines
      }
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!; // keep incomplete last line
      for (const line of lines) processLine(line);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      console.error(`[claude stderr] ${chunk.toString()}`);
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      // drain any remaining buffer
      if (buffer.trim()) processLine(buffer);

      console.log(`[streaming] process exited code=${code} resultText=${resultText !== undefined} accumulated=${accumulated.length} chars`);
      if (resultText !== undefined) {
        resolve({ text: resultText, sessionId: resultSessionId });
      } else if (accumulated) {
        resolve({ text: accumulated, sessionId: resultSessionId });
      } else {
        reject(new StaleSessionError(code));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// --- Message handler ---

async function handleEvent(event: ChatEvent): Promise<void> {
  // Only handle MESSAGE events
  if (event.type !== 'MESSAGE') return;

  // Skip bot's own messages
  if (event.message?.sender?.type === 'BOT') return;

  const spaceName = event.space?.name;
  if (!spaceName) return;

  const input = (event.message?.argumentText ?? event.message?.text ?? '').trim();
  if (!input) return;

  console.log(`[${spaceName}] ${event.message?.sender?.displayName}: ${input.slice(0, 100)}`);

  try {
    // Command routing
    if (input === '/reset') {
      deleteSession(spaceName);
      await sendMessage(spaceName, 'Session reset. Next message starts a fresh conversation.');
      return;
    }

    if (input === '/schedules' || input.startsWith('/schedule ') || input.startsWith('/unschedule ')) {
      const result = handleScheduleCommand(input, spaceName);
      await sendMessage(spaceName, result);
      return;
    }

    // Claude bridge
    if (STREAM) {
      // Create placeholder message
      const [placeholder] = await chatClient.createMessage({
        parent: spaceName,
        message: { text: '⏳' },
      });
      const messageName = placeholder.name;
      console.log(`[streaming] placeholder created: ${messageName}`);

      let lastUpdate = 0;
      const UPDATE_INTERVAL = 1500;

      const onUpdate = (partial: string) => {
        const now = Date.now();
        if (now - lastUpdate < UPDATE_INTERVAL) return;
        lastUpdate = now;
        if (!messageName) return;

        let displayText = partial;
        if (displayText.length > MAX_MESSAGE_LENGTH) {
          displayText = '...' + displayText.slice(-(MAX_MESSAGE_LENGTH - 3));
        }

        console.log(`[streaming] updating message (${displayText.length} chars)`);
        chatClient.updateMessage({
          message: { name: messageName, text: displayText },
          updateMask: { paths: ['text'] },
        }).catch((err: any) => console.error('Failed to update message:', err));
      };

      let result: StreamResult;
      try {
        result = await callClaudeStreaming(input, spaceName, onUpdate);
      } catch (err) {
        if (err instanceof StaleSessionError && getSession(spaceName)) {
          console.log(`[${spaceName}] session is stale, retrying without resume`);
          deleteSession(spaceName);
          result = await callClaudeStreaming(input, spaceName, onUpdate);
        } else {
          throw err;
        }
      }

      const { text, sessionId } = result;

      console.log(`[streaming] done: ${text.length} chars, sessionId=${sessionId}`);

      if (sessionId) {
        setSession(spaceName, sessionId);
      }

      // Final update: first chunk replaces placeholder, rest are new messages
      const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
      if (messageName && chunks.length > 0) {
        await chatClient.updateMessage({
          message: { name: messageName, text: chunks[0] },
          updateMask: { paths: ['text'] },
        });
        for (let i = 1; i < chunks.length; i++) {
          await chatClient.createMessage({
            parent: spaceName,
            message: { text: chunks[i] },
          });
        }
      }
    } else {
      const response = callClaude(input, spaceName);
      await sendMessage(spaceName, response);
    }
  } catch (err: any) {
    console.error(`Error handling message:`, err);
    await sendMessage(spaceName, `Error: ${err.message ?? err}`).catch(() => {});
  }
}

// --- Main ---

async function main(): Promise<void> {
  loadSessions();
  loadSchedules();

  const subscription = pubsub.subscription(SUBSCRIPTION!);

  subscription.on('message', (message: Message) => {
    message.ack();
    try {
      const event: ChatEvent = JSON.parse(message.data.toString());
      handleEvent(event);
    } catch (err) {
      console.error('Failed to parse Pub/Sub message:', err);
    }
  });

  subscription.on('error', (err) => {
    console.error('Pub/Sub subscription error:', err);
  });

  startSchedulerLoop(sendMessage, MODEL);

  console.log(`Listening on ${SUBSCRIPTION}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
