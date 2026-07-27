// Minimal in-memory session store, keyed by a random session id
// stored in a cookie. Good enough for a personal-use tool.
// A production version would use Redis or a database instead,
// since this resets whenever the server restarts.

import type { SessionData } from "../types/session";
import { google } from "googleapis";
import { getOAuthClient } from "./google-client";
import { getCookie } from "hono/cookie";
import { Context, Next } from "hono";

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

// Legacy helper for routes that need to access the Gmail API client.

export async function requireSession(c: Context, next: Next) {
  // fix any type
  const sessionId = getCookie(c, "sessionId") ?? getCookie(c, "session_id");

  if (!sessionId) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const session = getSession(sessionId);

  if (!session) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const oauthClient = getOAuthClient();
  oauthClient.setCredentials(session.tokens);

  c.set("gmailClient", google.gmail({ version: "v1", auth: oauthClient }));

  await next();
}
