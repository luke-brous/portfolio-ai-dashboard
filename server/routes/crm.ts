import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { count } from "drizzle-orm";
import { db } from "../db/client";
import { nonprofits } from "../db/schema";
import { requireSession } from "../lib/session";
import { logger } from "../logger";

// CRM (Foundation Management) routes.
//
// v1 surface is read-only: a single `GET /crm/nonprofits` that powers
// the directory page. Add/edit/delete will land in a future plan; reports
// / Gmail ingest / Gemini summaries are out of scope so attention can
// refocus on the Advisor tab.

const crm = new Hono();

crm.use("*", requireSession);

// Hard upper bound protects against an info-disclosure risk: an
// authenticated user dumping the whole partner roster by leaving the
// query params empty. Default 50, max 100. `offset` is 0-based.
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /crm/nonprofits
 *
 * Returns one page of nonprofits ordered by name ASC plus a `total`
 * count of the entire table so the client can paginate without a
 * second request.
 */
crm.get("/nonprofits", zValidator("query", listQuerySchema), async (c) => {
  const { limit, offset } = c.req.valid("query");

  try {
    const rows = db
      .select()
      .from(nonprofits)
      .orderBy(nonprofits.name)
      .limit(limit)
      .offset(offset)
      .all();

    const totalRow = db.select({ c: count() }).from(nonprofits).get();
    const total = totalRow?.c ?? 0;

    return c.json({
      count: rows.length,
      total,
      limit,
      offset,
      nonprofits: rows,
    });
  } catch (error) {
    // Pino structured logging: lets the serializer escape the error
    // object rather than coercing it through `String(error)`, which
    // can paste raw SQL / parameter values (incl. nonprofit names)
    // into the log line.
    logger.error(
      { err: error, path: c.req.path },
      "Error fetching from nonprofits table",
    );
    return c.json({ message: "Error fetching nonprofits" }, 500);
  }
});

export default crm;
