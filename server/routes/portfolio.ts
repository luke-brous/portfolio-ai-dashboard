import { Hono } from "hono";
// Import `db` from the standalone client module (not from `..`) so the route
// file does not pull server/index.ts into its module graph. server/index.ts
// mounts the routes, so reaching it back through `..` would be a circular
// import — see the comment in server/db/client.ts for the DAG rationale.
import { db } from "../db/client";
import { investments, priceSnapshots, newsItems } from "../db/schema";
import { asc, desc, eq, and, gte, inArray } from "drizzle-orm";
import { logger } from "../logger";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getLastRun, isSyncInFlight } from "../lib/syncState";

const portfolio = new Hono();

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
  absoluteChange: number | null;
};

const NULL_DELTA: Delta = {
  price: null,
  percentChange: null,
  absoluteChange: null,
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
    timestamp: s.timestamp.toISOString(),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Day-over-day delta from a pair of snapshot rows.
 *
 * - Either side missing → all three fields are null so the dashboard can
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
    absoluteChange: Math.abs(priceDelta),
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

    // Query 2, up to N = 2 × tickers.length most-recent rows for the held
    // tickers only, ordered (investmentId ASC, timestamp DESC). The order
    // + the JS walk below give us "first two per group" without window
    // functions, and the cap keeps the query bounded as the portfolio
    // grows.
    const investmentIds = investmentsRows.map((row) => row.id);
    const recentSnapshots = await db
      .select()
      .from(priceSnapshots)
      .where(inArray(priceSnapshots.investmentId, investmentIds))
      .orderBy(asc(priceSnapshots.investmentId), desc(priceSnapshots.timestamp))
      .limit(investmentIds.length * 2)
      .all();

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
