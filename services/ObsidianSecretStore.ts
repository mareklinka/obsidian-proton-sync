import type { SecretStorage } from 'obsidian';

export const { init: initObsidianSecretStore, get: getObsidianSecretStore } = (function () {
  let instance: ObsidianSecretStore | null = null;

  return {
    init: function getObsidianSecretStore(store: SecretStorage): ObsidianSecretStore {
      return (instance ??= new ObsidianSecretStore(store));
    },
    get: function getObsidianSecretStoreInstance(): ObsidianSecretStore {
      if (!instance) {
        throw new Error('ObsidianSecretStore has not been initialized. Please call initObsidianSecretStore first.');
      }
      return instance;
    }
  };
})();

class ObsidianSecretStore {
  public constructor(private readonly store: SecretStorage) {}

  get(key: ObsidianSecretKey): string | null {
    return this.store.getSecret(key);
  }

  set(key: ObsidianSecretKey, value: string): void {
    this.store.setSecret(key, value);
  }

  clear(key: ObsidianSecretKey): void {
    this.store.setSecret(key, '');
  }
}

export type ObsidianSecretKey = 'proton-drive-sync-session' | 'proton-drive-sync-salted-passphrases';
