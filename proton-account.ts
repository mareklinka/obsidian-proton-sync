import * as openpgp from 'openpgp';
import type { ProtonDriveAccount, ProtonDriveAccountAddress } from '@protontech/drive-sdk';
import type { PrivateKey, PublicKey } from '@protontech/drive-sdk/dist/crypto';

import { ProtonApiClient } from './proton-api';

export type KeyPassphraseProvider = () => Promise<string | null>;

type ProtonAddressKey = {
  ID: string;
  PrivateKey: string;
  Primary?: number | boolean;
};

type ProtonAddress = {
  ID: string;
  Email: string;
  Order?: number;
  Keys?: ProtonAddressKey[];
};

type ProtonAddressesResponse = {
  Addresses?: ProtonAddress[];
};

type ProtonPublicKeyEntry = {
  PublicKey: string;
};

type ProtonPublicKeysResponse = {
  Keys?: ProtonPublicKeyEntry[];
  IsProtonMail?: number | boolean;
};

type CachedValue<T> = {
  fetchedAt: number;
  data: T;
};

const CACHE_TTL_MS = 5 * 60 * 1000;

export class ProtonAccount implements ProtonDriveAccount {
  private addressesCache: CachedValue<ProtonDriveAccountAddress[]> | null = null;
  private publicKeysCache = new Map<string, CachedValue<PublicKey[]>>();

  constructor(
    private readonly apiClient: ProtonApiClient,
    private readonly getKeyPassphrase: KeyPassphraseProvider
  ) {}

  async getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
    const addresses = await this.getOwnAddresses();
    if (!addresses.length) {
      throw new Error('No Proton addresses found for this account.');
    }

    return addresses[0];
  }

  async getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
    const cached = this.getCached(this.addressesCache);
    if (cached) {
      return cached;
    }

    const response = await this.apiClient.getJson<ProtonAddressesResponse>('/core/v4/addresses');
    const addresses = response.Addresses ?? [];
    if (!addresses.length) {
      throw new Error('No Proton addresses returned from API.');
    }

    const passphrase = await this.getKeyPassphrase();
    if (!passphrase) {
      throw new Error('Missing key passphrase for decrypting Proton keys.');
    }

    const mapped = await Promise.all(addresses.map((address) => mapAddress(address, passphrase)));
    const sorted = [...mapped].sort((left, right) => left.addressId.localeCompare(right.addressId));

    this.addressesCache = {
      fetchedAt: Date.now(),
      data: sorted
    };

    return sorted;
  }

  async getOwnAddress(emailOrAddressId: string): Promise<ProtonDriveAccountAddress> {
    const addresses = await this.getOwnAddresses();
    const match = addresses.find((address) => address.addressId === emailOrAddressId || address.email === emailOrAddressId);
    if (!match) {
      throw new Error('No Proton address found for the given identifier.');
    }

    return match;
  }

  async hasProtonAccount(email: string): Promise<boolean> {
    const response = await this.fetchPublicKeysRaw(email);
    if (typeof response.IsProtonMail === 'boolean') {
      return response.IsProtonMail;
    }

    if (typeof response.IsProtonMail === 'number') {
      return response.IsProtonMail !== 0;
    }

    return (response.Keys ?? []).length > 0;
  }

  async getPublicKeys(email: string): Promise<PublicKey[]> {
    const cached = this.getCached(this.publicKeysCache.get(email) ?? null);
    if (cached) {
      return cached;
    }

    const response = await this.fetchPublicKeysRaw(email);
    const keys = response.Keys ?? [];

    const parsed = await Promise.all(
      keys.map(async (entry) => (await openpgp.readKey({ armoredKey: entry.PublicKey })) as unknown as PublicKey)
    );

    this.publicKeysCache.set(email, {
      fetchedAt: Date.now(),
      data: parsed
    });

    return parsed;
  }

  private async fetchPublicKeysRaw(email: string): Promise<ProtonPublicKeysResponse> {
    return this.apiClient.postJson<ProtonPublicKeysResponse>('/core/v4/keys', { Email: email });
  }

  private getCached<T>(cache: CachedValue<T> | null): T | null {
    if (!cache) {
      return null;
    }

    if (Date.now() - cache.fetchedAt > CACHE_TTL_MS) {
      return null;
    }

    return cache.data;
  }
}

async function mapAddress(
  address: ProtonAddress,
  passphrase: string
): Promise<ProtonDriveAccountAddress> {
  const keys = address.Keys ?? [];
  const parsedKeys = await Promise.all(keys.map((key) => parsePrivateKey(key, passphrase)));

  const primaryIndex = keys.findIndex((key) => key.Primary === true || key.Primary === 1);
  const resolvedPrimaryIndex = primaryIndex >= 0 ? primaryIndex : 0;

  return {
    email: address.Email,
    addressId: address.ID,
    primaryKeyIndex: resolvedPrimaryIndex,
    keys: parsedKeys
  };
}

async function parsePrivateKey(
  key: ProtonAddressKey,
  passphrase: string
): Promise<{ id: string; key: PrivateKey }> {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: key.PrivateKey });
  const decrypted = privateKey.isDecrypted()
    ? privateKey
    : await openpgp.decryptKey({ privateKey, passphrase });

  return {
    id: key.ID,
    key: decrypted as unknown as PrivateKey
  };
}
