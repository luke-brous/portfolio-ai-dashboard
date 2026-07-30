import { Hono } from "hono";
import { summarizeText } from "../lib/gemini";
import { sleep } from "../lib/utils";
import { requireSession } from "../lib/session";
import { logger } from "../logger";
import * as z from "zod";
import { zValidator } from "@hono/zod-validator";

const summarize = new Hono();

// Auth for the whole mount.
//
// This route spends money and wall-clock time on someone else's behalf: it
// calls Gemini once per email on the server's API key, sleeping between calls.
// Unauthenticated, one request could drain the daily free-tier quota and hold
// a connection open for as long as it liked. It is only ever called from a
// logged-in Mail Brief session, so requiring a session costs nothing.
summarize.use("*", requireSession);

// Per-email caps. `body` is the field that actually reaches Gemini, so it
// carries the tighter bound; the rest are Gmail header strings and only need
// to be kept from being unbounded.
const MAX_BODY_CHARS = 50_000;
const MAX_HEADER_CHARS = 2_000;

// Ceiling on emails per request. At one Gemini call per email, this bounds
// both the token spend and the request's lifetime. The client summarises one
// label/date window at a time, comfortably under this.
const MAX_EMAILS_PER_REQUEST = 50;

const emailSchema = z.object({
  id: z.string().max(MAX_HEADER_CHARS),
  subject: z.string().max(MAX_HEADER_CHARS).optional(),
  from: z.string().max(MAX_HEADER_CHARS).optional(),
  date: z.string().max(MAX_HEADER_CHARS).optional(),
  body: z.string().max(MAX_BODY_CHARS).optional(),
  snippet: z.string().max(MAX_BODY_CHARS).optional(),
});

const requestBodySchema = z.object({
  emails: z
    .array(emailSchema)
    .max(
      MAX_EMAILS_PER_REQUEST,
      `at most ${MAX_EMAILS_PER_REQUEST} emails per request`,
    ),
});

// Gemini free-tier pacing. Deliberately NOT applied after the final email —
// the old unconditional sleep made every request pay one pointless 8s stall,
// and across a batch that idle time is most of what holds the connection open.
const GEMINI_THROTTLE_MS = 8000;

// accept a batch of emails (id, subject, from, body) in the
// request body, send each to Gemini, and return structured summaries.
summarize.post("/", zValidator("json", requestBodySchema), async (c) => {
  // Zod already guarantees `emails` is a bounded array, so the old
  // defensive Array.isArray re-check was unreachable and is gone.
  const { emails } = c.req.valid("json");

  const summaries = [];

  for (const [index, email] of emails.entries()) {
    try {
      const summaryText = await summarizeText(
        email.body || email.snippet || "",
      );
      summaries.push({
        id: email.id,
        subject: email.subject || "No Subject",
        from: email.from,
        date: email.date,
        summary: summaryText,
      });

      if (index < emails.length - 1) {
        await sleep(GEMINI_THROTTLE_MS);
      }
    } catch (error) {
      // Pino rather than console.error so the failure lands in the same
      // structured stream as the rest of the server, and so the error is
      // serialised rather than stringified (email bodies are sensitive).
      logger.error(
        { err: error, emailId: email.id, path: c.req.path },
        "Error summarizing email",
      );
    }
  }

  logger.info({
    method: "POST",
    path: "/summarize",
    requested: emails.length,
    summarized: summaries.length,
  });

  return c.json({ summaries });
});

export default summarize;
