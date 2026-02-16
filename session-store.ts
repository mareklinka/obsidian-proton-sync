import type { App } from 'obsidian';

export interface ProtonSession {
  uid: string;
  userId: string | null;
  accessToken: string;
  refreshToken: string;
  scope: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  lastRefreshAt: string;
}

const SESSION_STORAGE_KEY = 'proton-drive-sync-session';

export async function loadSession(app: App): Promise<ProtonSession | null> {
  const stored = await app.secretStorage.getSecret(SESSION_STORAGE_KEY);
  if (!stored) {
    return null;
  }

  try {
    return JSON.parse(stored) as ProtonSession;
  } catch {
    return null;
  }
}

export async function saveSession(app: App, session: ProtonSession): Promise<void> {
  await app.secretStorage.setSecret(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export async function clearSession(app: App): Promise<void> {
  await app.secretStorage.setSecret(SESSION_STORAGE_KEY, '');
}
