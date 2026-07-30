// Per-test isolation for the file-backed session store.
//
// Why this exists
// ---------------
// `server/lib/sessionStore.ts` resolves its path from
// `process.env.SESSION_FILE` on every call. `process.env` is
// process-global and Bun runs every test file in ONE process, so any
// suite that sets that variable is writing to state every other suite
// can observe. Two concrete failures came out of that:
//
//   1. A suite that set SESSION_FILE in `beforeEach` and deleted it in
//      `afterEach` would, on the delete, hand the default back to any
//      other suite mid-flight — whose `createSession` then wrote to
//      `./sessions.json` in the repo root instead of a temp file. That
//      is what the two `it.skip`s in sessionStore.test.ts were papering
//      over, and it also means a test run could clobber a real local
//      session file.
//   2. Suites that shared one path relied on `rmSync` between tests to
//      stay independent. That is ordering-dependent by construction.
//
// The fix is to make the path unique per TEST rather than per suite:
// `mkdtempSync` hands back a directory no other test can name, so even
// if the env var is read at an unlucky moment the worst case is a path
// that belongs to nobody, not another test's data.
//
// Usage — call at describe scope, before the tests that need it:
//
//   const sessionFile = useIsolatedSessionFile();
//   ...
//   it("...", () => { expect(existsSync(sessionFile.path)).toBe(true); });
//
// `sessionFile.path` throws outside a test body, which turns "used the
// helper wrong" into a clear error instead of a stale path.

import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IsolatedSessionFile {
  /** Absolute path to this test's private sessions.json. */
  readonly path: string;
  /** Absolute path to the temp directory holding it. */
  readonly dir: string;
}

/**
 * Registers `beforeEach`/`afterEach` hooks that point `SESSION_FILE` at
 * a fresh temp directory for the duration of each test, then restore
 * whatever value (or absence) was there before.
 *
 * Restoring the PREVIOUS value rather than unconditionally deleting is
 * deliberate: deleting would silently re-point a concurrently-loaded
 * consumer at the cwd default.
 */
export function useIsolatedSessionFile(): IsolatedSessionFile {
  let currentDir: string | null = null;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.SESSION_FILE;
    currentDir = mkdtempSync(join(tmpdir(), "session-test-"));
    process.env.SESSION_FILE = join(currentDir, "sessions.json");
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.SESSION_FILE;
    } else {
      process.env.SESSION_FILE = previous;
    }
    if (currentDir) {
      rmSync(currentDir, { recursive: true, force: true });
      currentDir = null;
    }
  });

  function requireDir(): string {
    if (!currentDir) {
      throw new Error(
        "useIsolatedSessionFile(): no active temp dir. Read `.path`/`.dir` " +
          "inside a test body (or a beforeEach that runs after this helper's).",
      );
    }
    return currentDir;
  }

  return {
    get dir() {
      return requireDir();
    },
    get path() {
      return join(requireDir(), "sessions.json");
    },
  };
}
