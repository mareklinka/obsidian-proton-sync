import type { SecretStorage } from 'obsidian';

export const { init: initObsidianSecretStore, get: getObsidianSecretStore } = (function (): {
  init: (this: void, store: SecretStorage) => ObsidianSecretStore;
  get: (this: void) => ObsidianSecretStore;
} {
  let instance: ObsidianSecretStore | null = null;

  return {
    init: function (this: void, store: SecretStorage): ObsidianSecretStore {
      return (instance ??= new ObsidianSecretStore(store));
    },
    get: function (this: void): ObsidianSecretStore {
      if (!instance) {
        throw new Error('ObsidianSecretStore has not been initialized. Please call initObsidianSecretStore first.');
      }
      return instance;
    }
  };
})();

class ObsidianSecretStore {
  public constructor(private readonly store: SecretStorage) {}

  public get(key: ObsidianSecretKey): string | null {
    return this.store.getSecret(key);
  }

  public set(key: ObsidianSecretKey, value: string): void {
    this.store.setSecret(key, value);
  }

  public clear(key: ObsidianSecretKey): void {
    this.store.setSecret(key, '');
  }
}

export type ObsidianSecretKey = 'proton-drive-sync-session' | 'proton-drive-sync-salted-passphrases';
