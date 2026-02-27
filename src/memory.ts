import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import path from "path";

const MEMORY_DIR = "data/memory";
const DAILY_DIR = path.join(MEMORY_DIR, "daily");
const MAX_CONTEXT_CHARS = 6000;
const DAILY_FULL_DAYS = 7;
const DAILY_HEADINGS_DAYS = 30;

// Evergreen files always loaded in full
const EVERGREEN_FILES = [
  "profile.md",
  "workflows.md",
  "facts.md",
  "preferences.md",
  "decisions.md",
  "secrets.md",
];

export interface MemorySearchResult {
  file: string;
  snippet: string;
  score: number;
}

/**
 * Load all memory files with tiered temporal loading.
 * Evergreen files: always full. Daily logs: full (7d), headings (30d), skip (older).
 */
export function loadMemoryContext(): string {
  if (!existsSync(MEMORY_DIR)) return "";

  const sections: string[] = [];
  let totalChars = 0;

  // Load evergreen files
  for (const file of EVERGREEN_FILES) {
    const filePath = path.join(MEMORY_DIR, file);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf-8").trim();
    if (!content || isHeaderOnly(content)) continue;
    sections.push(content);
    totalChars += content.length;
  }

  // Load daily logs with temporal tiering
  if (existsSync(DAILY_DIR)) {
    const dailyFiles = readdirSync(DAILY_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse(); // newest first

    const now = new Date();

    for (const file of dailyFiles) {
      const dateStr = file.replace(".md", "");
      const fileDate = new Date(dateStr + "T00:00:00");
      const ageDays = Math.floor(
        (now.getTime() - fileDate.getTime()) / (1000 * 60 * 60 * 24),
      );

      const filePath = path.join(DAILY_DIR, file);
      const content = readFileSync(filePath, "utf-8").trim();
      if (!content || isHeaderOnly(content)) continue;

      if (ageDays <= DAILY_FULL_DAYS) {
        // Recent: inject full content
        if (totalChars + content.length > MAX_CONTEXT_CHARS) break;
        sections.push(`## Daily Log: ${dateStr}\n${content}`);
        totalChars += content.length;
      } else if (ageDays <= DAILY_HEADINGS_DAYS) {
        // Medium age: inject headings only
        const headings = extractHeadings(content);
        if (headings) {
          const summary = `## Daily Log: ${dateStr} (summary)\n${headings}`;
          if (totalChars + summary.length > MAX_CONTEXT_CHARS) break;
          sections.push(summary);
          totalChars += summary.length;
        }
      }
      // 30+ days: skip injection entirely
    }
  }

  if (sections.length === 0) return "";

  return `<memory-context>\n${sections.join("\n\n")}\n</memory-context>`;
}

/**
 * Search all memory files for matching content.
 */
export function searchMemory(
  query: string,
  maxResults: number = 3,
): MemorySearchResult[] {
  if (!existsSync(MEMORY_DIR)) return [];

  const queryWords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (queryWords.length === 0) return [];

  const results: MemorySearchResult[] = [];

  // Search evergreen files
  for (const file of EVERGREEN_FILES) {
    const filePath = path.join(MEMORY_DIR, file);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf-8");
    scoreChunks(content, file, queryWords, results);
  }

  // Search daily logs
  if (existsSync(DAILY_DIR)) {
    const dailyFiles = readdirSync(DAILY_DIR).filter((f) =>
      f.endsWith(".md"),
    );
    for (const file of dailyFiles) {
      const filePath = path.join(DAILY_DIR, file);
      const content = readFileSync(filePath, "utf-8");
      scoreChunks(content, `daily/${file}`, queryWords, results);
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

/**
 * List all memory files with sizes.
 */
export function listMemoryFiles(): string {
  if (!existsSync(MEMORY_DIR)) {
    return "No memory directory found at `data/memory/`.";
  }

  const lines: string[] = [];

  // Evergreen files
  for (const file of EVERGREEN_FILES) {
    const filePath = path.join(MEMORY_DIR, file);
    if (!existsSync(filePath)) continue;
    const stats = statSync(filePath);
    const sizeKb = (stats.size / 1024).toFixed(1);
    lines.push(`- \`${file}\` (${sizeKb} KB)`);
  }

  // Daily logs
  if (existsSync(DAILY_DIR)) {
    const dailyFiles = readdirSync(DAILY_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse();
    if (dailyFiles.length > 0) {
      lines.push("");
      lines.push(`*Daily logs* (${dailyFiles.length} files in \`daily/\`):`);
      // Show last 5
      for (const file of dailyFiles.slice(0, 5)) {
        const filePath = path.join(DAILY_DIR, file);
        const stats = statSync(filePath);
        const sizeKb = (stats.size / 1024).toFixed(1);
        lines.push(`- \`daily/${file}\` (${sizeKb} KB)`);
      }
      if (dailyFiles.length > 5) {
        lines.push(`- ... and ${dailyFiles.length - 5} more`);
      }
    }
  }

  if (lines.length === 0) {
    return "Memory directory exists but contains no files.";
  }

  return `*Memory files* (\`data/memory/\`):\n${lines.join("\n")}`;
}

// --- Helpers ---

function isHeaderOnly(content: string): boolean {
  const stripped = content
    .replace(/^#+\s.*$/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .trim();
  return !stripped;
}

function extractHeadings(content: string): string | null {
  const headings = content
    .split("\n")
    .filter((line) => /^#{1,3}\s/.test(line) || /^- /.test(line));
  return headings.length > 0 ? headings.join("\n") : null;
}

function scoreChunks(
  content: string,
  file: string,
  queryWords: string[],
  results: MemorySearchResult[],
): void {
  // Split into chunks at heading or list-item boundaries
  const chunks = content.split(/(?=^## |^### |^- )/m).filter((c) => c.trim());

  for (const chunk of chunks) {
    const lower = chunk.toLowerCase();
    let matches = 0;
    for (const word of queryWords) {
      if (lower.includes(word)) matches++;
    }
    if (matches === 0) continue;

    const score = matches / queryWords.length;
    const snippet =
      chunk.trim().length > 200
        ? chunk.trim().slice(0, 200) + "..."
        : chunk.trim();

    results.push({ file, snippet, score });
  }
}
