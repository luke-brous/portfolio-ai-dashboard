// Minimal in-memory session store, keyed by a random session id
// stored in a cookie. Good enough for a personal-use tool.
// A production version would use Redis or a database instead,
// since this resets whenever the server restarts.

import type { SessionData } from "../types/session";

const sessions = new Map<string, SessionData>();

export function createSession(id: string, data: SessionData) {
  sessions.set(id, data);
}

export function getSession(id: string): SessionData | undefined {
  return sessions.get(id);
}

export function deleteSession(id: string) {
  sessions.delete(id);
}
