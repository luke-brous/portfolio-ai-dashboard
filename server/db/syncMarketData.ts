import "dotenv/config";
import { sql, and, eq, gte } from "drizzle-orm";
import { db } from "..";
import { investments, priceSnapshots } from "./schema";
import { getQuote, getCompanyNews } from "../lib/finnhub";
import { sleep } from "../lib/utils";
import type { FinnhubNewsItem } from "../types/finnhub";

//
//  Scheduled Finnhub sync.
//
// Pulls today's price snapshot and the last 7 days of company news for every
// ticker in the `investments` table. Inserts into `news_items` are
// idempotent on the composite `(finnhub_id, investment_id)` unique index in
// `schema.ts`, so repeated runs are safe across all 45 held tickers.
//
// This module deliberately does NOT auto-run on import. The caller must
// invoke `syncMarketData()` explicitly and is responsible for scheduling.
//
// Each iteration makes 2 Finnhub calls (quote and company-news). The 2 000 ms
// gap between iterations is the bare floor (60 req/min sliding window); real
// network roundtrip latency keeps the effective rate comfortably below
// Finnhub's free-tier 60 req/min ceiling.
const SLEEP_MS = 2000;

export async function syncMarketData(): Promise<{
  tickersProcessed: number;
  tickersFailed: number;
  tickersSkipped: number;
}> {
  const rows = await db.select().from(investments).all();
  const tickers = rows.map((r) => ({ id: r.id, ticker: r.ticker }));

  if (tickers.length === 0) {
    console.log(
      "[syncMarketData] No tickers found in `investments`, nothing to sync.",
    );
    return { tickersProcessed: 0, tickersFailed: 0, tickersSkipped: 0 };
  }

  let tickersProcessed = 0;
  let tickersFailed = 0;
  let tickersSkipped = 0;
  console.log(`[syncMarketData] Starting sync for ${tickers.length} tickers.`);

  // Start-of-today in server local time. Any snapshot whose timestamp is at or
  // after this counts as "already synced today" and is skipped on re-runs.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // 7-day rolling window so weekends / market holidays are still captured.
  const today = new Date();
  const fromDate = new Date(today);
  fromDate.setDate(fromDate.getDate() - 7);
  const toStr = today.toISOString().slice(0, 10);
  const fromStr = fromDate.toISOString().slice(0, 10);

  const tickersToProcess = tickers;
  console.log(
    `[syncMarketData] Processing ${tickersToProcess.length} ticker(s).`,
  );

  for (const { id: investmentId, ticker } of tickersToProcess) {
    try {
      //  Same-day guard: skip if we already have a snapshot since midnight
      const existing = await db
        .select({ id: priceSnapshots.id })
        .from(priceSnapshots)
        .where(
          and(
            eq(priceSnapshots.investmentId, investmentId),
            gte(priceSnapshots.timestamp, todayStart),
          ),
        )
        .limit(1)
        .all();
      if (existing.length > 0) {
        console.log(
          `[syncMarketData] ${ticker}: snapshot already exists for today, skipping.`,
        );
        tickersSkipped++;
        tickersProcessed++;
        // No throttle here, skipped iterations don't hit Finnhub, so they
        // can't push us over the 60 req/min ceiling. A fully-cached boot
        // should finish in seconds, not minutes.
        continue;
      }

      //  Quote (one row per ticker per day)
      const quote = await getQuote(ticker);
      // Reject all-zero quotes too, that's Finnhub's signal for an unrecognized
      // ticker (`Number.isFinite(0)` is true).
      if (!Number.isFinite(quote?.c) || quote.c <= 0) {
        throw new Error(`Invalid quote from Finnhub: ${JSON.stringify(quote)}`);
      }
      await db.insert(priceSnapshots).values({
        investmentId,
        price: quote.c,
        change: quote.d,
        percentChange: quote.dp,
        high: quote.h,
        low: quote.l,
        open: quote.o,
        prevClose: quote.pc,
        timestamp: new Date(),
      });

      //  News (last 7 days; idempotent on finnhub_id)
      const news = await getCompanyNews(ticker, fromStr, toStr);
      const validNews = (news ?? []).filter(
        (n): n is FinnhubNewsItem =>
          Number.isFinite(n?.datetime) &&
          n.datetime > 0 &&
          typeof n?.headline === "string" &&
          n.headline.length > 0 &&
          !!n?.id,
      );
      if (validNews.length > 0) {
        // Use SQLite-native `INSERT OR IGNORE` instead of Drizzle's typed
        // builder + onConflictDoNothing. The typed builder emits an explicit
        // `id` column with a NULL placeholder that interacts poorly with the
        // current bun-sqlite driver; the raw form is unambiguous and simpler.
        // `n.datetime` is already Unix seconds, which matches the column's
        // `mode: 'timestamp'` integer storage.
        for (const n of validNews) {
          await db.run(sql`
            INSERT OR IGNORE INTO news_items (
              investment_id, news_category, headline, finnhub_id,
              source, summary, url, timestamp
            ) VALUES (
              ${investmentId},
              ${n.category ?? null},
              ${n.headline},
              ${n.id},
              ${n.source ?? null},
              ${n.summary ?? null},
              ${n.url ?? null},
              ${n.datetime}
            )
          `);
        }
      }

      console.log(
        `[syncMarketData] ${ticker}: quote stored, ${validNews.length} news items processed.`,
      );
      tickersProcessed++;
    } catch (err) {
      console.error(
        `[syncMarketData] ${ticker} failed:`,
        err instanceof Error ? err.message : String(err),
      );
      tickersFailed++;
      // Continue with the next ticker, one bad symbol must not kill the job.
    }

    // - Throttling: keep total below Finnhub's 60 req/min ceiling -
    await sleep(SLEEP_MS);
  }

  console.log(
    `[syncMarketData] Sync complete, ${tickersProcessed} ok, ${tickersFailed} failed, ${tickersSkipped} skipped.`,
  );
  return { tickersProcessed, tickersFailed, tickersSkipped };
}

// CLI entrypoint:  `bun server/db/syncMarketData.ts`
if (import.meta.main) {
  await syncMarketData();
  process.exit(0);
}
