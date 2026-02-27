import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "fs";
import path from "path";

const TELOS_DIR = "data/telos";
const CONFIG_PATH = "data/config.json";
const DEFAULT_TIMEZONE = "America/Los_Angeles";

interface Config {
  timezone?: string;
}

function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(config: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function getTimezone(): string {
  return readConfig().timezone || DEFAULT_TIMEZONE;
}

export function setTimezone(tz: string): void {
  const config = readConfig();
  config.timezone = tz;
  writeConfig(config);
}

/**
 * Load all TELOS .md files and concatenate into a single context block.
 * Returns empty string if the directory doesn't exist or has no files.
 */
export function loadTelosContext(): string {
  if (!existsSync(TELOS_DIR)) return "";

  const files = readdirSync(TELOS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();

  if (files.length === 0) return "";

  const sections: string[] = [];
  for (const file of files) {
    const filePath = path.join(TELOS_DIR, file);
    const content = readFileSync(filePath, "utf-8").trim();
    if (content) {
      sections.push(content);
    }
  }

  if (sections.length === 0) return "";

  return `<telos-context>\n${sections.join("\n\n")}\n</telos-context>`;
}

/**
 * Returns a formatted summary of loaded TELOS files and their sizes.
 */
export function getTelosSummary(): string {
  if (!existsSync(TELOS_DIR)) {
    return "No TELOS directory found at `data/telos/`. Run setup to create one.";
  }

  const files = readdirSync(TELOS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();

  if (files.length === 0) {
    return "TELOS directory exists but contains no `.md` files.";
  }

  const lines = files.map((file) => {
    const filePath = path.join(TELOS_DIR, file);
    const stats = statSync(filePath);
    const sizeKb = (stats.size / 1024).toFixed(1);
    return `- \`${file}\` (${sizeKb} KB)`;
  });

  return `*TELOS context files* (${files.length} loaded from \`data/telos/\`):\n${lines.join("\n")}`;
}

/**
 * Read a specific TELOS file by name.
 * Accepts with or without .md extension.
 */
/**
 * Returns the current date/time formatted for injection into Claude prompts.
 */
export function getCurrentDatetime(): string {
  const now = new Date();
  const tz = getTimezone();
  const formatted = now.toLocaleString("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `Current date/time: ${formatted}`;
}

export function getTelosFile(name: string): string | null {
  if (!existsSync(TELOS_DIR)) return null;

  const filename = name.endsWith(".md") ? name : `${name}.md`;
  const filePath = path.join(TELOS_DIR, filename);

  if (!existsSync(filePath)) return null;

  return readFileSync(filePath, "utf-8");
}
