import "dotenv/config";
import type { FinnhubNewsItem, FinnhubQuote } from "../types/finnhub";
import { withRateLimit, FinnhubRateLimitError } from "./rateLimit";

const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";

/**
 * Module-local fetch indirection.
 *
 * Production code calls `globalThis.fetch` and never touches the Finnhub API
 * outside of this module. Tests can swap the fetcher via
 * `__setFetchForTests(...)` to drive the HTTP-error and malformed-JSON
 * branches of `getQuote` / `getCompanyNews` without monkey-patching
 * `globalThis.fetch` (which leaks across all tests in the same Bun process).
 *
 * The signature is deliberately loose (just `string`) to dodge Bun's static
 * `fetch.preconnect(...)` extension, which a hand-written test stub cannot
 * implement. Production fetches always resolve through `globalThis.fetch`,
 * which preserves Bun's full extension surface at call time.
 */
type FetchFn = (input: string) => Promise<Response>;

let fetchImpl: FetchFn = (input) => globalThis.fetch(input);

/** Test-only: replace the fetcher used by this module. */
export function __setFetchForTests(fn: FetchFn): void {
  fetchImpl = fn;
}

/** Test-only: restore the production fetcher. */
export function __resetFetch(): void {
  fetchImpl = (input) => globalThis.fetch(input);
}

export async function getQuote(ticker: string): Promise<FinnhubQuote> {
  return withRateLimit(async () => {
    const url = `${FINNHUB_BASE_URL}/quote?symbol=${ticker}&token=${process.env.FINNHUB_API_KEY}`;
    const response = await fetchImpl(url);

    if (response.status === 429) {
      throw new FinnhubRateLimitError();
    }

    if (!response.ok) {
      throw new Error(
        `Finnhub Quote Error for ${ticker}: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as FinnhubQuote;
  })

}

export async function getCompanyNews(
  ticker: string,
  startDate: string,
  endDate: string,
): Promise<FinnhubNewsItem[]> {
  return withRateLimit(async () => {
    const url = `${FINNHUB_BASE_URL}/company-news?symbol=${ticker}&from=${startDate}&to=${endDate}&token=${process.env.FINNHUB_API_KEY}`;
    const response = await fetchImpl(url);

    if (!response.ok) {
      throw new Error(
        `Finnhub Company News Error for ${ticker}: ${response.status} ${response.statusText}`,
      );
    }

    if (response.status === 429) {
      throw new FinnhubRateLimitError();
    }

    return (await response.json()) as FinnhubNewsItem[];
  });
}

// ADDING MORE API CALLS HERE WILL HIT LIMIT, MUST UPDATE WORKERS IF ADDING ANYTHING MORE
