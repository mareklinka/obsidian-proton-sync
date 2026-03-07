import { Effect, Option } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProtonSession } from '../proton/auth/ProtonSession';

const requestUrlMock = vi.hoisted(() => vi.fn());
const getObsidianSecretStoreMock = vi.hoisted(() => vi.fn());
const getObsidianSettingsStoreMock = vi.hoisted(() => vi.fn());

vi.mock('obsidian', () => ({
  requestUrl: requestUrlMock,
  Platform: { isMobile: false }
}));

vi.mock('../services/ObsidianSecretStore', () => ({
  getObsidianSecretStore: getObsidianSecretStoreMock
}));

vi.mock('../services/ObsidianSettingsStore', () => ({
  getObsidianSettingsStore: getObsidianSettingsStoreMock
}));

describe('ProtonSessionService', () => {
  const SESSION_STORAGE_KEY = 'proton-drive-sync-session';
  const SALTED_PASSPHRASES_SECRET_KEY = 'proton-drive-sync-salted-passphrases';

  const secretData = new Map<string, string>();

  const storedSession: ProtonSession = {
    uid: 'uid-123',
    userId: 'user-123',
    accessToken: 'access-123',
    refreshToken: 'refresh-123',
    scope: 'full locked',
    createdAt: new Date('2026-03-07T10:00:00.000Z'),
    updatedAt: new Date('2026-03-07T10:00:00.000Z'),
    expiresAt: new Date('2026-03-07T11:00:00.000Z'),
    lastRefreshAt: new Date('2026-03-07T10:00:00.000Z')
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    secretData.clear();

    getObsidianSecretStoreMock.mockReturnValue({
      get: (key: string) => secretData.get(key) ?? null,
      set: (key: string, value: string) => {
        secretData.set(key, value);
      },
      clear: (key: string) => {
        secretData.set(key, '');
      }
    });

    getObsidianSettingsStoreMock.mockReturnValue({
      set: vi.fn()
    });

    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        UID: 'uid-123',
        AccessToken: 'access-refreshed',
        RefreshToken: 'refresh-refreshed',
        Scope: 'full locked',
        ExpiresIn: 3600
      }
    });
  });

  it('reports whether a persisted session exists', async () => {
    const mod = await import('../proton/auth/ProtonSessionService');

    secretData.set(SESSION_STORAGE_KEY, JSON.stringify(storedSession));

    const service = mod.initProtonSessionService('test-app-version');

    expect(service.hasPersistedSession()).toBe(true);

    secretData.set(SESSION_STORAGE_KEY, '');
    expect(service.hasPersistedSession()).toBe(false);
  });

  it('fails activation when persisted session is missing', async () => {
    const mod = await import('../proton/auth/ProtonSessionService');
    const service = mod.initProtonSessionService('test-app-version');

    const result = await Effect.runPromise(Effect.either(service.activatePersistedSession()));

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toMatchObject({ _tag: 'PersistedSessionNotFoundError' });
    }

    expect(Option.isNone(service.getCurrentSession())).toBe(true);
  });

  it('activates persisted session and hydrates salted passphrases into memory', async () => {
    const mod = await import('../proton/auth/ProtonSessionService');

    secretData.set(SESSION_STORAGE_KEY, JSON.stringify(storedSession));
    secretData.set(
      SALTED_PASSPHRASES_SECRET_KEY,
      JSON.stringify({ keyA: 'salted-passphrase-a', keyB: 'salted-passphrase-b' })
    );

    const service = mod.initProtonSessionService('test-app-version');

    await Effect.runPromise(service.activatePersistedSession());

    const session = service.getCurrentSession();
    expect(Option.isSome(session)).toBe(true);
    if (Option.isSome(session)) {
      expect(session.value.accessToken).toBe('access-refreshed');
      expect(session.value.refreshToken).toBe('refresh-refreshed');
    }

    expect(service.getSaltedKeyPasswords()).toEqual({
      keyA: 'salted-passphrase-a',
      keyB: 'salted-passphrase-b'
    });
  });

  it('deactivates current session and clears in-memory salted passphrases only', async () => {
    const mod = await import('../proton/auth/ProtonSessionService');

    secretData.set(SESSION_STORAGE_KEY, JSON.stringify(storedSession));
    secretData.set(SALTED_PASSPHRASES_SECRET_KEY, JSON.stringify({ keyA: 'salted-passphrase-a' }));

    const service = mod.initProtonSessionService('test-app-version');

    await Effect.runPromise(service.activatePersistedSession());
    await Effect.runPromise(service.deactivateSession());

    expect(Option.isNone(service.getCurrentSession())).toBe(true);
    expect(service.getSaltedKeyPasswords()).toEqual({});

    // persisted session should still exist so the user remains logically signed in
    expect(service.hasPersistedSession()).toBe(true);
  });
});
