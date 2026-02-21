export interface ProtonSession {
  uid: string;
  userId: string | null;
  accessToken: string;
  refreshToken: string;
  scope: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  lastRefreshAt: Date;
}
