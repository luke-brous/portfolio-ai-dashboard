import { Hono } from "hono";
// Import `db` from the standalone client module (not from `..`) so the route
// file does not pull server/index.ts into its module graph. server/index.ts
// mounts the routes, so reaching it back through `..` would be a circular
// import — see the comment in server/db/client.ts for the DAG rationale.
import { db } from "../db/client";
import { investments, priceSnapshots, newsItems } from "../db/schema";
import { asc, desc, eq, and, gte, sql } from "drizzle-orm";
import { logger } from "../logger";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getLastRun, isSyncInFlight } from "../lib/syncState";
import { requireSession } from "../lib/session";

const portfolio = new Hono();

/**
 * Zod schema for POST /portfolio/investments. Mirrors the column shape in
 * server/db/schema.ts:
 *   - `ticker`        text NOT NULL UNIQUE — trim + uppercase before insert
 *                     so the value matches the DB-level UNIQUE constraint
 *                     AND the case-insensitive dedup pre-check
 *   - `companyName`   text NOT NULL
 *   - `sector`        text (nullable on the column, but enforced required
 *                     here so we never insert a "blank sector" row in v1)
 *   - `shares`        real NOT NULL — must be positive, finite
 *
 * `percentOfAccount` is intentionally NOT accepted: it's a derived/portfolio-
 * relative value and the brief specifies out-of-scope rebalancing. Leaving
 * it null on insert matches the CrmCard read path ("—" placeholder).
 */
const createInvestmentSchema = z.object({
  ticker: z
    .string()
    .trim()
    .min(1, "ticker is required")
    .max(10, "ticker is too long")
    .transform((s) => s.toUpperCase()),
  companyName: z.string().trim().min(1, "companyName is required"),
  sector: z.string().trim().min(1, "sector is required"),
  shares: z
    .number({ error: "shares must be a number" })
    .positive("shares must be positive")
    .finite("shares must be finite"),
});

/**
 * POST /portfolio/investments
 *
 * Creates a new ticker holding. Auth is required (the existing `requireSession`
 * middleware is reused per the spec — no new auth wiring). 201 returns the
 * inserted row; 409 indicates a duplicate ticker caught by the pre-check
 * (case-insensitive, since we uppercase before insert and store); 400 is
 * the default zValidator response on schema failure.
 */
portfolio.post(
  "/investments",
  requireSession,
  zValidator("json", createInvestmentSchema),
  async (c) => {
    const body = c.req.valid("json");
    try {
      // Pre-check catches duplicates without round-tripping the DB constraint
      // error through the 500 envelope. The DB also enforces UNIQUE on
      // `ticker` at the column level — this pre-check is purely for a
      // tidier 409 message. `body.ticker` is already uppercased by the
      // Zod transform, so a simple `.where(eq(ticker, X))` is sufficient.
      const existing = await db
        .select()
        .from(investments)
        .where(eq(investments.ticker, body.ticker))
        .get();
      if (existing) {
        return c.json({ message: `Ticker ${body.ticker} already exists` }, 409);
      }
      const inserted = await db
        .insert(investments)
        .values({
          ticker: body.ticker,
          companyName: body.companyName,
          sector: body.sector,
          shares: body.shares,
        })
        .returning()
        .all();
      const row = inserted[0];
      if (!row) {
        return c.json({ message: "Insert returned no row" }, 500);
      }
      logger.info({
        method: "POST",
        path: "/portfolio/investments",
        ticker: row.ticker,
      });
      return c.json(row, 201);
    } catch (error) {
      logger.error(
        { err: error, path: c.req.path },
        "Error inserting investment",
      );
      return c.json({ message: "Error inserting investment" }, 500);
    }
  },
);

/**
 * Validate a `:id` route param (used by DELETE) as a positive integer.
 * Returns the parsed id, or null if the param is not a clean positive int.
 * A non-numeric / non-positive id is a client error (400), not a 404.
 */
function parseInvestmentId(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * DELETE /portfolio/investments/:id
 *
 * Hard-deletes an investment. Auth required.
 *
 * Cascade strategy: the schema declares `priceSnapshots.investment_id` and
 * `newsItems.investment_id` as FK references to `investments.id`, but WITHOUT
 * an `onDelete: "cascade"` clause. SQLite will therefore raise an FK
 * constraint failure on the `DELETE FROM investments` step if dependents
 * exist (subject to PRAGMA foreign_keys). To keep the deletion clean and
 * deterministic regardless of the per-connection FK pragma, we explicitly
 * delete the dependent rows first. No db.transaction is used because the
 * rest of the codebase does not use it (per the spec's "do not introduce
 * new patterns" constraint).
 */
portfolio.delete("/investments/:id", requireSession, async (c) => {
  const id = parseInvestmentId(c.req.param("id"));
  if (id === null) {
    return c.json({ message: "Invalid id parameter" }, 400);
  }

  try {
    const existing = await db
      .select()
      .from(investments)
      .where(eq(investments.id, id))
      .get();
    if (!existing) {
      return c.json({ message: "Investment not found" }, 404);
    }

    // Explicit cascade: delete snapshots and news items first so the
    // investment's FK references resolve cleanly even when the SQLite
    // session has PRAGMA foreign_keys = ON.
    await db
      .delete(priceSnapshots)
      .where(eq(priceSnapshots.investmentId, id))
      .run();
    await db.delete(newsItems).where(eq(newsItems.investmentId, id)).run();

    const deleted = await db
      .delete(investments)
      .where(eq(investments.id, id))
      .returning()
      .all();

    if (deleted.length === 0) {
      // Race condition: someone else deleted the row between our select
      // and our delete. Surface as 404 for parity with the earlier check.
      return c.json({ message: "Investment not found" }, 404);
    }

    logger.info({
      method: "DELETE",
      path: "/portfolio/investments/:id",
      id,
    });
    return c.body(null, 204);
  } catch (error) {
    logger.error({ err: error, path: c.req.path }, "Error deleting investment");
    return c.json({ message: "Error deleting investment" }, 500);
  }
});

/**
 * Mirror of the legacy `/sync/last-run` handler in server/index.ts
 * both paths read the same shared state from server/lib/syncState.ts.
 * Don't consolidate these into a single route without coordinating with ui / dashboard widget
 */
portfolio.get("/sync-status", (c) => {
  logger.info({
    method: c.req.method,
    path: c.req.path,
    count: 1,
  });
  return c.json({ lastRun: getLastRun(), inFlight: isSyncInFlight() });
});

const querySchema = z.object({
  ticker: z.string().trim().toUpperCase().optional(),
  days: z.coerce.number().int().min(1).max(30).default(7),
});

/**
 * Return the most recent news headlines for either the whole portfolio
 * or one ticker. Client can search by ticker for news on a specific investment
 */
portfolio.get("/news", zValidator("query", querySchema), async (c) => {
  const NEWS_LIMIT = 200;

  const { ticker } = c.req.valid("query");
  const days = c.req.valid("query").days;

  const conditions = [
    gte(newsItems.timestamp, new Date(Date.now() - days * 24 * 60 * 60 * 1000)),
  ];

  try {
    if (ticker) {
      conditions.push(eq(investments.ticker, ticker));
    }
    const rows = await db
      .select()
      .from(newsItems)
      .leftJoin(investments, eq(newsItems.investmentId, investments.id))
      .where(and(...conditions))
      .orderBy(desc(newsItems.timestamp))
      .limit(NEWS_LIMIT)
      .all();

    logger.info({
      method: "GET",
      path: "/portfolio/news",
      ticker: ticker ?? null,
      days,
      count: rows.length,
    });

    return c.json({
      ticker: ticker ?? null,
      days,
      count: rows.length,
      news: rows.map((row) => {
        const item = row.news_items;
        const investment = row.investments;
        return {
          id: item.id,
          investmentId: item.investmentId,
          ticker: investment?.ticker ?? null,
          headline: item.headline,
          url: item.url,
          source: item.source,
          summary: item.summary,
          timestamp: item.timestamp.toISOString(),
        };
      }),
    });
  } catch (error) {
    logger.error(`Error fetching news for ticker ${ticker}: ${String(error)}`);
    return c.json({ message: "Error fetching news" }, 500);
  }
});

// ---------- Types ------------------------------------------------------------

type Snapshot = typeof priceSnapshots.$inferSelect;

/**
 * Snapshot shape as returned to the client. Timestamps are serialised to ISO
 * strings because Hono's default JSON encoder does not handle `Date`.
 */
type SnapshotDTO = {
  price: number;
  change: number | null;
  percentChange: number | null;
  high: number | null;
  low: number | null;
  open: number | null;
  prevClose: number | null;
  timestamp: string;
};

type Delta = {
  price: number | null;
  percentChange: number | null;
};

const NULL_DELTA: Delta = {
  price: null,
  percentChange: null,
};

// ---------- Helpers ----------------------------------------------------------

function toSnapshotDTO(s: Snapshot): SnapshotDTO {
  return {
    price: s.price,
    change: s.change,
    percentChange: s.percentChange,
    high: s.high,
    low: s.low,
    open: s.open,
    prevClose: s.prevClose,
    // `s.timestamp` is a Date when rows come from drizzle's typed
    // builder, but a Unix-seconds number when rows come from a raw
    // sql call. Normalise so the route works for either one.
    timestamp: (s.timestamp instanceof Date
      ? s.timestamp
      : new Date(s.timestamp * 1000)
    ).toISOString(),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Day-over-day delta from a pair of snapshot rows.
 *
 * - Either side missing → both fields are null so the dashboard can
 *   still render the row, just without a delta ribbon.
 *
 * `delta.price` is the signed difference (latest − previous).
 * `delta.percentChange` is `((latest − previous) / previous) × 100`, rounded
 * to two decimals so the client never has to fight floating-point display
 * glitches.
 * */
function computeDelta(
  latest: Snapshot | null,
  previous: Snapshot | null,
): Delta {
  if (!latest || !previous || previous.price === 0) {
    return NULL_DELTA;
  }
  const priceDelta = latest.price - previous.price;
  return {
    price: priceDelta,
    percentChange: round2((priceDelta / previous.price) * 100),
  };
}

// ---------- GET /portfolio/investments --------------------------------------

/**
 * Returns every held investment with its two most-recent price snapshots and
 * a precomputed day-over-day delta, so the dashboard can render a price-move
 * row in a single round trip.
 */
portfolio.get("/investments", async (c) => {
  try {
    // Query 1: every held investment, sorted by ticker for stable display.
    const investmentsRows = await db
      .select()
      .from(investments)
      .orderBy(asc(investments.ticker))
      .all();

    if (investmentsRows.length === 0) {
      logger.info({
        method: "GET",
        path: "/portfolio/investments",
        count: 0,
      });
      return c.json({ investments: [] });
    }

    // Query 2: at most the 2 most-recent snapshots per held investment
    // (ROW_NUMBER() makes the per-group limit exact at the engine). Outer SELECT aliases each snake_case column to camelCase
    // because drizzle's raw `db.all(sql\`...\`)`, unlike the typed
    // builder, does NOT auto-translate column names — and downstream
    // reads use camelCase. The outer ORDER BY also preserves
    // (investment_id ASC, timestamp DESC) so the JS map (first row per
    // id = latest, second = previous) keeps working.
    const investmentIds = investmentsRows.map((row) => row.id);
    type RankedSnapshot = Snapshot & { rn: number };
    const recentSnapshots = (await db.all(sql`
      WITH ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY investment_id ORDER BY timestamp DESC
        ) AS rn
        FROM price_snapshots
        WHERE investment_id IN (${sql.join(investmentIds, sql`, `)})
      )
      SELECT
        id AS "id",
        investment_id AS "investmentId",
        price AS "price",
        change AS "change",
        percent_change AS "percentChange",
        high AS "high",
        low AS "low",
        open AS "open",
        prev_close AS "prevClose",
        timestamp AS "timestamp"
      FROM ranked
      WHERE rn <= 2
      ORDER BY investment_id ASC, timestamp DESC
    `)) as RankedSnapshot[];

    // build a Map<investmentId, { latest, previous }>.
    // Rows arrive in (investmentId ASC, timestamp DESC) order (Query 2's
    // guarantee), so the *first* row seen per id is `latest` and the
    // *second* is `previous`. Anything after the second is dropped.
    type PricePair = { latest: Snapshot; previous: Snapshot | null };
    const priceMap = new Map<number, PricePair>();
    for (const snapshot of recentSnapshots) {
      const entry = priceMap.get(snapshot.investmentId);
      if (!entry) {
        priceMap.set(snapshot.investmentId, {
          latest: snapshot,
          previous: null,
        });
        continue;
      }
      if (entry.previous === null) {
        entry.previous = snapshot;
      }
    }

    // attach snapshot pair + computed delta to each
    // investment, then return `{ investments: [...] }`.
    const response = investmentsRows.map((row) => {
      const entry = priceMap.get(row.id);
      const latest = entry?.latest ?? null;
      const previous = entry?.previous ?? null;
      return {
        id: row.id,
        ticker: row.ticker,
        companyName: row.companyName,
        sector: row.sector,
        shares: row.shares,
        percentOfAccount: row.percentOfAccount,
        latestSnapshot: latest ? toSnapshotDTO(latest) : null,
        previousSnapshot: previous ? toSnapshotDTO(previous) : null,
        delta: computeDelta(latest, previous),
      };
    });

    logger.info({
      method: "GET",
      path: "/portfolio/investments",
      count: response.length,
    });
    return c.json({ investments: response });
  } catch (error) {
    logger.error(`Error fetching portfolio investments: ${String(error)}`);
    return c.json({ message: "Error fetching investments" }, 500);
  }
});

export default portfolio;
