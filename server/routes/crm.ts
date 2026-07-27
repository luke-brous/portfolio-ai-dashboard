import { Hono } from "hono";
import { google } from "googleapis";
import { db } from "../db/client";
import { nonprofits, reports } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { logger } from "../logger";
import { requireSession } from "../lib/session";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

type GmailClient = ReturnType<typeof google.gmail>;

const crm = new Hono<{ Variables: { gmailClient: GmailClient } }>();

// CRM (Customer Relationship Management) routes for managing nonprofit organizations and their reports.

crm.use("*", requireSession);

const paramsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * GET /crm/nonprofits
 *
 * Returns every nonprofit org in alphabetical order.
 */
crm.get("/nonprofits", async (c) => {
  try {
    const rows = db.select().from(nonprofits).orderBy(nonprofits.name).all();

    return c.json({
      count: rows.length,
      nonprofits: rows,
    });
  } catch (error) {
    logger.error(`Error fetching from nonprofits table: ${String(error)}`);
    return c.json({ message: "Error fetching nonprofits" }, 500);
  }
});

/**
 * GET /crm/nonprofits/:id/reports
 *
 * Returns every report for one nonprofit, newest first. 404 if the
 * nonprofit doesn't exist; 200 with `{ count: 0, reports: [] }` if it
 * exists but has no reports yet.
 */
crm.get(
  "/nonprofits/:id/reports",
  zValidator("param", paramsSchema),
  async (c) => {
    const { id } = c.req.valid("param");

    try {
      const nonprofitRows = db
        .select()
        .from(nonprofits)
        .where(eq(nonprofits.id, id))
        .limit(1)
        .all();

      if (nonprofitRows.length === 0) {
        return c.json({ error: "Nonprofit not found" }, 404);
      }

      const reportRows = db
        .select()
        .from(reports)
        .where(eq(reports.nonprofitId, id))
        .orderBy(desc(reports.date))
        .all();

      const reportDTOs = reportRows.map((r) => ({
        id: r.id,
        nonprofitId: r.nonprofitId,
        messageId: r.messageId,
        summary: r.summary,
        date: r.date.toISOString(),
      }));

      return c.json({
        nonprofitId: id,
        count: reportDTOs.length,
        reports: reportDTOs,
      });
    } catch (error) {
      logger.error(
        `Error fetching reports for nonprofit ${id}: ${String(error)}`,
      );
      return c.json({ message: "Error fetching reports" }, 500);
    }
  },
);

// Placeholder endpoint for §6.3 — intentionally returns 501 so a client
// hitting it before it's implemented gets a clear "not yet built"
// signal instead of 200 + empty body.
crm.post("/nonprofits/:id/reports/generate", (c) =>
  c.json({ message: "Not implemented" }, 501),
);

export default crm;
