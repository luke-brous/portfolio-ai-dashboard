// File-backed session store.
//
// ---------------
// session.ts used a module-level `const sessions = new Map<>()`. Bun's
// `--watch` mode and any restart of the server process would wipe that
// Map, but the cookie stored in the browser still referenced the old
// random uuid. The next authed request would then 401 because
// `getSession(cookieId)` returned undefined, even though the user had
// just logged in.
//
// ---------------------
// Move the source of truth to a small JSON file on disk. Reads are
// per-call (synchronous fs — fine for the personal-use scale here:
// a 1-2KB JSON file in `cwd`). Writes are atomic: serialise to a
// temp file in the same directory, then rename(2) over the target,
// with the directory created on first write. See `writeAll` for why
// the in-place form was not safe.
//
// HMR resilience
// --------------
// Because `readAll()` re-reads the file on every call, the new map
// re-hydrates correctly after any module reload -- we don't keep an
// in-memory cache that could drift out of sync with disk.
//
// Per-call env resolution
// ------------------------
// `sessionFilePath()` reads `process.env.SESSION_FILE` on every
// invocation rather than capturing it at module-load time. Two
// reasons:
//   1. Bun caches modules by resolved path. If we captured the env
//      at module evaluation, tests that swap the env per test
//      case would all read/write against the first test's file.
//   2. Production deployments can move the file location later
//      (e.g. rotate to a new disk) without forcing a restart of
//      every consumer of this module.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionData } from "../types/session";

function sessionFilePath(): string {
  return process.env.SESSION_FILE?.trim() || "sessions.json";
}

function readAll(): Record<string, SessionData> {
  const file = sessionFilePath();
  if (!existsSync(file)) return {};
  try {
    const raw = readFileSync(file, "utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw) as Record<string, SessionData>;
  } catch (err) {
    // Corrupt JSON or unreadable file -- don't crash the request.
    // The worst case is the user has to log in again, which is the
    // same behaviour they'd have hit if the in-memory Map had been
    // wiped by a process restart before this module existed.
    console.error(`[sessionStore] could not read ${file}:`, err);
    return {};
  }
}

function writeAll(map: Record<string, SessionData>): void {
  const file = sessionFilePath();
  const dir = dirname(file);
  // Unique temp name: two processes (or a `--watch` reload racing the
  // old process) must never share a scratch file, or one's partial
  // write becomes the other's rename source.
  const tmp = join(dir, `.sessions.${process.pid}.${randomUUID()}.tmp`);
  try {
    // Ensure the parent directory exists in case SESSION_FILE points
    // somewhere nested (e.g. .data/sessions.json in a container).
    mkdirSync(dir, { recursive: true });

    // Atomic replace: serialise to a temp file in the SAME directory,
    // then rename over the target. rename(2) is atomic within a
    // filesystem, so a concurrent `readAll()` sees either the whole
    // old file or the whole new one — never a half-written prefix.
    //
    // Writing in place (the previous behaviour) had a real failure
    // window: writeFileSync truncates first, so a crash, a full disk,
    // or a reader landing mid-write yields truncated JSON. `readAll()`
    // swallows that as `{}`, which silently logs out every active
    // user. The tmp+rename form makes that unreachable.
    //
    // mode is set on the temp file so the session data is never
    // briefly world-readable between create and chmod.
    writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    // Don't leave scratch files behind on a failed write. `force`
    // makes this a no-op when writeFileSync itself was what failed.
    rmSync(tmp, { force: true });

    // Failing to persist means we can't guarantee the user will be
    // logged in across requests, so rethrow -- the OAuth callback's
    // try/catch turns this into a 500 rather than silently creating
    // a session that vanishes on the next read.
    console.error(`[sessionStore] could not write ${file}:`, err);
    throw err;
  }
}

/**
 * Create or overwrite the session entry for `id`. Throws if the
 * underlying write fails; callers in the OAuth callback path want
 * this to be fatal (don't hand back a cookie for a session we
 * couldn't persist).
 */
export function createSession(id: string, data: SessionData): void {
  const map = readAll();
  map[id] = data;
  writeAll(map);
}

/**
 * Look up a session by its id. Returns `undefined` if no entry
 * exists -- same contract as the previous in-memory Map.
 */
export function getSession(id: string): SessionData | undefined {
  return readAll()[id];
}

/**
 * Remove a session entry. No-op if it doesn't already exist; matches
 * Map.delete semantics so `requireSession`'s "cookie present but
 * session missing" 401 path stays unchanged.
 */
export function deleteSession(id: string): void {
  const map = readAll();
  delete map[id];
  writeAll(map);
}
