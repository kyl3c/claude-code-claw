import { getTimezone } from "./telos.js";

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

export function log(msg: string): void {
  console.log(`[${stamp()}] ${msg}`);
}

export function logError(msg: string, err?: unknown): void {
  if (err !== undefined) {
    console.error(`[${stamp()}] ${msg}`, err);
  } else {
    console.error(`[${stamp()}] ${msg}`);
  }
}
