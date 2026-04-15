import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { spawn } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import { loadTelosContext, getCurrentDatetime } from './telos.js';
import { loadMemoryContext } from './memory.js';
import { log, logError } from './log.js';

const SCHEDULES_PATH = 'data/schedules.json';

interface Schedule {
  id: number;
  cron: string;
  prompt: string;
  spaceName: string;
  enabled: boolean;
  nextRun: string;
  /** If true, runs memory flush + session clear instead of invoking a prompt. Silent — no chat message. */
  clearSession?: boolean;
}

function readSchedules(): Schedule[] {
  try {
    return JSON.parse(readFileSync(SCHEDULES_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function writeSchedules(schedules: Schedule[]): void {
  writeFileSync(SCHEDULES_PATH, JSON.stringify(schedules, null, 2));
}

export function loadSchedules(): void {
  if (!existsSync(SCHEDULES_PATH)) {
    mkdirSync(dirname(SCHEDULES_PATH), { recursive: true });
    writeSchedules([]);
    log('Created empty schedules file');
  } else {
    log('Schedules file found, will load on first tick');
  }
}

function computeNextRun(cron: string): string {
  const interval = CronExpressionParser.parse(cron, { tz: 'UTC' });
  return interval.next()!.toISOString() as string;
}

export function handleScheduleCommand(
  command: string,
  spaceName: string
): string {
  const schedules = readSchedules();
  const trimmed = command.trim();

  if (trimmed === '/schedules') {
    const active = schedules.filter((s) => s.spaceName === spaceName && s.enabled);
    if (active.length === 0) {
      return 'No active schedules for this space.';
    }
    return active
      .map((s) => `*#${s.id}* — \`${s.cron}\` — ${s.prompt}\n  Next: ${s.nextRun}`)
      .join('\n\n');
  }

  const unscheduleMatch = trimmed.match(/^\/unschedule\s+(\d+)$/);
  if (unscheduleMatch) {
    const id = parseInt(unscheduleMatch[1], 10);
    const idx = schedules.findIndex((s) => s.id === id && s.spaceName === spaceName);
    if (idx === -1) return `Schedule #${id} not found in this space.`;
    schedules.splice(idx, 1);
    writeSchedules(schedules);
    return `Schedule #${id} deleted.`;
  }

  const scheduleMatch = trimmed.match(/^\/schedule\s+"([^"]+)"\s+(.+)$/);
  if (scheduleMatch) {
    const cron = scheduleMatch[1];
    const prompt = scheduleMatch[2];
    try {
      const nr = computeNextRun(cron);
      const nextId = schedules.reduce((max, s) => Math.max(max, s.id + 1), 1);
      const schedule: Schedule = {
        id: nextId,
        cron,
        prompt,
        spaceName,
        enabled: true,
        nextRun: nr,
      };
      schedules.push(schedule);
      writeSchedules(schedules);
      return `Schedule #${schedule.id} created.\nCron: \`${cron}\`\nPrompt: ${prompt}\nNext run: ${nr}`;
    } catch (err) {
      return `Invalid cron expression: \`${cron}\``;
    }
  }

  return 'Usage: `/schedule "<cron>" <prompt>` or `/schedules` or `/unschedule <id>`';
}

const STALL_TIMEOUT_MS = Number(process.env.CLAUDE_STALL_TIMEOUT_MS) || 2 * 60 * 1000;
// Scheduler uses tighter progress timeout: 2 min (vs 5 min for interactive)
const SCHEDULER_PROGRESS_TIMEOUT_MS = Number(process.env.SCHEDULER_PROGRESS_TIMEOUT_MS) || 2 * 60 * 1000;
// Scheduler-specific total timeout — crons should finish fast, not wait 30 min
const SCHEDULER_TIMEOUT_MS = Number(process.env.SCHEDULER_TIMEOUT_MS) || 5 * 60 * 1000;

const MCP_HEADLESS_CONFIG = 'mcp-headless.json';

function runClaude(model: string, input: string, timeoutMs: number, scheduleId?: number): Promise<{ text: string; toolCount: number; elapsed: number }> {
  const tag = scheduleId != null ? `[schedule #${scheduleId}]` : '[scheduler]';
  const startTime = Date.now();
  const args = ['-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--append-system-prompt-file', 'SOUL.md', '--strict-mcp-config', '--mcp-config', MCP_HEADLESS_CONFIG];

  return new Promise<{ text: string; toolCount: number; elapsed: number }>((resolve, reject) => {
    const proc = spawn('claude', args, { cwd: process.cwd() });
    proc.stdin.write(input);
    proc.stdin.end();

    let resultText: string | undefined;
    let buffer = '';
    let timedOut = false;
    let lastActivity = Date.now();
    let lastProgress = Date.now();
    let gotInit = false;
    let toolCount = 0;

    function killStale(reason: string) {
      if (timedOut) return;
      timedOut = true;
      const phase = gotInit ? `init OK, ${toolCount} tool(s)` : 'never initialized (MCP startup hung?)';
      logError(`${tag} ${reason} [${phase}]`);
      proc.kill();
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
      reject(new Error(reason));
    }

    const timeout = setTimeout(() => {
      const staleSec = ((Date.now() - lastActivity) / 1000).toFixed(0);
      killStale(`timed out after ${timeoutMs / 1000}s (no output for ${staleSec}s)`);
    }, timeoutMs);

    const stallCheck = setInterval(() => {
      const staleSec = (Date.now() - lastActivity) / 1000;
      if (staleSec >= STALL_TIMEOUT_MS / 1000) {
        clearInterval(stallCheck);
        killStale(`stalled (no output for ${staleSec.toFixed(0)}s)`);
      }
    }, 15_000);

    const progressCheck = setInterval(() => {
      const noProgressSec = (Date.now() - lastProgress) / 1000;
      if (noProgressSec >= SCHEDULER_PROGRESS_TIMEOUT_MS / 1000) {
        clearInterval(progressCheck);
        killStale(`no progress for ${noProgressSec.toFixed(0)}s (${toolCount} tool(s), has output but no tool calls or result)`);
      }
    }, 15_000);

    function processLine(line: string) {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'system' && msg.subtype === 'init') {
          gotInit = true;
          lastProgress = Date.now();
          const mcpServers: { name: string; status: string }[] = msg.mcp_servers ?? [];
          const failed = mcpServers.filter(s => s.status !== 'connected');
          if (failed.length > 0) {
            log(`${tag} init: ${mcpServers.length} MCP servers, ${failed.length} not connected: ${failed.map(s => `${s.name}(${s.status})`).join(', ')}`);
          } else {
            log(`${tag} init: ${mcpServers.length} MCP servers all connected`);
          }
        } else if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use' && block.name) {
              toolCount++;
              lastProgress = Date.now();
              const inputStr = block.input ? JSON.stringify(block.input) : '';
              const truncated = inputStr.length > 200 ? inputStr.slice(0, 200) + '…' : inputStr;
              log(`${tag} tool: ${block.name} ${truncated}`);
            }
          }
        } else if (msg.type === 'result') {
          lastProgress = Date.now();
          resultText = msg.result;
        }
      } catch {
        // skip unparseable lines
      }
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      lastActivity = Date.now();
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) processLine(line);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      logError(`${tag} stderr: ${chunk.toString()}`);
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      clearInterval(stallCheck);
      clearInterval(progressCheck);
      if (timedOut) return;
      if (buffer.trim()) processLine(buffer);

      if (resultText !== undefined) {
        resolve({ text: resultText, toolCount, elapsed: Date.now() - startTime });
      } else {
        reject(new Error(`Claude exited with code ${code} and no output`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      clearInterval(stallCheck);
      clearInterval(progressCheck);
      reject(err);
    });
  });
}

export function startSchedulerLoop(
  sendFn: (spaceName: string, text: string) => Promise<void>,
  model: string,
  timeoutMs: number = 10 * 60 * 1000,
  inFlight?: Set<string>,
  flushAndClearFn?: (spaceName: string) => Promise<void>,
): void {
  async function tick() {
    const schedules = readSchedules();
    if (schedules.length === 0) {
      setTimeout(tick, 60_000);
      return;
    }

    let dirty = false;
    const now = new Date();

    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      if (new Date(schedule.nextRun) > now) continue;

      // Skip if another caller (heartbeat, user message) is using this space
      if (inFlight?.has(schedule.spaceName)) {
        log(`Schedule #${schedule.id}: skipped (space busy), will retry next tick`);
        continue;
      }

      if (schedule.clearSession) {
        log(`Schedule #${schedule.id}: nightly flush+clear for ${schedule.spaceName}`);
        inFlight?.add(schedule.spaceName);
        try {
          if (flushAndClearFn) {
            await flushAndClearFn(schedule.spaceName);
            log(`Schedule #${schedule.id}: flush+clear complete`);
          } else {
            logError(`Schedule #${schedule.id}: clearSession set but no flushAndClearFn provided`);
          }
        } catch (err: any) {
          logError(`Schedule #${schedule.id} flush+clear error:`, err.message ?? err);
          // Silent by design — no chat message
        } finally {
          inFlight?.delete(schedule.spaceName);
        }
        try {
          schedule.nextRun = computeNextRun(schedule.cron);
          dirty = true;
        } catch {
          schedule.enabled = false;
          dirty = true;
        }
        continue;
      }

      log(`Running schedule #${schedule.id}: ${schedule.prompt}`);
      inFlight?.add(schedule.spaceName);
      try {
        const telosContext = loadTelosContext();
        const memoryContext = loadMemoryContext();
        const datetime = getCurrentDatetime();
        const promptWithContext = [datetime, telosContext, memoryContext, schedule.prompt].filter(Boolean).join('\n\n');

        let result: { text: string; toolCount: number; elapsed: number } | undefined;
        let lastErr: Error | undefined;
        const MAX_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            result = await runClaude(model, promptWithContext, SCHEDULER_TIMEOUT_MS, schedule.id);
            break;
          } catch (err: any) {
            lastErr = err;
            const isStall = String(err.message ?? '').includes('stall') || String(err.message ?? '').includes('timed out') || String(err.message ?? '').includes('no progress');
            if (attempt < MAX_ATTEMPTS && isStall) {
              log(`Schedule #${schedule.id}: stalled, retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`);
              continue;
            }
            break;
          }
        }

        if (result !== undefined) {
          log(`Schedule #${schedule.id} completed (${result.toolCount} tools, ${(result.elapsed / 1000).toFixed(0)}s)`);
          await sendFn(schedule.spaceName, result.text);
        } else {
          const rawMsg = String(lastErr?.message ?? lastErr);
          const shortMsg = rawMsg.length > 200 ? rawMsg.slice(0, 200) + '…' : rawMsg;
          const msg = `Schedule #${schedule.id} failed: ${shortMsg}`;
          logError(`Schedule #${schedule.id} failed:`, lastErr?.message ?? lastErr);
          await sendFn(schedule.spaceName, msg).catch(() => {});
        }
      } catch (err: any) {
        const rawMsg = String(err.message ?? err);
        const shortMsg = rawMsg.length > 200 ? rawMsg.slice(0, 200) + '…' : rawMsg;
        logError(`Schedule #${schedule.id} unexpected error:`, err.message ?? err);
        await sendFn(schedule.spaceName, `Schedule #${schedule.id} failed: ${shortMsg}`).catch(() => {});
      } finally {
        inFlight?.delete(schedule.spaceName);
      }

      try {
        schedule.nextRun = computeNextRun(schedule.cron);
        dirty = true;
      } catch {
        schedule.enabled = false;
        dirty = true;
      }
    }

    if (dirty) {
      writeSchedules(schedules);
    }

    setTimeout(tick, 60_000);
  }

  setTimeout(tick, 60_000);
  log('Scheduler started (60s poll, hot-reload enabled)');
}
