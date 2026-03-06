import { beforeEach, describe, expect, it, vi } from 'vitest';

type SecretStorageMock = {
  getSecret: ReturnType<typeof vi.fn<(key: string) => string | null>>;
  setSecret: ReturnType<typeof vi.fn<(key: string, value: string) => Promise<void>>>;
};

function createSecretStorageMock(): SecretStorageMock {
  return {
    getSecret: vi.fn(),
    setSecret: vi.fn().mockResolvedValue(undefined)
  };
}

describe('ObsidianSecretStore', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws when getting store before initialization', async () => {
    const mod = await import('../services/ObsidianSecretStore');

    expect(() => mod.getObsidianSecretStore()).toThrowError(/has not been initialized/i);
  });

  it('returns singleton instance from init/get and keeps first store', async () => {
    const mod = await import('../services/ObsidianSecretStore');
    const firstStore = createSecretStorageMock();
    const secondStore = createSecretStorageMock();

    const first = mod.initObsidianSecretStore(firstStore as never);
    const second = mod.initObsidianSecretStore(secondStore as never);
    const fromGet = mod.getObsidianSecretStore();

    first.set('proton-drive-sync-session', 'session-token');

    expect(first).toBe(second);
    expect(fromGet).toBe(first);
    expect(firstStore.setSecret).toHaveBeenCalledWith('proton-drive-sync-session', 'session-token');
    expect(secondStore.setSecret).not.toHaveBeenCalled();
  });

  it('delegates get/set/clear to underlying SecretStorage', async () => {
    const mod = await import('../services/ObsidianSecretStore');
    const store = createSecretStorageMock();
    store.getSecret.mockReturnValue('stored-session');

    const secretStore = mod.initObsidianSecretStore(store as never);

    const value = secretStore.get('proton-drive-sync-session');
    secretStore.set('proton-drive-sync-salted-passphrases', 'encrypted-value');
    secretStore.clear('proton-drive-sync-salted-passphrases');

    expect(value).toBe('stored-session');
    expect(store.getSecret).toHaveBeenCalledWith('proton-drive-sync-session');
    expect(store.setSecret).toHaveBeenNthCalledWith(1, 'proton-drive-sync-salted-passphrases', 'encrypted-value');
    expect(store.setSecret).toHaveBeenNthCalledWith(2, 'proton-drive-sync-salted-passphrases', '');
  });

  it('clears session secret by writing empty string', async () => {
    const mod = await import('../services/ObsidianSecretStore');
    const store = createSecretStorageMock();

    const secretStore = mod.initObsidianSecretStore(store as never);

    secretStore.clear('proton-drive-sync-session');

    expect(store.setSecret).toHaveBeenCalledTimes(1);
    expect(store.setSecret).toHaveBeenCalledWith('proton-drive-sync-session', '');
  });
});
