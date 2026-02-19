import type { App } from 'obsidian';

import type { SecretStore } from '../proton-integration/auth/public';
import type { ProtonSecretStore } from '../proton/auth/ProtonSecretStore';

export class ObsidianSecretRepository implements SecretStore {
  constructor(private readonly app: App) {}

  get(key: string): string | null {
    const storage = this.app.secretStorage;
    return storage.getSecret(key);
  }

  set(key: string, value: string): void {
    const storage = this.app.secretStorage;
    void storage.setSecret(key, value);
  }

  clear(key: string): void {
    const storage = this.app.secretStorage;
    void storage.setSecret(key, '');
  }
}

export class ObsidianSecretRepository2 implements ProtonSecretStore {
  constructor(private readonly app: App) {}

  get(key: string): string | null {
    const storage = this.app.secretStorage;
    return storage.getSecret(key);
  }

  set(key: string, value: string): void {
    const storage = this.app.secretStorage;
    void storage.setSecret(key, value);
  }

  clear(key: string): void {
    const storage = this.app.secretStorage;
    void storage.setSecret(key, '');
  }
}
