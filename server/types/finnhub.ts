/**
 * Finnhub API response shapes.
 *
 * Moved out of `server/lib/finnhub.ts` and `server/db/syncMarketData.ts` so
 * both modules can import the same definitions (and unit tests can assert
 * against them) without a circular `lib ↔ db` import.
 *
 * Field names mirror Finnhub's upstream docs (kept lowercase to match the
 * wire format). See https://finnhub.io/docs/api.
 */

export interface FinnhubQuote {
  /** Current price. */
  c: number;
  /** Change (absolute, not percent). */
  d: number;
  /** Percent change. */
  dp: number;
  /** High price of the day. */
  h: number;
  /** Low price of the day. */
  l: number;
  /** Open price of the day. */
  o: number;
  /** Previous close. */
  pc: number;
  /** Unix timestamp (seconds). */
  t: number;
}

export interface FinnhubNewsItem {
  id: number;
  /**
   * Unix seconds. Already matches the `mode: 'timestamp'` integer column on
   * `news_items`, so we store it as-is without multiplying by 1000.
   */
  datetime: number;
  headline: string;
  source: string;
  summary: string;
  url: string;
  category: string;
}
