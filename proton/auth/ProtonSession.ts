export interface ProtonSession {
  uid: string;
  userId: string | null;
  accessToken: string;
  refreshToken: string;
  scope: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  lastRefreshAt: number;
}
