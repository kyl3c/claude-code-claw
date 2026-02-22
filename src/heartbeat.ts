import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getSession } from "./sessions.js";
import { loadTelosContext } from "./telos.js";

const HEARTBEAT_PATH = "data/heartbeat.md";

export interface HeartbeatConfig {
  spaceName: string;
  intervalMs: number;
  activeStart: number;
  activeEnd: number;
  timezone: string;
}

export function parseHeartbeatConfig(): HeartbeatConfig | null {
  const spaceName = process.env.HEARTBEAT_SPACE;
  if (!spaceName) return null;

  const intervalMin = Number(process.env.HEARTBEAT_INTERVAL_MINUTES) || 30;
  const hours = (process.env.HEARTBEAT_ACTIVE_HOURS || "7-23").split("-");
  const activeStart = Number(hours[0]) || 0;
  const activeEnd = Number(hours[1]) || 23;
  const timezone = process.env.HEARTBEAT_TIMEZONE || "America/Denver";

  return {
    spaceName,
    intervalMs: intervalMin * 60 * 1000,
    activeStart,
    activeEnd,
    timezone,
  };
}

export function loadHeartbeatChecklist(): string | null {
  if (!existsSync(HEARTBEAT_PATH)) return null;

  const raw = readFileSync(HEARTBEAT_PATH, "utf-8");
  // Strip headers, horizontal rules, and whitespace — check if anything substantive remains
  const stripped = raw
    .replace(/^#+\s.*$/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .trim();

  if (!stripped) return null;
  return raw.trim();
}

export function isWithinActiveHours(
  start: number,
  end: number,
  timezone: string,
): boolean {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  });
  const hour = Number(formatter.format(now));
  return hour >= start && hour < end;
}

export function buildHeartbeatPrompt(checklist: string): string {
  return `<heartbeat-check>
You are running a periodic heartbeat check. Review the checklist below and check if any items need attention RIGHT NOW.

If NOTHING needs immediate attention, respond with exactly: HEARTBEAT_OK
If something needs attention, respond with a brief summary of what needs action.

Do not be overly cautious — only flag items that genuinely need attention now.

${checklist}
</heartbeat-check>`;
}

export function isHeartbeatOk(response: string): boolean {
  if (response.length > 300) return false;
  // Strip markdown formatting, quotes, and whitespace
  const cleaned = response.replace(/[*_`#"'\n\r]/g, "").trim();
  return cleaned === "HEARTBEAT_OK";
}

export function pruneHeartbeatFromTranscript(spaceName: string): void {
  try {
    const sessionId = getSession(spaceName);
    if (!sessionId) return;

    const projectDir = process.cwd().replace(/\//g, "-");
    const jsonlPath = path.join(
      homedir(),
      ".claude",
      "projects",
      projectDir,
      `${sessionId}.jsonl`,
    );

    if (!existsSync(jsonlPath)) return;

    const content = readFileSync(jsonlPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length < 2) return;

    // Parse all lines, bail if format is unexpected
    const entries: any[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (!parsed.type || !parsed.uuid) return; // unexpected format
        entries.push(parsed);
      } catch {
        return; // unparseable, bail
      }
    }

    // Find last user and last assistant entries
    let lastUserIdx = -1;
    let lastAssistantIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === "user" && lastUserIdx === -1) {
        lastUserIdx = i;
      }
      if (entries[i].type === "assistant" && lastAssistantIdx === -1) {
        lastAssistantIdx = i;
      }
      if (lastUserIdx !== -1 && lastAssistantIdx !== -1) break;
    }

    if (lastUserIdx === -1 || lastAssistantIdx === -1) return;

    // Collect indices to remove: the user msg, assistant msg, and any file-history-snapshots between/after them
    const removeFrom = Math.min(lastUserIdx, lastAssistantIdx);
    const indicesToRemove = new Set<number>();
    indicesToRemove.add(lastUserIdx);
    indicesToRemove.add(lastAssistantIdx);

    // Also remove file-history-snapshot entries that follow the heartbeat exchange
    for (let i = removeFrom; i < entries.length; i++) {
      if (entries[i].type === "file-history-snapshot") {
        indicesToRemove.add(i);
      }
    }

    const pruned = entries.filter((_, i) => !indicesToRemove.has(i));

    // Fix parentUuid chain: the entry after a gap should point to the entry before it
    for (let i = 1; i < pruned.length; i++) {
      if (pruned[i].parentUuid && pruned[i].parentUuid !== pruned[i - 1].uuid) {
        pruned[i].parentUuid = pruned[i - 1].uuid;
      }
    }

    const output = pruned.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(jsonlPath, output);
    console.log(`[heartbeat] pruned ${indicesToRemove.size} transcript entries`);
  } catch (err) {
    console.error("[heartbeat] prune failed (non-fatal):", err);
  }
}

export function startHeartbeatLoop(
  config: HeartbeatConfig,
  callClaudeFn: (
    input: string,
    spaceName: string,
  ) => Promise<string | null>,
  sendFn: (spaceName: string, text: string) => Promise<void>,
): void {
  async function tick() {
    try {
      if (!isWithinActiveHours(config.activeStart, config.activeEnd, config.timezone)) {
        console.log("[heartbeat] outside active hours, skipping");
        setTimeout(tick, config.intervalMs);
        return;
      }

      const checklist = loadHeartbeatChecklist();
      if (!checklist) {
        console.log("[heartbeat] no checklist or empty, skipping");
        setTimeout(tick, config.intervalMs);
        return;
      }

      const telosContext = loadTelosContext();
      const prompt = buildHeartbeatPrompt(checklist);
      const input = [telosContext, prompt].filter(Boolean).join("\n\n");

      console.log("[heartbeat] running check...");
      const response = await callClaudeFn(input, config.spaceName);

      if (response === null) {
        console.log("[heartbeat] skipped (claude busy)");
        setTimeout(tick, config.intervalMs);
        return;
      }

      console.log(`[heartbeat] response: ${JSON.stringify(response.slice(0, 300))}`);
      if (isHeartbeatOk(response)) {
        console.log("[heartbeat] OK — suppressing message");
        pruneHeartbeatFromTranscript(config.spaceName);
      } else {
        console.log("[heartbeat] alert — delivering message");
        await sendFn(config.spaceName, response);
      }
    } catch (err) {
      console.error("[heartbeat] tick error:", err);
    }

    setTimeout(tick, config.intervalMs);
  }

  setTimeout(tick, config.intervalMs);
  const intervalMin = config.intervalMs / 60000;
  console.log(
    `Heartbeat started (${intervalMin}m interval, active ${config.activeStart}-${config.activeEnd} ${config.timezone})`,
  );
}

export function getHeartbeatStatus(config: HeartbeatConfig): string {
  const intervalMin = config.intervalMs / 60000;
  const active = isWithinActiveHours(
    config.activeStart,
    config.activeEnd,
    config.timezone,
  );
  const checklist = loadHeartbeatChecklist();

  const lines = [
    `*Heartbeat Status*`,
    `Space: \`${config.spaceName}\``,
    `Interval: ${intervalMin} minutes`,
    `Active hours: ${config.activeStart}:00–${config.activeEnd}:00 ${config.timezone}`,
    `Currently active: ${active ? "yes" : "no"}`,
    `Checklist: ${checklist ? "loaded" : "empty or missing"}`,
  ];

  return lines.join("\n");
}
