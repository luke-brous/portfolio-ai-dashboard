import type { gmail_v1 } from "googleapis";
// Helpers for working with raw Gmail API responses.
//
// Gmail returns message bodies as base64url-encoded strings nested
// inside a `payload.parts[]` array (multipart emails) or directly in
// `payload.body.data` (simple emails). Headers (From, Subject, Date)
// live in `payload.headers[]` as { name, value } pairs.

export function decodeBase64Url(data: string): string {
  // Gmail uses base64url (- and _ instead of + and /).

  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");

  return Buffer.from(base64, "base64").toString("utf-8");
}

export function buildGmailQuery(params: {
  label?: string;
  after?: string;
  before?: string;
}): string | undefined {
  const queryParts = [
    params.label ? `label:${params.label}` : null,
    params.after ? `after:${params.after}` : null,
    params.before ? `before:${params.before}` : null,
  ].filter((part): part is string => Boolean(part));

  return queryParts.length > 0 ? queryParts.join(" ") : undefined;
}

export function getHeader(
  headers: { name: string; value: string }[],
  name: string,
): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
    ?.value;
}

export function extractBody(payload: gmail_v1.Schema$MessagePart): string {
  // walk payload.parts recursively (multipart/alternative,
  // multipart/mixed) looking for a text/plain part, falling back to
  // text/html if no text/plain is found, and decode the body data.
  const mimeType = payload.mimeType;
  const bodyData = payload.body?.data;
  let fallbackHTML = "";

  if (mimeType === "text/plain" && bodyData) {
    return decodeBase64Url(bodyData);
  }

  if (mimeType === "text/html" && bodyData) {
    fallbackHTML = decodeBase64Url(bodyData).replace(/<[^>]+>?/gm, ""); // strip HTML tags
  }

  for (const part of payload.parts ?? []) {
    const result = extractBody(part);
    if (part.mimeType === "text/plain" && result) {
      return result;
    }
    if (part.mimeType === "text/html" && result) {
      fallbackHTML = result;
    }
    if (part.mimeType !== "text/html" && result) {
      return result;
    }
  }
  return fallbackHTML;
}
