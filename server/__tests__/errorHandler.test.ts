import { describe, expect, it, mock } from "bun:test";
import app from "../index"; // Import your main Hono app

// Force a critical failure in a known module
mock.module("../lib/session", () => ({
  getSession: () => {
    throw new Error("CRITICAL DATABASE FAILURE: User credentials leaked!");
  },
}));

describe("Global Error Handler", () => {
  it("should catch unhandled exceptions and return a sanitized 500 error", async () => {
    // Hit a route that you know calls getSession()
    const res = await app.request("/gmail/messages", {
      headers: {
        Cookie: "sessionId=valid-but-doomed-session",
      },
    });

    expect(res.status).toBe(500);

    // Clone the response so we can read it twice
    const resClone = res.clone();

    // Verify the response body hides the real error message
    const body = await res.json();

    // We expect a safe, generic message
    expect(body).toEqual({
      message: "Internal Server Error",
    });

    // Explicitly guarantee the stack trace or real error didn't leak
    const rawText = await resClone.text();
    expect(rawText).not.toContain("CRITICAL DATABASE FAILURE");
  });

  it("should cleanly handle 404 Not Found errors for unknown routes", async () => {
    const res = await app.request("/api/this-does-not-exist");

    expect(res.status).toBe(404);
  });
});
