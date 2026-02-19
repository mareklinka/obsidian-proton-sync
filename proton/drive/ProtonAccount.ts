import * as openpgp from 'openpgp';
import type { ProtonDriveAccount, ProtonDriveAccountAddress } from '@protontech/drive-sdk';
import type { PrivateKey, PublicKey } from '@protontech/drive-sdk/dist/crypto';
import { ProtonSecretStore } from '../auth/ProtonSecretStore';
import { SALTED_PASSPHRASES_SECRET_KEY } from '../Constants';
import { ProtonSessionService } from '../auth/ProtonSessionService';
import { ProtonSession } from '../auth/ProtonSession';
import { getJson } from '../ProtonApiClient';

type ProtonAddressKey = {
  ID: string;
  PrivateKey: string;
  Primary?: number | boolean;
  Token?: string;
  Signature?: string;
  Active?: number | boolean;
};

type ProtonAddress = {
  ID: string;
  Email: string;
  Order?: number;
  Keys?: ProtonAddressKey[];
};

type ProtonUser = {
  ID: string;
  Name: string;
  Keys?: ProtonAddressKey[];
};

type ProtonUserResponse = {
  User?: ProtonUser;
};

type ProtonAddressesResponse = {
  Addresses?: ProtonAddress[];
};

type ProtonPublicKeyEntry = {
  PublicKey: string;
};

type ProtonPublicKeysResponse = {
  Address: {
    Keys?: ProtonPublicKeyEntry[];
  };
  IsProtonMail?: number | boolean;
};

type CachedValue<T> = {
  fetchedAt: number;
  data: T;
};

const CACHE_TTL_MS = 5 * 60 * 1000;

export class ProtonAccount implements ProtonDriveAccount {
  private readonly saltedKeyPasswords: Record<string, string> = {};
  private addressesCache: CachedValue<ProtonDriveAccountAddress[]> | null = null;
  private publicKeysCache = new Map<string, CachedValue<PublicKey[]>>();

  private currentSession: ProtonSession | null = null;

  constructor(
    private readonly authService: ProtonSessionService,
    private readonly secretStore: ProtonSecretStore
  ) {
    this.saltedKeyPasswords = JSON.parse(this.secretStore.get(SALTED_PASSPHRASES_SECRET_KEY) ?? '{}') as Record<
      string,
      string
    >;

    authService.currentSession$.subscribe(sessionState => {
      this.currentSession = sessionState.state === 'ok' ? sessionState.session : null;
    });
  }

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

    if (!this.currentSession) {
      throw new Error('No Proton addresses found for this account.');
    }

    const response = await getJson<ProtonAddressesResponse>(
      '/core/v4/addresses',
      this.currentSession,
      this.authService.appVersionHeader
    );

    const addresses = response.Addresses ?? [];
    if (!addresses.length) {
      throw new Error('No Proton addresses returned from API.');
    }

    const user = await this.getUser();

    const userKey = await resolveUserKey(user.Keys ?? [], this.saltedKeyPasswords);

    const mapped = await Promise.all(addresses.map(address => mapAddress(address, userKey!)));

    const sorted = [...mapped].sort((left, right) => left.addressId.localeCompare(right.addressId));

    this.addressesCache = {
      fetchedAt: Date.now(),
      data: sorted
    };

    return sorted;
  }

  async getOwnAddress(emailOrAddressId: string): Promise<ProtonDriveAccountAddress> {
    const addresses = await this.getOwnAddresses();
    const match = addresses.find(
      address => address.addressId === emailOrAddressId || address.email === emailOrAddressId
    );
    if (!match) {
      throw new Error('No Proton address found for the given identifier.');
    }

    return match;
  }

  async hasProtonAccount(email: string): Promise<boolean> {
    if (!this.currentSession) {
      throw new Error('No Proton session available for API request.');
    }

    const response = await this.fetchPublicKeysRaw(email, this.currentSession);

    return (response.Address?.Keys ?? []).length > 0;
  }

  async getPublicKeys(email: string): Promise<PublicKey[]> {
    const cached = this.getCached(this.publicKeysCache.get(email) ?? null);
    if (cached) {
      return cached;
    }

    if (!this.currentSession) {
      throw new Error('No Proton session available for API request.');
    }

    const response = await this.fetchPublicKeysRaw(email, this.currentSession);
    const keys = response?.Address?.Keys ?? [];

    const parsed = await Promise.all(
      keys.map(
        async entry =>
          (await openpgp.readKey({
            armoredKey: entry.PublicKey
          })) as unknown as PublicKey
      )
    );

    this.publicKeysCache.set(email, {
      fetchedAt: Date.now(),
      data: parsed
    });

    return parsed;
  }

  private async fetchPublicKeysRaw(email: string, session: ProtonSession): Promise<ProtonPublicKeysResponse> {
    return getJson<ProtonPublicKeysResponse>('/core/v4/keys/all', session, this.authService.appVersionHeader, {
      Email: email
    });
  }

  private async getUser(): Promise<ProtonUser> {
    if (!this.currentSession) {
      throw new Error('No Proton session available for API request.');
    }

    const response = await getJson<ProtonUserResponse>(
      '/core/v4/users',
      this.currentSession,
      this.authService.appVersionHeader
    );

    if (!response.User) {
      throw new Error('No Proton user returned from API.');
    }

    return response.User;
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

async function mapAddress(address: ProtonAddress, userKey: openpgp.PrivateKey): Promise<ProtonDriveAccountAddress> {
  const keys = address.Keys ?? [];
  const parsedKeys = await Promise.all(
    keys.map(async key => ({
      id: key.ID,
      key: (await decryptKeyUsingToken(key, userKey)) as unknown as PrivateKey
    }))
  );

  const primaryIndex = keys.findIndex(key => key.Primary === true || key.Primary === 1);
  const resolvedPrimaryIndex = primaryIndex >= 0 ? primaryIndex : 0;

  return {
    email: address.Email,
    addressId: address.ID,
    primaryKeyIndex: resolvedPrimaryIndex,
    keys: parsedKeys
  };
}

async function resolveUserKey(
  keys: ProtonAddressKey[],
  passphrases: Record<string, string>
): Promise<openpgp.PrivateKey | null> {
  const activeKeys = keys.filter(key => key.Active === undefined || key.Active === true || key.Active === 1);

  if (!activeKeys.length) {
    return null;
  }

  const primaryKey = activeKeys.find(key => key.Primary === true || key.Primary === 1) ?? activeKeys[0];

  return decryptKey(primaryKey, passphrases);
}

async function decryptKey(
  key: ProtonAddressKey,
  passphrases: Record<string, string>
): Promise<openpgp.PrivateKey | null> {
  const privateKey = await openpgp.readPrivateKey({
    armoredKey: key.PrivateKey
  });

  if (privateKey.isDecrypted()) {
    return privateKey;
  }

  const passphrase = passphrases[key.ID];
  if (!passphrase) {
    return null;
  }

  try {
    const decrypted = await openpgp.decryptKey({
      privateKey,
      passphrase
    });

    return decrypted;
  } catch (error) {
    return null;
  }
}

async function decryptKeyUsingToken(key: ProtonAddressKey, userKey: openpgp.PrivateKey | null): Promise<PrivateKey> {
  const privateKey = await openpgp.readPrivateKey({
    armoredKey: key.PrivateKey
  });

  if (privateKey.isDecrypted()) {
    return privateKey as unknown as PrivateKey;
  }

  if (key.Token && key.Signature && userKey) {
    const tokenPassphrase = await derivePassphraseFromToken(key.Token, key.Signature, userKey);

    const decrypted = await openpgp.decryptKey({
      privateKey,
      passphrase: Buffer.from(tokenPassphrase).toString('utf8')
    });

    return decrypted as unknown as PrivateKey;
  }

  throw new Error(`Decryption of key via user key failed (key ID: ${key.ID}).`);
}

async function derivePassphraseFromToken(
  tokenArmored: string,
  signatureArmored: string,
  userKey: openpgp.PrivateKey
): Promise<Uint8Array> {
  const message = await openpgp.readMessage({ armoredMessage: tokenArmored });
  const signature = await openpgp.readSignature({
    armoredSignature: signatureArmored
  });
  const decrypted = await openpgp.decrypt({
    message,
    decryptionKeys: userKey,
    format: 'binary'
  });

  const data = decrypted.data instanceof Uint8Array ? decrypted.data : new TextEncoder().encode(String(decrypted.data));

  const verification = await openpgp.verify({
    message: await openpgp.createMessage({ binary: data }),
    signature,
    verificationKeys: userKey.toPublic()
  });

  if (!verification.signatures.length) {
    throw new Error('Token signature verification failed: no signatures.');
  }

  await verification.signatures[0].verified;
  return data;
}
