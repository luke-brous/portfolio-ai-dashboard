import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { count, eq } from "drizzle-orm";
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
 * Zod schema for POST /crm/nonprofits. Mirrors the column shape in
 * server/db/schema.ts exactly:
 *   - `name`             text NOT NULL
 *   - `contactEmail`     text (nullable in DB, so .optional() here)
 *   - `grantCycleDates`  text (nullable) — this column stores a single
 *                        free-form string ("2026-01 → 2026-12") rather
 *                        than separate start/end dates. The Zod schema
 *                        does NOT invent a richer date pair; passing
 *                        a user-supplied string straight through is
 *                        consistent with what CrmCard already renders.
 *   - `grantAmount`      real (nullable), positive when provided
 *   - `grantStatus`      text (nullable), free string — schema does
 *                        NOT constrain to an enum, so neither does this
 *
 * `.nullable().optional()` makes each field tolerant of both
 * `{ contactEmail: null }` and an omitted key, so the wire format
 * matches what the existing GET endpoint returns.
 */
const createNonprofitSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  contactEmail: z
    .string()
    .trim()
    .email("contactEmail must be a valid email")
    .nullable()
    .optional(),
  grantCycleDates: z
    .string()
    .trim()
    .min(1, "grantCycleDates cannot be blank when provided")
    .nullable()
    .optional(),
  grantAmount: z
    .number({ error: "grantAmount must be a number" })
    .positive("grantAmount must be positive")
    .finite("grantAmount must be finite")
    .nullable()
    .optional(),
  grantStatus: z
    .string()
    .trim()
    .min(1, "grantStatus cannot be blank when provided")
    .nullable()
    .optional(),
});

/**
 * PATCH variant: each field optional, but at least one must be present
 * (otherwise the request is a no-op and almost certainly a client bug).
 * `.refine` enforces the "≥ 1 field provided" rule after partial parsing.
 */
const updateNonprofitSchema = createNonprofitSchema
  .partial()
  .refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    { message: "At least one field must be provided" },
  );

/**
 * Validate a `:id` route param as a positive integer. Mirrors the helper
 * in server/routes/portfolio.ts so both routes fail invalid ids
 * consistently with a 400.
 */
function parseNonprofitId(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * POST /crm/nonprofits
 *
 * Creates a new nonprofit. Auth is enforced globally for the /crm
 * mount via `crm.use("*", requireSession)` above, so this handler
 * inherits it without re-declaring. 201 returns the inserted row,
 * 400 is the default zValidator response on schema failure.
 *
 * No dedup pre-check here: the `nonprofits` schema has no UNIQUE
 * constraint other than the implicit row id. If the user later adds
 * one (e.g. on `name`), add the pre-check at that time.
 */
crm.post(
  "/nonprofits",
  zValidator("json", createNonprofitSchema),
  async (c) => {
    const body = c.req.valid("json");
    try {
      const inserted = await db
        .insert(nonprofits)
        .values({
          name: body.name,
          contactEmail: body.contactEmail ?? null,
          grantCycleDates: body.grantCycleDates ?? null,
          grantAmount: body.grantAmount ?? null,
          grantStatus: body.grantStatus ?? null,
        })
        .returning()
        .all();
      const row = inserted[0];
      if (!row) {
        return c.json({ message: "Insert returned no row" }, 500);
      }
      logger.info({
        method: "POST",
        path: "/crm/nonprofits",
        name: row.name,
      });
      return c.json(row, 201);
    } catch (error) {
      logger.error(
        { err: error, path: c.req.path },
        "Error inserting nonprofit",
      );
      return c.json({ message: "Error inserting nonprofit" }, 500);
    }
  },
);

/**
 * PATCH /crm/nonprofits/:id
 *
 * Partial update. Only the fields the client provided are written —
 * Drizzle's `.set(partial)` naturally drops undefined keys, so we
 * never overwrite unspecified columns with null/zero. 404 if the row
 * doesn't exist, 400 if the body is empty or invalid.
 *
 * Auth: inherited from `crm.use("*", requireSession)` above.
 */
crm.patch(
  "/nonprofits/:id",
  zValidator("json", updateNonprofitSchema),
  async (c) => {
    const id = parseNonprofitId(c.req.param("id"));
    if (id === null) {
      return c.json({ message: "Invalid id parameter" }, 400);
    }

    const body = c.req.valid("json");

    try {
      const existing = await db
        .select()
        .from(nonprofits)
        .where(eq(nonprofits.id, id))
        .get();
      if (!existing) {
        return c.json({ message: "Nonprofit not found" }, 404);
      }

      // Build a partial update object that drops any undefined entries so
      // unspecified fields keep their existing column value. The Zod
      // schema's `.refine` already guarantees ≥ 1 field is provided.
      const patch: Partial<{
        name: string;
        contactEmail: string | null;
        grantCycleDates: string | null;
        grantAmount: number | null;
        grantStatus: string | null;
      }> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.contactEmail !== undefined) patch.contactEmail = body.contactEmail;
      if (body.grantCycleDates !== undefined)
        patch.grantCycleDates = body.grantCycleDates;
      if (body.grantAmount !== undefined) patch.grantAmount = body.grantAmount;
      if (body.grantStatus !== undefined) patch.grantStatus = body.grantStatus;

      const updated = await db
        .update(nonprofits)
        .set(patch)
        .where(eq(nonprofits.id, id))
        .returning()
        .all();
      const row = updated[0];
      if (!row) {
        // Race condition: row vanished between our select and our update.
        return c.json({ message: "Nonprofit not found" }, 404);
      }

      logger.info({
        method: "PATCH",
        path: "/crm/nonprofits/:id",
        id,
        fields: Object.keys(patch),
      });
      return c.json(row, 200);
    } catch (error) {
      logger.error(
        { err: error, path: c.req.path },
        "Error updating nonprofit",
      );
      return c.json({ message: "Error updating nonprofit" }, 500);
    }
  },
);

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
