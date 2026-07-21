export interface SessionData {
  tokens: {
    access_token: string;
    refresh_token?: string;
    expiry_date?: number;
  };
}
