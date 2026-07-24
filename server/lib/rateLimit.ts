import { sleep } from "./utils";

let tokens = 60;
let lastRefilled = Date.now();
const ALLOWED_RETRIES = 3;

export async function withRateLimit<T>(work: () => Promise<T>): Promise<T> {
  const timePassed = Date.now() - lastRefilled;

  const addTokens = timePassed / 1000;

  tokens = Math.min(60, tokens + addTokens);

  lastRefilled = Date.now();

  if (tokens < 1) {
    const waitTime = (1 - tokens) * 1000;
    await sleep(waitTime);
    tokens = 1;
  }

  // charge for request
  tokens -= 1;

  for (let i: number = 0; i < ALLOWED_RETRIES; i++) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof FinnhubRateLimitError)) {
        throw error;
      } else {
        const backoffTime = Math.pow(2, i) * 1000;

        // Jitter adds a random delay to prevent synchronized traffic spikes
        const jitter = Math.random() * 500;

        await sleep(backoffTime + jitter);
      }
    }
  }

  throw new FinnhubRateLimitError();
}

export class FinnhubRateLimitError extends Error {
  constructor() {
    super("Finnhub rate limit exceeded");
    this.name = "FinnhubRateLimitError";
  }
}

export async function __resetRateLimitForTesting() {
  tokens = 60;
  lastRefilled = Date.now();
}
