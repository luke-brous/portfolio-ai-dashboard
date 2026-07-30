import { expect, test, describe, mock } from "bun:test";
import { existsSync } from "node:fs";

// Mock the Gemini API call and sleep
mock.module("../../lib/gemini", () => ({
  summarizeText: mock(() => Promise.resolve("Mocked summary")),
}));

mock.module("../../lib/utils", () => ({
  sleep: mock(() => Promise.resolve()),
}));

// ---------- Session harness ---------------------------------------------------------
// `/summarize` is behind `requireSession` (it spends Gemini quota on the
// server's key, so it can't be open).
//
// This suite deliberately does NOT mock `../../lib/session`. A stubbed
// middleware that re-implements the 401 ladder only asserts that the stub
// works — the production ladder in server/lib/session.ts could regress to
// open and these tests would still pass. Instead we run the real
// `requireSession` and swap only its *storage*, by pointing the file-backed
// session store at a temp file via SESSION_FILE.
//
// `requireSession` also builds an OAuth2 client from GOOGLE_* env vars.
// Those are absent in CI; `new google.auth.OAuth2(undefined, ...)` is
// inert until a call is made, and this route never touches Gmail, so no
// stubbing is needed there.
//
// Storage is isolated per TEST via server/test-utils/sessionFile.ts: each
// test gets its own temp directory, so no other suite in the run can see
// or clobber the sessions written here (and this suite can't leave rows
// behind for the next one).
//
// This suite must also run in a process where nobody has called
// `mock.module("../../lib/session", ...)` — crm/portfolio/gmail/
// errorHandler all do, it is permanent and process-global in Bun, and it
// would silently swap the production `requireSession` this suite exists
// to exercise for a stub. `bun run test:real-session` is that process;
// the guard test below fails loudly if the split ever breaks.
import { createSession } from "../../lib/session";
import { useIsolatedSessionFile } from "../../test-utils/sessionFile";

const { default: app } = await import("../../index");

const sessionFile = useIsolatedSessionFile();

function makeSessionCookie(expiresAt = Date.now() + 60 * 60 * 1000): string {
  const id = `summarize-test-${crypto.randomUUID()}`;
  createSession(id, {
    tokens: { access_token: "fake" },
    expiresAt,
  });
  return `sessionId=${id}`;
}

async function postSummarize(
  body: unknown,
  { cookie = makeSessionCookie() }: { cookie?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cookie) headers.Cookie = cookie;
  // `app.request` is typed `Response | Promise<Response>`; awaiting here
  // normalises it so callers can always `await`.
  return await app.request("/summarize", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("Gemini summarize route", () => {
  // Guard for the claim this whole harness rests on. `mock.module` is
  // process-global in Bun: crm.test.ts and portfolio.test.ts both replace
  // "../../lib/session" with a Map-backed stub, and whichever file loads
  // first wins for the rest of the run. If that stub ever reached this
  // suite, `createSession` would write to a Map and the assertions below
  // would be exercising the stub's 401 ladder rather than production's.
  // A row on disk proves we are on the real file-backed store.
  test("the session harness is the real file-backed store, not a mock", () => {
    makeSessionCookie();
    expect(existsSync(sessionFile.path)).toBe(true);
  });

  // The 401 ladder below is the production one in server/lib/session.ts —
  // nothing here stubs it. All three branches answer the same
  // "Not authenticated" body so a probe can't distinguish an expired
  // session from one that never existed.
  test("POST /summarize returns 401 without a session cookie", async () => {
    const res = await postSummarize({ emails: [] }, { cookie: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not authenticated" });
  });

  test("POST /summarize returns 401 for an unknown session cookie", async () => {
    const res = await postSummarize(
      { emails: [] },
      { cookie: "sessionId=does-not-exist" },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not authenticated" });
  });

  test("POST /summarize returns 401 for an expired session", async () => {
    const cookie = makeSessionCookie(Date.now() - 1000);
    const res = await postSummarize({ emails: [] }, { cookie });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not authenticated" });
  });

  test("POST /summarize returns empty list for empty email array", async () => {
    const res = await postSummarize({ emails: [] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { summaries: unknown[] };
    expect(json.summaries).toEqual([]);
  });

  test("POST /summarize rejects malformed email objects (missing ID)", async () => {
    const res = await postSummarize({ emails: [{ subject: "No ID" }] });
    // Should be 400 due to Zod validation
    expect(res.status).toBe(400);
  });

  test("POST /summarize rejects a batch over the 50-email cap", async () => {
    const emails = Array.from({ length: 51 }, (_, i) => ({
      id: String(i),
      body: "hi",
    }));
    const res = await postSummarize({ emails });
    expect(res.status).toBe(400);
  });

  test("POST /summarize rejects an email body over the 50k-char cap", async () => {
    const res = await postSummarize({
      emails: [{ id: "1", body: "x".repeat(50_001) }],
    });
    expect(res.status).toBe(400);
  });

  test("POST /summarize returns expected summary shape on success", async () => {
    const res = await postSummarize({
      emails: [{ id: "1", subject: "Test Email", body: "Hello World" }],
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { summaries: unknown[] };
    expect(json.summaries).toHaveLength(1);
    expect(json.summaries[0]).toEqual({
      id: "1",
      subject: "Test Email",
      from: undefined,
      date: undefined,
      summary: "Mocked summary",
    });
  });
});
