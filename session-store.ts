import type { App } from 'obsidian';
import { ProtonSession } from './proton/auth/ProtonSession';
import { SALTED_PASSPHRASES_SECRET_KEY } from './proton/Constants';

const SESSION_STORAGE_KEY = 'proton-drive-sync-session';

export function loadSession(app: App): ProtonSession | null {
  const stored = app.secretStorage.getSecret(SESSION_STORAGE_KEY);
  if (!stored) {
    return null;
  }

  try {
    return JSON.parse(stored) as ProtonSession;
  } catch {
    return null;
  }
}

export function saveSession(app: App, session: ProtonSession): void {
  app.secretStorage.setSecret(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export async function clearSession(app: App): Promise<void> {
  app.secretStorage.setSecret(SESSION_STORAGE_KEY, '');
  app.secretStorage.setSecret(SALTED_PASSPHRASES_SECRET_KEY, '{}');
}
