/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable @typescript-eslint/naming-convention */
import { Effect, Either, Option } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as BrowserSignInModule from '../proton/auth/BrowserSignIn';
import type { BrowserSignInResult } from '../proton/auth/BrowserSignIn';

const mocks = vi.hoisted(() => ({
  browser: vi.fn(),
  revoke: vi.fn(),
  persist: vi.fn(),
  clear: vi.fn(),
  settings: vi.fn(),
  cancelLock: vi.fn()
}));
vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));
vi.mock('../proton/auth/BrowserSignIn', async importOriginal => {
  const original = await importOriginal<typeof BrowserSignInModule>();
  return { ...original, authenticateInBrowser: mocks.browser, revokeBrowserSession: mocks.revoke };
});
vi.mock('../services/EncryptedSecretStore', () => ({
  POST_SYNC_MEMORY_CLEAR_DELAY_MS: 300_000,
  getEncryptedSecretStore: () => ({
    persistSessionData: mocks.persist,
    clearSessionData: mocks.clear,
    cancelScheduledLock: mocks.cancelLock
  })
}));
vi.mock('../services/ObsidianSettingsStore', () => ({ getObsidianSettingsStore: () => ({ set: mocks.settings }) }));

function browserResult(): BrowserSignInResult {
  const now = new Date();
  return {
    session: {
      uid: 'test-uid',
      userId: 'test-user',
      accessToken: 'dummy-access',
      refreshToken: 'dummy-refresh',
      scope: 'full',
      createdAt: now,
      updatedAt: now,
      expiresAt: now,
      lastRefreshAt: now
    },
    saltedPassphrases: { 'primary-key': 'dummy-key-password' },
    accountName: 'dummy@example.test'
  };
}

describe('browser session persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.browser.mockResolvedValue(browserResult());
    mocks.revoke.mockResolvedValue(undefined);
    mocks.persist.mockReturnValue(Effect.void);
    mocks.clear.mockReturnValue(Effect.void);
  });

  it('requests a local master password and only then stores the encrypted session', async () => {
    const { initProtonSessionService } = await import('../proton/auth/ProtonSessionService');
    const service = initProtonSessionService('external-drive-test@1.0.0');
    const states: Array<string> = [];
    const sub = service.authState$.subscribe(state => states.push(state));
    const browserComplete = vi.fn();
    const password = vi.fn(() => {
      expect(browserComplete).toHaveBeenCalledOnce();
      expect(mocks.persist).not.toHaveBeenCalled();
      return Effect.succeed(Option.some('dummy-master'));
    });
    await Effect.runPromise(service.signInViaBrowser(vi.fn(), password, browserComplete, new AbortController().signal));
    expect(states).toEqual(['disconnected', 'connecting', 'connected']);
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        saltedPassphrases: { 'primary-key': 'dummy-key-password' }
      }),
      'dummy-master'
    );
    expect(mocks.settings).toHaveBeenCalledWith('accountEmail', 'dummy@example.test');
    expect(mocks.revoke).not.toHaveBeenCalled();
    sub.unsubscribe();
  });

  it('revokes the session when the master-password prompt is cancelled', async () => {
    const { initProtonSessionService } = await import('../proton/auth/ProtonSessionService');
    const result = await Effect.runPromise(
      Effect.either(
        initProtonSessionService('test').signInViaBrowser(
          vi.fn(),
          () => Effect.succeed(Option.none()),
          vi.fn(),
          new AbortController().signal
        )
      )
    );
    expect(Either.isLeft(result) && result.left._tag).toBe('MasterPasswordRequiredError');
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.revoke).toHaveBeenCalledOnce();
    expect(mocks.settings).not.toHaveBeenCalled();
  });

  it('revokes and clears a session when unload occurs during encrypted persistence', async () => {
    const controller = new AbortController();
    mocks.persist.mockReturnValue(
      Effect.sync(() => {
        controller.abort();
      })
    );
    const { initProtonSessionService } = await import('../proton/auth/ProtonSessionService');
    const result = await Effect.runPromise(
      Effect.either(
        initProtonSessionService('test').signInViaBrowser(
          vi.fn(),
          () => Effect.succeed(Option.some('dummy-master')),
          vi.fn(),
          controller.signal
        )
      )
    );
    expect(Either.isLeft(result) && result.left._tag).toBe('BrowserSignInFailure');
    expect(mocks.clear).toHaveBeenCalledOnce();
    expect(mocks.revoke).toHaveBeenCalledOnce();
    expect(mocks.settings).not.toHaveBeenCalled();
  });

  it('revokes on encryption failure and does not mark login connected', async () => {
    mocks.persist.mockReturnValue(Effect.fail({ _tag: 'SecretEncryptionFailedError' }));
    const { initProtonSessionService } = await import('../proton/auth/ProtonSessionService');
    const service = initProtonSessionService('test');
    const states: Array<string> = [];
    const sub = service.authState$.subscribe(state => states.push(state));
    const result = await Effect.runPromise(
      Effect.either(
        service.signInViaBrowser(
          vi.fn(),
          () => Effect.succeed(Option.some('dummy-master')),
          vi.fn(),
          new AbortController().signal
        )
      )
    );
    expect(Either.isLeft(result) && result.left._tag).toBe('SecretEncryptionFailedError');
    expect(states.at(-1)).toBe('error');
    expect(mocks.revoke).toHaveBeenCalledOnce();
    sub.unsubscribe();
  });

  it('does not expose an unexpected underlying error or persist a failed browser response', async () => {
    mocks.browser.mockRejectedValue(new Error('private underlying details'));
    const { initProtonSessionService } = await import('../proton/auth/ProtonSessionService');
    const result = await Effect.runPromise(
      Effect.either(
        initProtonSessionService('test').signInViaBrowser(
          vi.fn(),
          () => Effect.succeed(Option.some('dummy-master')),
          vi.fn(),
          new AbortController().signal
        )
      )
    );
    expect(Either.isLeft(result) && result.left.message).toBe('Browser sign-in failed.');
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private');
  });
});
