// Session store, keyed by a random session id stored in a cookie.
//
// The mapping itself lives in a small JSON file on disk via
// `./sessionStore`. We previously held it in a module-level Map; that
// was fine while the server never restarted, but `--watch` / Bun HMR
// / dev restarts would silently drop every active session because
// `requireSession` couldn't find the session id in the freshly-emptied
// map even though the browser still held a valid cookie.
//
// Persisting to disk keeps the same `createSession` / `getSession` /
// `deleteSession` API so existing tests' `mock.module("../../lib/session", ...)`
// keeps working without modification.

import { createSession, deleteSession, getSession } from "./sessionStore";
import { google } from "googleapis";
import { getOAuthClient } from "./google-client";
import { getCookie } from "hono/cookie";
import { Context, Next } from "hono";

// Re-export the helpers so existing `import { createSession } from "../lib/session"`
// call sites continue to compile. The runtime is now file-backed.
export { createSession, deleteSession, getSession };

// Legacy helper for routes that need to access the Gmail API client.
//
// 401 ladder:
//   1. No cookie present ─────────────────────→ "Not authenticated"
//   2. Cookie present, no session in store ───→ "Not authenticated"
//   3. Session present, past `expiresAt` ─────→ deleteSession + "Session expired"
//   4. Otherwise ─────────────────────────────→ next()

export async function requireSession(c: Context, next: Next) {
  const sessionId = getCookie(c, "sessionId") ?? getCookie(c, "session_id");

  if (!sessionId) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const session = getSession(sessionId);

  if (!session) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  if (Date.now() > session.expiresAt) {
    // Eagerly drop the dead session so the next request that reuses
    // the cookie hits the "no session in store" branch instead of
    // re-walking the expiry check. Return the SAME 401 message as
    // the no-cookie / unknown-cookie branches so an attacker probing
    // with a stolen cookie can't distinguish "session once existed"
    // from "session never existed".
    deleteSession(sessionId);
    return c.json({ error: "Not authenticated" }, 401);
  }

  const oauthClient = getOAuthClient();
  oauthClient.setCredentials(session.tokens);

  c.set("gmailClient", google.gmail({ version: "v1", auth: oauthClient }));

  await next();
}
