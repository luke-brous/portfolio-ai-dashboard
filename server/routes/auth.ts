import { Hono } from "hono";
import crypto from "crypto";
import { getCookie, setCookie } from "hono/cookie";
import { getOAuthClient } from "../lib/google-client";
import { createSession, getSession, deleteSession } from "../lib/session";
import * as z from "zod";
import { zValidator } from "@hono/zod-validator";

const auth = new Hono();

// redirect the user to Google's consent screen.
// build the auth URL with getOAuthClient().generateAuthUrl({
//   access_type: "offline",
//   scope: ["https://www.googleapis.com/auth/gmail.readonly"],
// }) and redirect to it.
auth.get("/login", (c) => {
  const url = getOAuthClient().generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
  });
  return c.redirect(url);
});

// Google redirects back here with a `code` query param.
// exchange the code for tokens via oauthClient.getToken(code),
// then store the tokens in a session (see lib/session.ts) and set a
// session cookie before redirecting the user back to the frontend.

// define schema
const callbackSchema = z.object({
  code: z.string(),
});

auth.get("/callback", zValidator("query", callbackSchema), async (c) => {
  const { code } = c.req.valid("query");

  if (!code) {
    return c.text("Missing code query parameter", 400);
  }

  try {
    // Exchange the code for tokens
    const oauthClient = getOAuthClient();
    const tokenResponse = await oauthClient.getToken(code);
    const tokens = tokenResponse.tokens;

    // Store the tokens in a session
    const sessionId = crypto.randomUUID();
    createSession(sessionId, {
      tokens: {
        access_token: tokens.access_token || "",
        refresh_token: tokens.refresh_token || undefined,
        expiry_date: tokens.expiry_date || undefined,
      },
    });

    // Set a session cookie
    setCookie(c, "sessionId", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
      maxAge: 60 * 60 * 24 * 7, // 1 week
    });

    // Redirect back to the frontend
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    return c.redirect(`${frontendUrl}/landing`);
  } catch (error) {
    console.error("Error exchanging code for tokens:", error);
    return c.text("Error exchanging code for tokens", 500);
  }
});

auth.get("/me", async (c) => {
  const sessionId = getCookie(c, "sessionId");

  if (!sessionId) {
    return c.json({ authed: false });
  }

  const session = getSession(sessionId);

  if (session) {
    return c.json({ authed: true });
  } else {
    return c.json({ authed: false });
  }
});

auth.get("/logout", (c) => {
  const sessionId = getCookie(c, "sessionId");

  if (sessionId) {
    // Delete the session from your session store
    deleteSession(sessionId);
  }

  // Clear session cookie
  setCookie(c, "sessionId", "", {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    maxAge: 0, // Expire the cookie immediately
    path: "/",
  });
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  return c.redirect(`${frontendUrl}/`);
});

export default auth;
