// Small typed fetch wrapper so components don't repeat fetch/JSON
// boilerplate, and so it's easy to add auth headers in one place later.

/**
 * Resolve an API path against the backend origin.
 *
 * Why this exists
 * ---------------
 * The `sessionId` cookie is set by `GET /auth/callback`, which runs on the
 * *backend* origin (`VITE_BACKEND_URL`). Cookies are host-only unless a
 * `Domain` attribute is set, so that cookie only ever rides along on
 * requests aimed at the backend host.
 *
 * Calls made with a bare relative path go to whatever origin is serving the
 * frontend — in dev that's the Vite server on :5173, a *different* host from
 * the backend on :3000. The browser attaches no cookie, Vite's proxy dutifully
 * forwards the cookieless request, and `requireSession` answers 401
 * "Not authenticated" even though the user just logged in.
 *
 * Reads on `/portfolio/*` masked the bug because those routes carry no
 * `requireSession`; only the authed writes surfaced it.
 *
 * Routing every call through this helper keeps reads and writes on the one
 * origin the cookie is actually scoped to. Absolute URLs pass through
 * untouched so existing callers that already interpolate the base URL
 * themselves don't end up double-prefixed.
 */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = import.meta.env.VITE_BACKEND_URL?.replace(/\/$/, "") ?? "";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { credentials: "include" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

/**
 * Thrown by `apiMutate` when the server returns a non-2xx response. Carries
 * the HTTP status and parsed JSON body so callers can distinguish
 * category-of-error (e.g. 409 Conflict vs 400 Validation) and surface
 * server-supplied messages inline.
 *
 * `apiGet` throws a plain `Error` for backwards compatibility — only the
 * write hooks consume this richer shape.
 */
export class ApiError<TBody = unknown> extends Error {
  constructor(
    public readonly status: number,
    public readonly body: TBody,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type HttpMethod = "POST" | "PATCH" | "DELETE";

/**
 * Single typed entry point for POST / PATCH / DELETE so mutation hooks
 * don't repeat fetch boilerplate. On non-2xx, parses the JSON error body
 * (best effort) and throws an `ApiError` with status + body so callers
 * can discriminate. 204 No Content is treated as success with `undefined`.
 */
export async function apiMutate<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  const hasBody = body !== undefined;
  const res = await fetch(apiUrl(path), {
    method,
    headers: hasBody ? { "Content-Type": "application/json" } : undefined,
    credentials: "include",
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let parsed: unknown = null;
    try {
      // The server may have written a non-JSON body; swallow the parse
      // error so the caller still gets a useful `ApiError` with status.
      parsed = await res.json();
    } catch {
      // ignore — body stays null
    }
    throw new ApiError(
      res.status,
      parsed,
      `${method} ${path} failed: ${res.status}`,
    );
  }
  if (res.status === 204) return undefined as T;
  // Some 2xx responses with empty bodies (e.g. future 200 OK with nothing)
  // would otherwise throw on res.json(); treat empty body as undefined.
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
