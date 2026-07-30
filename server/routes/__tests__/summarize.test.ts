import {
  expect,
  test,
  describe,
  mock,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
// SESSION_FILE is (re)set per test and restored afterwards rather than
// pinned once for the suite: sessionStore.ts reads the env on every call,
// and server/lib/__tests__/sessionStore.test.ts pins its own value, so
// leaving ours in place would leak across files.
import { createSession } from "../../lib/session";

const { default: app } = await import("../../index");

let sessionFile: string;
let sessionDir: string;
let previousSessionFile: string | undefined;

beforeAll(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "summarize-session-"));
  sessionFile = join(sessionDir, "sessions.json");
});

afterAll(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

beforeEach(() => {
  previousSessionFile = process.env.SESSION_FILE;
  process.env.SESSION_FILE = sessionFile;
  // Drop rows left by the previous test so a stale id can't satisfy a
  // lookup in this one.
  rmSync(sessionFile, { force: true });
});

afterEach(() => {
  if (previousSessionFile === undefined) {
    delete process.env.SESSION_FILE;
  } else {
    process.env.SESSION_FILE = previousSessionFile;
  }
});

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
