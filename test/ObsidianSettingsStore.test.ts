import { Option } from 'effect';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProtonSession } from '../proton/auth/ProtonSession';
import type { initObsidianSettingsStore } from '../services/ObsidianSettingsStore';

type SettingsStoreCallbacks = Parameters<typeof initObsidianSettingsStore>[1];
type PersistedSettings = Parameters<SettingsStoreCallbacks['save']>[0];

function createSnapshot(entries: Array<readonly [string, string | null]>): Record<string, string | null> {
  return Object.fromEntries(entries);
}

function createCallbacks(loaded: Awaited<ReturnType<SettingsStoreCallbacks['load']>>): {
  load: Mock<SettingsStoreCallbacks['load']>;
  save: Mock<SettingsStoreCallbacks['save']>;
} {
  return {
    load: vi.fn<SettingsStoreCallbacks['load']>().mockResolvedValue(loaded),
    save: vi.fn<SettingsStoreCallbacks['save']>().mockResolvedValue(undefined)
  };
}

function getLastPersisted(callbacks: { save: Mock<SettingsStoreCallbacks['save']> }): PersistedSettings {
  const lastCall = callbacks.save.mock.calls[callbacks.save.mock.calls.length - 1];
  const persisted = lastCall?.[0];
  if (persisted === undefined) {
    throw new Error('Expected save callback to be called with persisted settings.');
  }
  return persisted;
}

describe('ObsidianSettingsStore', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws when getting settings store before initialization', async () => {
    const mod = await import('../services/ObsidianSettingsStore');

    expect(() => mod.getObsidianSettingsStore()).toThrowError(/has not been initialized/i);
  });

  it('returns singleton instance from init/get and keeps first callbacks', async () => {
    const mod = await import('../services/ObsidianSettingsStore');

    const firstCallbacks = createCallbacks(null);
    const secondCallbacks = createCallbacks(null);

    const first = mod.initObsidianSettingsStore('/first-default', firstCallbacks);
    const second = mod.initObsidianSettingsStore('/second-default', secondCallbacks);
    const fromGet = mod.getObsidianSettingsStore();

    await first.load();

    expect(firstCallbacks.save).toHaveBeenCalled();

    expect(first).toBe(second);
    expect(fromGet).toBe(first);
    expect(firstCallbacks.load).toHaveBeenCalledTimes(1);
    expect(secondCallbacks.load).not.toHaveBeenCalled();
  });

  it('loads existing settings, maps model values, and persists serialized state', async () => {
    const mod = await import('../services/ObsidianSettingsStore');

    const lastLoginAt = 1_700_000_000_000;
    const lastRefreshAt = 1_700_000_600_000;
    const sessionExpiresAt = 1_700_001_200_000;

    const callbacks = createCallbacks({
      accountEmail: 'user@example.com',
      lastLoginAt,
      lastRefreshAt,
      sessionExpiresAt,
      lastLoginError: null,
      latestEventId: 'evt-123',
      vaultRootNodeUid: 'folder-456',
      enableFileLogging: true,
      logLevel: mod.LogLevel.warn,
      remoteVaultRootPath: '',
      ignoredPaths: ['.obsidian/cache'],
      remoteFileStateSnapshot: createSnapshot([
        ['docs/a.md', 'sha-a'],
        ['docs/b.md', null]
      ])
    });

    const store = mod.initObsidianSettingsStore('/remote-default', callbacks);

    await store.load();

    expect(callbacks.save).toHaveBeenCalled();

    expect(store.get('accountEmail')).toBe('user@example.com');
    expect(store.get('lastLoginAt')?.toISOString()).toBe(new Date(lastLoginAt).toISOString());
    expect(store.get('lastRefreshAt')?.toISOString()).toBe(new Date(lastRefreshAt).toISOString());
    expect(store.get('sessionExpiresAt')?.toISOString()).toBe(new Date(sessionExpiresAt).toISOString());
    expect(store.get('enableFileLogging')).toBe(true);
    expect(store.get('logLevel')).toBe(mod.LogLevel.warn);
    expect(store.get('remoteVaultRootPath')).toBe('/remote-default');
    expect(store.get('ignoredPaths')).toEqual(['.obsidian/cache']);
    expect(store.getRemoteFileStateSnapshot()).toEqual(
      createSnapshot([
        ['docs/a.md', 'sha-a'],
        ['docs/b.md', null]
      ])
    );

    const eventId = store.get('latestEventId');
    expect(Option.isSome(eventId)).toBe(true);
    if (Option.isSome(eventId)) {
      expect(eventId.value.eventId).toBe('evt-123');
    }

    const vaultRootNodeUid = store.get('vaultRootNodeUid');
    expect(Option.isSome(vaultRootNodeUid)).toBe(true);
    if (Option.isSome(vaultRootNodeUid)) {
      expect(vaultRootNodeUid.value.uid).toBe('folder-456');
    }

    const persisted = getLastPersisted(callbacks);
    expect(persisted).toEqual({
      accountEmail: 'user@example.com',
      lastLoginAt,
      lastRefreshAt,
      sessionExpiresAt,
      lastLoginError: null,
      latestEventId: 'evt-123',
      vaultRootNodeUid: 'folder-456',
      enableFileLogging: true,
      logLevel: mod.LogLevel.warn,
      ignoredPaths: ['.obsidian/cache'],
      remoteVaultRootPath: '/remote-default',
      remoteFileStateSnapshot: createSnapshot([
        ['docs/a.md', 'sha-a'],
        ['docs/b.md', null]
      ])
    });
  });

  it('loads null settings with defaults and persists default remote root path', async () => {
    const mod = await import('../services/ObsidianSettingsStore');

    const callbacks = createCallbacks(null);
    const store = mod.initObsidianSettingsStore('/default-root', callbacks);

    await store.load();

    expect(callbacks.save).toHaveBeenCalled();

    expect(store.get('remoteVaultRootPath')).toBe('/default-root');
    expect(store.get('logLevel')).toBe(mod.LogLevel.info);
    expect(store.get('ignoredPaths')).toEqual([]);
    expect(store.getRemoteFileStateSnapshot()).toBeNull();

    const persisted = getLastPersisted(callbacks);
    expect(persisted.remoteVaultRootPath).toBe('/default-root');
    expect(persisted.logLevel).toBe(mod.LogLevel.info);
    expect(persisted.ignoredPaths).toEqual([]);
    expect(persisted.remoteFileStateSnapshot).toBeNull();
  });

  it('persists settings changes from set and session metadata updates', async () => {
    const mod = await import('../services/ObsidianSettingsStore');

    const callbacks = createCallbacks(null);
    const store = mod.initObsidianSettingsStore('/default-root', callbacks);

    await store.load();
    callbacks.save.mockClear();

    store.set('accountEmail', 'new@example.com');
    store.set('ignoredPaths', ['private/', 'tmp/']);
    store.setRemoteFileStateSnapshot(
      createSnapshot([
        ['docs/updated.md', 'sha-updated'],
        ['docs/missing-sha.md', null]
      ])
    );

    const now = new Date('2026-03-06T12:00:00.000Z');
    const refreshed = new Date('2026-03-06T12:10:00.000Z');
    const expires = new Date('2026-03-06T13:00:00.000Z');

    const session: ProtonSession = {
      uid: 'uid-1',
      userId: 'user-id',
      accessToken: 'access',
      refreshToken: 'refresh',
      scope: 'scope',
      createdAt: now,
      updatedAt: now,
      lastRefreshAt: refreshed,
      expiresAt: expires
    };

    store.set('lastLoginAt', session.updatedAt);
    store.set('lastRefreshAt', session.lastRefreshAt);
    store.set('sessionExpiresAt', session.expiresAt);
    store.set('lastLoginError', null);

    expect(callbacks.save).toHaveBeenCalled();

    expect(store.get('accountEmail')).toBe('new@example.com');
    expect(store.get('ignoredPaths')).toEqual(['private/', 'tmp/']);
    expect(store.getRemoteFileStateSnapshot()).toEqual(
      createSnapshot([
        ['docs/updated.md', 'sha-updated'],
        ['docs/missing-sha.md', null]
      ])
    );
    expect(store.get('lastLoginAt')?.toISOString()).toBe(now.toISOString());
    expect(store.get('lastRefreshAt')?.toISOString()).toBe(refreshed.toISOString());
    expect(store.get('sessionExpiresAt')?.toISOString()).toBe(expires.toISOString());

    const persisted = getLastPersisted(callbacks);
    expect(persisted.accountEmail).toBe('new@example.com');
    expect(persisted.ignoredPaths).toEqual(['private/', 'tmp/']);
    expect(persisted.remoteFileStateSnapshot).toEqual(
      createSnapshot([
        ['docs/updated.md', 'sha-updated'],
        ['docs/missing-sha.md', null]
      ])
    );
    expect(persisted.lastLoginAt).toBe(now.getTime());
    expect(persisted.lastRefreshAt).toBe(refreshed.getTime());
    expect(persisted.sessionExpiresAt).toBe(expires.getTime());
  });

  it('reset clears auth/session fields', async () => {
    const mod = await import('../services/ObsidianSettingsStore');

    const callbacks = createCallbacks({
      accountEmail: 'user@example.com',
      lastLoginAt: 1_700_000_000_000,
      lastRefreshAt: 1_700_000_100_000,
      sessionExpiresAt: 1_700_000_200_000,
      lastLoginError: 'Old error',
      latestEventId: 'evt-1',
      vaultRootNodeUid: null,
      enableFileLogging: false,
      logLevel: mod.LogLevel.error,
      ignoredPaths: ['keep/me'],
      remoteVaultRootPath: '/custom-root',
      remoteFileStateSnapshot: createSnapshot([['keep/me/file.md', 'sha-keep']])
    });

    const store = mod.initObsidianSettingsStore('/default-root', callbacks);

    await store.load();
    callbacks.save.mockClear();

    store.reset();

    expect(callbacks.save).toHaveBeenCalled();

    expect(store.get('accountEmail')).toBe('');
    expect(store.get('lastLoginAt')).toBeNull();
    expect(store.get('lastRefreshAt')).toBeNull();
    expect(store.get('sessionExpiresAt')).toBeNull();
    expect(store.get('lastLoginError')).toBeNull();
    expect(Option.isNone(store.get('latestEventId'))).toBe(true);
    expect(store.getRemoteFileStateSnapshot()).toBeNull();

    expect(store.get('ignoredPaths')).toEqual(['keep/me']);
    expect(store.get('remoteVaultRootPath')).toBe('/custom-root');

    const persisted = getLastPersisted(callbacks);
    expect(persisted.lastLoginAt).toBeNull();
    expect(persisted.lastRefreshAt).toBeNull();
    expect(persisted.sessionExpiresAt).toBeNull();
    expect(persisted.lastLoginError).toBeNull();
    expect(persisted.latestEventId).toBeNull();
    expect(persisted.remoteFileStateSnapshot).toBeNull();
    expect(persisted.ignoredPaths).toEqual(['keep/me']);
    expect(persisted.remoteVaultRootPath).toBe('/custom-root');
  });

  it('clears snapshot when remote root path changes', async () => {
    const mod = await import('../services/ObsidianSettingsStore');

    const callbacks = createCallbacks({
      accountEmail: 'user@example.com',
      lastLoginAt: null,
      lastRefreshAt: null,
      sessionExpiresAt: null,
      lastLoginError: null,
      latestEventId: null,
      vaultRootNodeUid: 'folder-456',
      enableFileLogging: false,
      logLevel: mod.LogLevel.info,
      ignoredPaths: [],
      remoteVaultRootPath: '/current-root',
      remoteFileStateSnapshot: createSnapshot([['docs/a.md', 'sha-a']])
    });

    const store = mod.initObsidianSettingsStore('/default-root', callbacks);

    await store.load();
    callbacks.save.mockClear();

    store.set('remoteVaultRootPath', '/next-root');

    expect(store.getRemoteFileStateSnapshot()).toBeNull();
    expect(getLastPersisted(callbacks).remoteFileStateSnapshot).toBeNull();
  });

  it('clears snapshot when ignored paths change', async () => {
    const mod = await import('../services/ObsidianSettingsStore');

    const callbacks = createCallbacks({
      accountEmail: 'user@example.com',
      lastLoginAt: null,
      lastRefreshAt: null,
      sessionExpiresAt: null,
      lastLoginError: null,
      latestEventId: null,
      vaultRootNodeUid: 'folder-456',
      enableFileLogging: false,
      logLevel: mod.LogLevel.info,
      ignoredPaths: ['private/**'],
      remoteVaultRootPath: '/current-root',
      remoteFileStateSnapshot: createSnapshot([['docs/a.md', 'sha-a']])
    });

    const store = mod.initObsidianSettingsStore('/default-root', callbacks);

    await store.load();
    callbacks.save.mockClear();

    store.set('ignoredPaths', ['private/**', 'tmp/**']);

    expect(store.getRemoteFileStateSnapshot()).toBeNull();
    expect(getLastPersisted(callbacks).remoteFileStateSnapshot).toBeNull();
  });
});
