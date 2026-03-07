import { Effect, Option } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProtonSession } from '../proton/auth/ProtonSession';

const requestUrlMock = vi.hoisted(() => vi.fn());
const getObsidianSecretStoreMock = vi.hoisted(() => vi.fn());
const getObsidianSettingsStoreMock = vi.hoisted(() => vi.fn());

vi.mock('obsidian', () => ({
  requestUrl: requestUrlMock,
  // eslint-disable-next-line @typescript-eslint/naming-convention
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
  const MASTER_PASSWORD = 'correct-horse-battery-staple';

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
      setEffect: (key: string, value: string) =>
        Effect.sync(() => {
          secretData.set(key, value);
        }),
      clear: (key: string) => {
        secretData.set(key, '');
      },
      clearEffect: (key: string) =>
        Effect.sync(() => {
          secretData.set(key, '');
        })
    });

    getObsidianSettingsStoreMock.mockReturnValue({
      set: vi.fn()
    });

    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        UID: 'uid-123',
        // eslint-disable-next-line @typescript-eslint/naming-convention
        AccessToken: 'access-refreshed',
        // eslint-disable-next-line @typescript-eslint/naming-convention
        RefreshToken: 'refresh-refreshed',
        // eslint-disable-next-line @typescript-eslint/naming-convention
        Scope: 'full locked',
        // eslint-disable-next-line @typescript-eslint/naming-convention
        ExpiresIn: 3600
      }
    });
  });

  async function persistEncryptedSessionData(session: ProtonSession, salted: Record<string, string>): Promise<void> {
    const encryptedStoreModule = await import('../services/EncryptedSecretStore');
    const encryptedStore = encryptedStoreModule.getEncryptedSecretStore();

    await Effect.runPromise(
      encryptedStore.persistSessionData(
        {
          session,
          saltedPassphrases: salted
        },
        MASTER_PASSWORD
      )
    );

    encryptedStore.lockSession();
  }

  it('fails activation when persisted session is missing', async () => {
    const mod = await import('../proton/auth/ProtonSessionService');
    const service = mod.initProtonSessionService('test-app-version');

    const result = await Effect.runPromise(
      Effect.either(service.activatePersistedSession(Effect.succeed(Option.some(MASTER_PASSWORD))))
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toMatchObject({ _tag: 'PersistedSessionNotFoundError' });
    }

    expect(Option.isNone(service.getCurrentSession())).toBe(true);
  });

  it('activates encrypted persisted session and hydrates salted passphrases into memory', async () => {
    const mod = await import('../proton/auth/ProtonSessionService');

    await persistEncryptedSessionData(storedSession, {
      keyA: 'salted-passphrase-a',
      keyB: 'salted-passphrase-b'
    });

    const service = mod.initProtonSessionService('test-app-version');

    await Effect.runPromise(service.activatePersistedSession(Effect.succeed(Option.some(MASTER_PASSWORD))));

    const session = service.getCurrentSession();
    expect(Option.isSome(session)).toBe(true);
    if (Option.isSome(session)) {
      expect(session.value.accessToken).toBe('access-123');
      expect(session.value.refreshToken).toBe('refresh-123');
    }

    expect(service.getSaltedKeyPasswords()).toEqual(
      Option.some({
        keyA: 'salted-passphrase-a',
        keyB: 'salted-passphrase-b'
      })
    );
  });

  it('clears plaintext persisted data and fails activation when encrypted envelope is missing', async () => {
    const mod = await import('../proton/auth/ProtonSessionService');
    const service = mod.initProtonSessionService('test-app-version');

    secretData.set(SESSION_STORAGE_KEY, JSON.stringify(storedSession));
    secretData.set(SALTED_PASSPHRASES_SECRET_KEY, JSON.stringify({ keyA: 'salted-passphrase-a' }));

    const result = await Effect.runPromise(
      Effect.either(service.activatePersistedSession(Effect.succeed(Option.some(MASTER_PASSWORD))))
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toMatchObject({ _tag: 'PersistedSecretsInvalidFormatError' });
    }

    expect(secretData.get(SESSION_STORAGE_KEY)).toBe('');
    expect(secretData.get(SALTED_PASSPHRASES_SECRET_KEY)).toBe('');
    expect(Option.isNone(service.getCurrentSession())).toBe(true);
  });

  it('requires master password to activate persisted session', async () => {
    const mod = await import('../proton/auth/ProtonSessionService');

    await persistEncryptedSessionData(storedSession, {
      keyA: 'salted-passphrase-a'
    });

    const service = mod.initProtonSessionService('test-app-version');

    const result = await Effect.runPromise(
      Effect.either(service.activatePersistedSession(Effect.succeed(Option.none())))
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toMatchObject({ _tag: 'MasterPasswordRequiredError' });
    }
  });
});
