import type { App } from 'obsidian';

import type { SecretStore } from '../../public/types';

export const PROTON_SESSION_SECRET_KEY = 'proton-drive-sync-session';
export const PROTON_KEY_PASSPHRASE_SECRET_KEY = 'proton-drive-sync-key-passphrase';
export const PROTON_SALTED_PASSPHRASES_SECRET_KEY = 'proton-drive-sync-salted-passphrases';

type ObsidianSecretStorage = {
  getSecret: (key: string) => string | Promise<string>;
  setSecret: (key: string, value: string) => void | Promise<void>;
};

export class SecretRepository implements SecretStore {
  private readonly cache = new Map<string, string>();

  constructor(private readonly app: App) {}

  get(key: string): string | null {
    if (this.cache.has(key)) {
      return this.cache.get(key) ?? null;
    }

    const storage = this.app.secretStorage as ObsidianSecretStorage;
    const value = storage.getSecret(key);
    if (typeof value === 'string') {
      this.cache.set(key, value);
      return value || null;
    }

    void value.then(resolved => {
      this.cache.set(key, resolved ?? '');
    });

    return null;
  }

  set(key: string, value: string): void {
    this.cache.set(key, value);
    const storage = this.app.secretStorage as ObsidianSecretStorage;
    void storage.setSecret(key, value);
  }

  clear(key: string): void {
    this.cache.delete(key);
    const storage = this.app.secretStorage as ObsidianSecretStorage;
    void storage.setSecret(key, '');
  }
}
