import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { execFileSync } from 'child_process';
import { CronExpressionParser } from 'cron-parser';

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

export function startSchedulerLoop(
  sendFn: (spaceName: string, text: string) => Promise<void>,
  model: string,
  timeoutMs: number = 10 * 60 * 1000,
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

      console.log(`Running schedule #${schedule.id}: ${schedule.prompt}`);
      try {
        const output = execFileSync('claude', ['-p', '--model', model, '--output-format', 'json', '--append-system-prompt-file', 'SOUL.md', schedule.prompt], {
          timeout: timeoutMs,
          encoding: 'utf-8',
          cwd: process.cwd(),
        });
        const parsed = JSON.parse(output);
        const result = parsed.result || output;
        await sendFn(schedule.spaceName, result);
      } catch (err: any) {
        const msg = `Schedule #${schedule.id} failed: ${err.message ?? err}`;
        console.error(msg);
        await sendFn(schedule.spaceName, msg).catch(() => {});
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
