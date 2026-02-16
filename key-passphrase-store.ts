import type { App } from 'obsidian';

const KEY_PASSPHRASE_STORAGE_KEY = 'proton-drive-sync.key-passphrase';

export async function loadKeyPassphrase(app: App): Promise<string | null> {
  const stored = await app.secretStorage.getSecret(KEY_PASSPHRASE_STORAGE_KEY);
  if (!stored) {
    return null;
  }

  return stored;
}

export async function saveKeyPassphrase(app: App, passphrase: string): Promise<void> {
  await app.secretStorage.setSecret(KEY_PASSPHRASE_STORAGE_KEY, passphrase);
}

export async function clearKeyPassphrase(app: App): Promise<void> {
  await app.secretStorage.setSecret(KEY_PASSPHRASE_STORAGE_KEY, '');
}
