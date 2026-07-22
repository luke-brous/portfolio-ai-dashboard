import { Hono } from "hono";
import { summarizeText } from "../lib/gemini";
import { sleep } from "../lib/utils";
import * as z from "zod";
import { zValidator } from "@hono/zod-validator";

const summarize = new Hono();

const emailSchema = z.object({
  id: z.string(),
  subject: z.string().optional(),
  from: z.string().optional(),
  date: z.string().optional(),
  body: z.string().optional(),
  snippet: z.string().optional(),
});

const requestBodySchema = z.object({
  emails: z.array(emailSchema),
});

// accept a batch of emails (id, subject, from, body) in the
// request body, send each (or a combined prompt) to Gemini, and
// return structured summaries.
summarize.post("/", zValidator("json", requestBodySchema), async (c) => {
  const body = await c.req.valid("json");

  if (!body.emails || !Array.isArray(body.emails)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const summaries = [];

  for (const email of body.emails) {
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

      await sleep(8000); // 8 second delay between requests
    } catch (error) {
      console.error(`Error summarizing email ${email.id}:`, error);
    }
  }

  return c.json({ summaries });
});

export default summarize;
