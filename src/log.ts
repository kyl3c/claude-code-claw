import { createWriteStream, mkdirSync, statSync, readFileSync, writeFileSync, type WriteStream } from "fs";
import { getTimezone } from "./telos.js";

const LOG_PATH = "data/logs/app.log";
const MAX_SIZE = 1024 * 1024; // 1MB
const TRIM_TO = 512 * 1024;   // keep last 512KB on rotation

mkdirSync("data/logs", { recursive: true });

let stream: WriteStream = createWriteStream(LOG_PATH, { flags: "a" });

function rotateIfNeeded(): void {
  try {
    const size = statSync(LOG_PATH).size;
    if (size <= MAX_SIZE) return;
    const buf = readFileSync(LOG_PATH);
    const tail = buf.subarray(buf.length - TRIM_TO);
    // Find first newline so we don't start mid-line
    const nl = tail.indexOf(10);
    const clean = nl >= 0 ? tail.subarray(nl + 1) : tail;
    stream.end();
    writeFileSync(LOG_PATH, clean);
    stream = createWriteStream(LOG_PATH, { flags: "a" });
  } catch {
    // non-fatal — keep logging to console
  }
}

function stamp(): string {
  const tz = getTimezone();
  return new Date().toLocaleString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function writeLine(line: string): void {
  stream.write(line + "\n");
  rotateIfNeeded();
}

export function log(msg: string): void {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  writeLine(line);
}

export function logError(msg: string, err?: unknown): void {
  const line = err !== undefined
    ? `[${stamp()}] ${msg} ${err instanceof Error ? err.stack || err.message : String(err)}`
    : `[${stamp()}] ${msg}`;
  console.error(line);
  writeLine(line);
}
