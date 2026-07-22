import { google } from "googleapis";

// Creates a fresh OAuth2 client configured from env vars.
// Used both to generate the consent screen URL and to exchange
// the auth code for tokens.
export function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}
