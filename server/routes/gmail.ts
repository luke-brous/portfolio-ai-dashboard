import { google } from "googleapis";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { getOAuthClient } from "../lib/google-client";
import { getSession } from "../lib/session";
import { extractBody, buildGmailQuery } from "../lib/gmail";
import * as z from 'zod'
import { zValidator } from '@hono/zod-validator'

type GmailClient = ReturnType<typeof google.gmail>;

const gmail = new Hono<{ Variables: { gmailClient: GmailClient } }>();

const gmailSchema = z.object({
  label: z.string(),
  after: z.string().optional(),
  before: z.string().optional(),
})



gmail.use("*", async (c, next) => {
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
});

// list the user's Gmail labels so the frontend can populate
// the label picker dropdown.
gmail.get("/labels",  async (c) => {
  const client = c.get("gmailClient");
  const response = await client.users.labels.list({ userId: "me" });
  return c.json({ labels: response.data.labels ?? [] });
});

// given a label id + start/end date query params, list matching
// messages, fetch each one's full content, and decode the body.
// Gmail search query syntax: `label:<name> after:<date> before:<date>`
gmail.get("/messages", zValidator('query', gmailSchema), async (c) => {
  const client = c.get("gmailClient");
  const label = c.req.query("label");
  const after = c.req.query("after");
  const before = c.req.query("before");

  const q = buildGmailQuery({ after, before });

  const searchResponse = await client.users.messages.list({
    userId: "me",
    q: q,
    labelIds: label ? [label] : undefined,
    maxResults: 20,
  });

  const messages = searchResponse.data.messages ?? [];

  // fetch full message data for each message id
  const fetched = await Promise.all(
    messages.map((m) =>
      client.users.messages.get({ userId: "me", id: m.id!, format: "full" })
    )
  );

  // extract the body from each fetched message
  const processedMessages = fetched.map((r) => {
    const payload = r.data.payload;
    if (!payload) return r.data;

    const headers = payload.headers || [];

    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;

    return {
      ...r.data,
      from: getHeader("From") || "",
      subject: getHeader("Subject") || "",
      date: getHeader("Date") || "",
      body: extractBody(payload),
    };
  });

  return c.json({
    label,
    after,
    before,
    messageCount: messages.length,
    messages: processedMessages,
  });
});

export default gmail;
