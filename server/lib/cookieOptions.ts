// Session cookie attributes, in one place so `/auth/callback` (set) and
// `/auth/logout` (clear) can never disagree — a cookie is only cleared if
// the clearing `Set-Cookie` matches the original's path/attributes.
//
// Why SameSite is configurable
// ----------------------------
// This app is routinely served with the client and the API on two different
// origins (Codespaces forwards :5173 and :3000 as separate hosts; a real
// deploy may split them across domains entirely). Whether those two hosts
// count as "same-site" decides whether a `SameSite=Lax` cookie is attached
// to XHR at all: Lax is sent on same-site requests and on top-level GET
// navigations, but never on a cross-site `fetch`. If the frontend and the
// API are cross-site, every authed request — POST especially — arrives
// cookieless and `requireSession` answers 401.
//
// `SameSite=None` lifts that restriction, but browsers only accept it on a
// `Secure` cookie, so we force `secure: true` alongside it. Default stays
// `lax`, which is the safer choice whenever the two really are same-site.

type SameSite = "Lax" | "None" | "Strict";

function resolveSameSite(): SameSite {
  const raw = process.env.SESSION_COOKIE_SAMESITE?.trim().toLowerCase();
  if (raw === "none") return "None";
  if (raw === "strict") return "Strict";
  return "Lax";
}

export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: SameSite;
  path: string;
}

/**
 * Attributes for the `sessionId` cookie. Read per call rather than captured
 * at module load so tests (and a redeploy that flips the env) see the
 * current value instead of whatever was set the first time this module was
 * imported.
 */
export function sessionCookieOptions(): SessionCookieOptions {
  const sameSite = resolveSameSite();
  return {
    httpOnly: true,
    // `SameSite=None` is rejected by browsers without `Secure`; the app is
    // served over https everywhere it isn't localhost, so this is safe to
    // pin on regardless.
    secure: true,
    sameSite,
    path: "/",
  };
}
