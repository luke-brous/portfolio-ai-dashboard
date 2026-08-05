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

import {
  createSession,
  deleteSession,
  getSession,
  updateSessionTokens,
} from "./sessionStore";
import { google } from "googleapis";
import { getOAuthClient } from "./google-client";
import { getCookie } from "hono/cookie";
import { Context, Next } from "hono";

// Re-export the helpers so existing `import { createSession } from "../lib/session"`
// call sites continue to compile. The runtime is now file-backed.
export { createSession, deleteSession, getSession, updateSessionTokens };

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

  // Persist credentials that Google's client refreshes for us.
  //
  // The client renews an expired access token transparently, but only on the
  // instance that did it — and this builds a new instance every request. With
  // nothing written back, every request re-refreshed, and a rotated refresh
  // token was lost outright, which killed the session for good. Sessions then
  // went dead roughly an hour after login and every Gmail call started
  // failing (a 500 from /gmail/labels, a 502 from the CRM sync).
  //
  // The event fires only on an actual refresh, so this costs nothing on the
  // common path.
  oauthClient.on("tokens", (refreshed) => {
    updateSessionTokens(sessionId, {
      access_token: refreshed.access_token ?? undefined,
      refresh_token: refreshed.refresh_token ?? undefined,
      expiry_date: refreshed.expiry_date ?? undefined,
    });
  });

  c.set("gmailClient", google.gmail({ version: "v1", auth: oauthClient }));

  await next();
}
