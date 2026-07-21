// Generic utility functions for the server.

/**
 * Delays execution for a specified number of milliseconds.
 * Useful for rate limiting API calls.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
