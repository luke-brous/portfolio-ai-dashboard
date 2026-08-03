import { describe, it, expect } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  createSession,
  deleteSession,
  getSession,
  updateSessionTokens,
} from "../sessionStore";
import { useIsolatedSessionFile } from "../../test-utils/sessionFile";

// Two independent kinds of shared state used to break this suite. Both
// are fixed, and the two `it.skip`s they caused are active again.
//
// 1. Shared FILE. The old harness pinned one suite-level path and relied
//    on `rmSync` between tests, which is ordering-dependent by
//    construction and shares `process.env.SESSION_FILE` with every other
//    suite. `useIsolatedSessionFile()` gives each TEST its own mkdtemp
//    directory, so no other suite can name it.
//
// 2. Shared MODULE REGISTRY — the actual reason these tests were
//    skipped. `mock.module()` is process-global and permanent in Bun
//    (`mock.restore()` does not undo it), and four suites replace
//    "../../lib/session". Because server/lib/session.ts RE-EXPORTS
//    createSession/getSession/deleteSession from ./sessionStore, that
//    mock reaches the bindings this file imports directly from
//    ../sessionStore — `getSession` here would call errorHandler.test's
//    throwing stub. No temp-file scheme can fix that; the suite has to
//    run in a process where nobody has mocked lib/session. See the
//    `test:real-session` script in package.json.
//
// The old comment blamed "Bun's concurrent test runner". That was
// wrong — Bun runs these files sequentially in one process, and the
// failure is deterministic by load order, not a timing race.
const sessionFile = useIsolatedSessionFile();

describe("sessionStore file-backed persistence", () => {
  it("createSession writes a row to disk", () => {
    createSession("sess-1", {
      tokens: { access_token: "fake" },
      expiresAt: Date.now() + 60_000,
    });
    expect(existsSync(sessionFile.path)).toBe(true);
    expect(getSession("sess-1")?.tokens.access_token).toBe("fake");
  });

  it("writes land under tmpdir, never the cwd default", () => {
    // Guards the regression the skips were hiding: if SESSION_FILE is
    // lost mid-test, sessionFilePath() falls back to "sessions.json"
    // relative to cwd and this suite would quietly start writing into
    // the repo. Assert the env the store will actually read.
    createSession("sess-tmp", {
      tokens: { access_token: "fake" },
      expiresAt: Date.now() + 60_000,
    });
    expect(process.env.SESSION_FILE).toBe(sessionFile.path);
    expect(sessionFile.path.startsWith(tmpdir())).toBe(true);
    expect(existsSync(sessionFile.path)).toBe(true);
  });

  it("getSession reads the same row back", () => {
    createSession("sess-2", {
      tokens: { access_token: "abc" },
      expiresAt: Date.now() + 60_000,
    });
    const row = getSession("sess-2");
    expect(row?.tokens.access_token).toBe("abc");
  });

  it("getSession returns undefined for unknown ids (no legacy-Map leakage)", () => {
    expect(getSession("never-created")).toBeUndefined();
  });

  it("deleteSession removes the row from disk", () => {
    createSession("sess-3", {
      tokens: { access_token: "x" },
      expiresAt: Date.now() + 60_000,
    });
    deleteSession("sess-3");
    // API-level assertion: if the row were still present (whether as
    // an actually-deleted entry or a stale duplicate after a concurrent
    // write), createSession's caller wouldn't be able to distinguish,
    // so the contract is what matters. Raw on-disk inspection is
    // covered indirectly by the file-missing and partial-JSON tests
    // below at the recovery boundary.
    expect(getSession("sess-3")).toBeUndefined();
  });

  it("returns an empty store when the file is missing (cold start)", () => {
    // The tmpdir is fresh per test \u2014 file shouldn't exist yet.
    expect(existsSync(sessionFile.path)).toBe(false);
    expect(getSession("anything")).toBeUndefined();
  });

  it("createSession overwrites an existing id (Map.set semantics)", () => {
    createSession("dup", {
      tokens: { access_token: "first" },
      expiresAt: Date.now() + 60_000,
    });
    createSession("dup", {
      tokens: { access_token: "second" },
      expiresAt: Date.now() + 60_000,
    });
    expect(getSession("dup")?.tokens.access_token).toBe("second");
  });

  it("createSession persists across siblings (writes don't disappear)", () => {
    for (let i = 0; i < 5; i++) {
      createSession(`s-${i}`, {
        tokens: { access_token: `t-${i}` },
        expiresAt: Date.now() + 60_000,
      });
    }
    for (let i = 0; i < 5; i++) {
      expect(getSession(`s-${i}`)?.tokens.access_token).toBe(`t-${i}`);
    }
  });

  it("an external write between two reads is visible", () => {
    createSession("sess-4", {
      tokens: { access_token: "v1" },
      expiresAt: Date.now() + 60_000,
    });
    writeFileSync(
      sessionFile.path,
      JSON.stringify(
        {
          "sess-4": {
            tokens: { access_token: "v2" },
            expiresAt: Date.now() + 60_000,
          },
        },
        null,
        2,
      ),
    );
    expect(getSession("sess-4")?.tokens.access_token).toBe("v2");
  });

  it("reads partial file as empty rather than crashing", () => {
    // In-place write of bad JSON to confirm the corrupted-file path
    // returns {} instead of throwing \u2014 keeps the request path safe.
    writeFileSync(sessionFile.path, "{not-valid-json");
    expect(getSession("any")).toBeUndefined();
  });
});

describe("updateSessionTokens", () => {
  // Registers the beforeEach/afterEach hooks that repoint SESSION_FILE at a
  // fresh temp dir per test. Must be called at describe scope — calling it
  // inside an `it` throws "Cannot call beforeEach() inside a test".
  useIsolatedSessionFile();

  it("merges a refreshed access token while preserving the refresh token", () => {
    createSession("s1", {
      tokens: {
        access_token: "old-access",
        refresh_token: "the-refresh",
        expiry_date: 1000,
      },
      expiresAt: Date.now() + 60_000,
    });

    // The `tokens` event usually carries only a new access token. A naive
    // overwrite would drop the refresh token and kill the session for good.
    updateSessionTokens("s1", {
      access_token: "new-access",
      expiry_date: 2000,
    });

    expect(getSession("s1")?.tokens).toEqual({
      access_token: "new-access",
      refresh_token: "the-refresh",
      expiry_date: 2000,
    });
  });

  it("stores a rotated refresh token when Google sends one", () => {
    createSession("s1", {
      tokens: { access_token: "a", refresh_token: "old-refresh" },
      expiresAt: Date.now() + 60_000,
    });

    updateSessionTokens("s1", { refresh_token: "rotated-refresh" });

    expect(getSession("s1")?.tokens.refresh_token).toBe("rotated-refresh");
  });

  it("leaves expiresAt (the server-side session cap) untouched", () => {
    const expiresAt = Date.now() + 60_000;
    createSession("s1", { tokens: { access_token: "a" }, expiresAt });

    updateSessionTokens("s1", { access_token: "b" });

    expect(getSession("s1")?.expiresAt).toBe(expiresAt);
  });

  it("is a no-op for an unknown session rather than creating one", () => {
    updateSessionTokens("never-existed", { access_token: "x" });
    expect(getSession("never-existed")).toBeUndefined();
  });

  it("does not throw when the store cannot be written", () => {
    createSession("s1", {
      tokens: { access_token: "a" },
      expiresAt: Date.now() + 60_000,
    });
    // Point at an unwritable path. A failed token-cache write must not take
    // down the request that triggered it — the caller still holds working
    // credentials for the current request. The helper's afterEach restores
    // SESSION_FILE, so this does not leak into the next test.
    process.env.SESSION_FILE = "/proc/definitely/not/writable/sessions.json";
    expect(() => updateSessionTokens("s1", { access_token: "b" })).not.toThrow();
  });
});
