import { Effect, Option } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProtonSession } from '../proton/auth/ProtonSession';

const getObsidianSecretStoreMock = vi.hoisted(() => vi.fn());

vi.mock('obsidian', () => ({
  // eslint-disable-next-line @typescript-eslint/naming-convention
  Platform: { isMobile: false }
}));

vi.mock('../services/ObsidianSecretStore', () => ({
  getObsidianSecretStore: getObsidianSecretStoreMock
}));

describe('EncryptedSecretStore', () => {
  const OLD_MASTER_PASSWORD = 'current-password';
  const NEW_MASTER_PASSWORD = 'new-password';

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
  });

  it('changes master password and decrypts persisted data with the new password', async () => {
    const mod = await import('../services/EncryptedSecretStore');
    const store = mod.getEncryptedSecretStore();

    await Effect.runPromise(
      store.persistSessionData(
        {
          session: storedSession,
          saltedPassphrases: {
            keyA: 'salted-a'
          }
        },
        OLD_MASTER_PASSWORD
      )
    );

    await Effect.runPromise(store.clearUnlockedSessionData());

    await Effect.runPromise(store.changeMasterPassword(OLD_MASTER_PASSWORD, NEW_MASTER_PASSWORD));
    await Effect.runPromise(store.clearUnlockedSessionData());

    const loadedWithNewPassword = await Effect.runPromise(store.loadSessionData(NEW_MASTER_PASSWORD));

    expect(loadedWithNewPassword.session.accessToken).toBe('access-123');
    expect(loadedWithNewPassword.saltedPassphrases).toEqual({ keyA: 'salted-a' });

    await Effect.runPromise(store.clearUnlockedSessionData());

    const loadWithOldPassword = await Effect.runPromise(Effect.either(store.loadSessionData(OLD_MASTER_PASSWORD)));
    expect(loadWithOldPassword._tag).toBe('Left');
    if (loadWithOldPassword._tag === 'Left') {
      expect(loadWithOldPassword.left).toMatchObject({ _tag: 'SecretDecryptionFailedError' });
    }
  });

  it('does not modify persisted data when current password is invalid', async () => {
    const mod = await import('../services/EncryptedSecretStore');
    const store = mod.getEncryptedSecretStore();

    await Effect.runPromise(
      store.persistSessionData(
        {
          session: storedSession,
          saltedPassphrases: {
            keyA: 'salted-a'
          }
        },
        OLD_MASTER_PASSWORD
      )
    );

    await Effect.runPromise(store.clearUnlockedSessionData());

    const rotateResult = await Effect.runPromise(
      Effect.either(store.changeMasterPassword('wrong-current-password', NEW_MASTER_PASSWORD))
    );
    expect(rotateResult._tag).toBe('Left');
    if (rotateResult._tag === 'Left') {
      expect(rotateResult.left).toMatchObject({ _tag: 'SecretDecryptionFailedError' });
    }

    await Effect.runPromise(store.clearUnlockedSessionData());

    const loadedWithOldPassword = await Effect.runPromise(store.loadSessionData(OLD_MASTER_PASSWORD));

    expect(Option.some(loadedWithOldPassword.saltedPassphrases)).toEqual(Option.some({ keyA: 'salted-a' }));
  });
});
