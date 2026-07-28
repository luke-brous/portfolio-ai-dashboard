export interface SessionData {
  tokens: {
    access_token: string;
    refresh_token?: string;
    expiry_date?: number;
  };
  // Server-side cap. Bumps the attack window of a stolen cookie from
  // "indefinite, until server restart" to a bounded one. The cookie's
  // `maxAge` is a browser hint, not an enforcement — `requireSession`
  // treats this field as the truth and deletes expired sessions on
  // the next request that references them.
  expiresAt: number;
}
