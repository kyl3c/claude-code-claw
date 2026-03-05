import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { spawn } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import { loadTelosContext, getCurrentDatetime } from './telos.js';
import { loadMemoryContext } from './memory.js';

const SCHEDULES_PATH = 'data/schedules.json';

interface Schedule {
  id: number;
  cron: string;
  prompt: string;
  spaceName: string;
  enabled: boolean;
  nextRun: string;
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
    console.log('Created empty schedules file');
  } else {
    console.log('Schedules file found, will load on first tick');
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

function runClaude(model: string, input: string, timeoutMs: number, scheduleId?: number): Promise<string> {
  const tag = scheduleId != null ? `[schedule #${scheduleId}]` : '[scheduler]';
  const args = ['-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--append-system-prompt-file', 'SOUL.md', input];

  return new Promise<string>((resolve, reject) => {
    const proc = spawn('claude', args, { cwd: process.cwd() });
    proc.stdin.end();

    let resultText: string | undefined;
    let buffer = '';
    let timedOut = false;
    let lastToolTime = Date.now();

    const timeout = setTimeout(() => {
      timedOut = true;
      const staleSec = ((Date.now() - lastToolTime) / 1000).toFixed(0);
      console.error(`${tag} timed out after ${timeoutMs / 1000}s (last tool activity ${staleSec}s ago)`);
      proc.kill();
      // SIGKILL fallback if process doesn't exit within 5s
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 5000);
      reject(new Error(`Claude timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    function processLine(line: string) {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use' && block.name) {
              console.log(`${tag} tool: ${block.name}`);
              lastToolTime = Date.now();
            }
          }
        } else if (msg.type === 'result') {
          resultText = msg.result;
        }
      } catch {
        // skip unparseable lines
      }
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) processLine(line);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      console.error(`${tag} stderr: ${chunk.toString()}`);
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) return;
      if (buffer.trim()) processLine(buffer);

      if (resultText !== undefined) {
        resolve(resultText);
      } else {
        reject(new Error(`Claude exited with code ${code} and no output`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export function startSchedulerLoop(
  sendFn: (spaceName: string, text: string) => Promise<void>,
  model: string,
  timeoutMs: number = 10 * 60 * 1000,
  inFlight?: Set<string>,
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
        console.log(`Schedule #${schedule.id}: skipped (space busy), will retry next tick`);
        continue;
      }

      console.log(`Running schedule #${schedule.id}: ${schedule.prompt}`);
      inFlight?.add(schedule.spaceName);
      try {
        const telosContext = loadTelosContext();
        const memoryContext = loadMemoryContext();
        const datetime = getCurrentDatetime();
        const promptWithContext = [datetime, telosContext, memoryContext, schedule.prompt].filter(Boolean).join('\n\n');
        const result = await runClaude(model, promptWithContext, timeoutMs, schedule.id);
        await sendFn(schedule.spaceName, result);
      } catch (err: any) {
        const rawMsg = String(err.message ?? err);
        const shortMsg = rawMsg.length > 200 ? rawMsg.slice(0, 200) + '…' : rawMsg;
        const msg = `Schedule #${schedule.id} failed: ${shortMsg}`;
        console.error(`Schedule #${schedule.id} failed:`, err.message ?? err);
        await sendFn(schedule.spaceName, msg).catch(() => {});
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
  console.log('Scheduler started (60s poll, hot-reload enabled)');
}
