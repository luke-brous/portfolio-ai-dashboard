import { expect, test, describe, mock } from "bun:test";
import gmail from "../gmail";
import { createSession } from "../../lib/session";
import crypto from "crypto";

// Mock the dependencies
mock.module("../../lib/session", () => ({
  getSession: () => ({
    tokens: {
      access_token: "fake-token",
    },
  }),
}));

mock.module("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
        // The real OAuth2Client extends EventEmitter, and `requireSession`
        // subscribes to its "tokens" event to persist refreshed credentials.
        // Keep this in step with that contract: `mock.module("googleapis")`
        // is process-global and permanent in Bun, so an incomplete fake here
        // leaks into every other suite in the run — omitting `on` made all
        // 32 portfolio tests fail with "oauthClient.on is not a function"
        // while portfolio.test.ts passed perfectly well on its own.
        on() {}
      },
    },
    gmail: () => ({
      users: {
        messages: {
          list: () => ({
            data: {
              messages: [{ id: "1" }],
            },
          }),
          get: () => ({
            data: {
              id: "1",
              payload: {
                mimeType: "text/plain",
                body: { data: Buffer.from("test").toString("base64") },
              },
            },
          }),
        },
        labels: {
          list: () => ({ data: { labels: [] } }),
        },
      },
    }),
  },
}));

describe("Gmail routes", () => {
  test("missing 'label' parameter causes a 400 error", async () => {
    // Authenticate in order to bypass the middleware that checks for a session
    const sessionId = crypto.randomUUID();
    createSession(sessionId, {
      tokens: { access_token: "mock" },
      // `expiresAt` was made required by the CRM security hardening
      // (see server/types/session.ts); tests that call the REAL
      // createSession must include it. 1h is plenty for the test.
      expiresAt: Date.now() + 60 * 60 * 1000,
    });

    const res = await gmail.request("/messages", {
      headers: {
        Cookie: `sessionId=${sessionId}`,
      },
    });

    // Zod validation should fail, so 400.
    expect(res.status).toBe(400);
  });

  test("should return a 200 OK status with valid date strings and label IDs", async () => {
    // Build your target query string
    const queryParams = new URLSearchParams({
      label: "INBOX",
      after: "2026-06-01",
      before: "2026-06-30",
    }).toString();

    // Dispatch the request directly to the Hono app instance
    const res = await gmail.request(`/messages?${queryParams}`, {
      headers: {
        Cookie: "sessionId=mock-test-session-id",
      },
    });

    // Check the response status
    expect(res.status).toBe(200);
  });
});
