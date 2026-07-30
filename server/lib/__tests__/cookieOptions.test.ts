import { describe, expect, it, afterEach } from "bun:test";
import { sessionCookieOptions } from "../cookieOptions";

const ORIGINAL = process.env.SESSION_COOKIE_SAMESITE;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SESSION_COOKIE_SAMESITE;
  else process.env.SESSION_COOKIE_SAMESITE = ORIGINAL;
});

describe("sessionCookieOptions", () => {
  it("defaults to Lax when the env var is unset", () => {
    delete process.env.SESSION_COOKIE_SAMESITE;
    expect(sessionCookieOptions().sameSite).toBe("Lax");
  });

  it("falls back to Lax on an unrecognised value rather than passing it through", () => {
    process.env.SESSION_COOKIE_SAMESITE = "banana";
    expect(sessionCookieOptions().sameSite).toBe("Lax");
  });

  it("accepts none/strict case-insensitively and with surrounding space", () => {
    process.env.SESSION_COOKIE_SAMESITE = " NONE ";
    expect(sessionCookieOptions().sameSite).toBe("None");
    process.env.SESSION_COOKIE_SAMESITE = "Strict";
    expect(sessionCookieOptions().sameSite).toBe("Strict");
  });

  it("keeps Secure set for SameSite=None, which browsers reject without it", () => {
    process.env.SESSION_COOKIE_SAMESITE = "none";
    const opts = sessionCookieOptions();
    expect(opts.sameSite).toBe("None");
    expect(opts.secure).toBe(true);
  });

  it("re-reads the env per call so a later change is picked up", () => {
    delete process.env.SESSION_COOKIE_SAMESITE;
    expect(sessionCookieOptions().sameSite).toBe("Lax");
    process.env.SESSION_COOKIE_SAMESITE = "none";
    expect(sessionCookieOptions().sameSite).toBe("None");
  });

  it("always marks the cookie httpOnly and root-scoped", () => {
    const opts = sessionCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.path).toBe("/");
  });
});
