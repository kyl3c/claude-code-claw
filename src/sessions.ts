import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

const SESSIONS_PATH = 'data/sessions.json';

let sessions: Record<string, string> = {};

export function loadSessions(): void {
  if (existsSync(SESSIONS_PATH)) {
    sessions = JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8'));
    console.log(`Loaded ${Object.keys(sessions).length} session(s)`);
  } else {
    mkdirSync(dirname(SESSIONS_PATH), { recursive: true });
    persist();
    console.log('Created empty sessions file');
  }
}

export function getSession(spaceName: string): string | undefined {
  return sessions[spaceName];
}

export function setSession(spaceName: string, sessionId: string): void {
  sessions[spaceName] = sessionId;
  persist();
}

export function deleteSession(spaceName: string): void {
  delete sessions[spaceName];
  persist();
}

function persist(): void {
  writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2));
}
