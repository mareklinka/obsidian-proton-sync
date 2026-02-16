import * as openpgp from "openpgp";
import type {
  ProtonDriveAccount,
  ProtonDriveAccountAddress,
} from "@protontech/drive-sdk";
import type { PrivateKey, PublicKey } from "@protontech/drive-sdk/dist/crypto";

import { ProtonApiClient } from "./proton-api";
import { computeKeyPasswordFromSalt } from "./proton-srp";
import type { PluginLogger } from "./logger";

export type KeyPassphraseProvider = () => Promise<string | null>;

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

type ProtonKeySaltEntry = {
  ID?: string;
  KeySalt?: string;
};

type ProtonKeySaltsResponse = {
  KeySalts?: ProtonKeySaltEntry[];
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
  private addressesCache: CachedValue<ProtonDriveAccountAddress[]> | null =
    null;
  private publicKeysCache = new Map<string, CachedValue<PublicKey[]>>();
  private keySaltsCache: CachedValue<Map<string, string>> | null = null;

  constructor(
    private readonly apiClient: ProtonApiClient,
    private readonly getKeyPassphrase: KeyPassphraseProvider,
    private readonly logger?: PluginLogger,
  ) {}

  async getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
    const addresses = await this.getOwnAddresses();
    if (!addresses.length) {
      throw new Error("No Proton addresses found for this account.");
    }

    return addresses[0];
  }

  async getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
    const cached = this.getCached(this.addressesCache);
    if (cached) {
      return cached;
    }

    const response =
      await this.apiClient.getJson<ProtonAddressesResponse>(
        "/core/v4/addresses",
      );

    const addresses = response.Addresses ?? [];
    if (!addresses.length) {
      throw new Error("No Proton addresses returned from API.");
    }

    const user = await this.getUser();

    const passphrase = await this.getKeyPassphrase();
    if (!passphrase) {
      throw new Error("Missing key passphrase for decrypting Proton keys.");
    }

    const keySalts = await this.getKeySalts();
    const mergedSalts = keySalts;

    const userKey = await resolveUserKey(
      passphrase,
      user.Keys ?? [],
      mergedSalts,
      this.logger,
    );

    const mapped = await Promise.all(
      addresses.map((address) =>
        mapAddress(address, passphrase, mergedSalts, userKey, this.logger),
      ),
    );

    const sorted = [...mapped].sort((left, right) =>
      left.addressId.localeCompare(right.addressId),
    );

    this.addressesCache = {
      fetchedAt: Date.now(),
      data: sorted,
    };

    return sorted;
  }

  async getOwnAddress(
    emailOrAddressId: string,
  ): Promise<ProtonDriveAccountAddress> {
    const addresses = await this.getOwnAddresses();
    const match = addresses.find(
      (address) =>
        address.addressId === emailOrAddressId ||
        address.email === emailOrAddressId,
    );
    if (!match) {
      throw new Error("No Proton address found for the given identifier.");
    }

    return match;
  }

  async hasProtonAccount(email: string): Promise<boolean> {
    this.logger?.debug("Checking if email has a Proton account", { email });
    const response = await this.fetchPublicKeysRaw(email);
    if (typeof response.IsProtonMail === "boolean") {
      return response.IsProtonMail;
    }

    if (typeof response.IsProtonMail === "number") {
      return response.IsProtonMail !== 0;
    }

    return (response.Keys ?? []).length > 0;
  }

  async getPublicKeys(email: string): Promise<PublicKey[]> {
    this.logger?.debug("Fetching public keys for email", { email });
    const cached = this.getCached(this.publicKeysCache.get(email) ?? null);
    if (cached) {
      return cached;
    }

    const response = await this.fetchPublicKeysRaw(email);
    const keys = response.Keys ?? [];

    const parsed = await Promise.all(
      keys.map(
        async (entry) =>
          (await openpgp.readKey({
            armoredKey: entry.PublicKey,
          })) as unknown as PublicKey,
      ),
    );

    this.publicKeysCache.set(email, {
      fetchedAt: Date.now(),
      data: parsed,
    });

    return parsed;
  }

  private async fetchPublicKeysRaw(
    email: string,
  ): Promise<ProtonPublicKeysResponse> {
    return this.apiClient.getJson<ProtonPublicKeysResponse>(
      "/core/v4/keys/all?Email=" + encodeURIComponent(email),
      {},
    );
  }

  private async getKeySalts(): Promise<Map<string, string>> {
    const cached = this.getCached(this.keySaltsCache);
    if (cached) {
      return cached;
    }

    try {
      const response = await this.apiClient.getJson<ProtonKeySaltsResponse>(
        "/core/v4/keys/salts",
      );
      const entries = response.KeySalts ?? [];
      const map = new Map<string, string>();
      for (const entry of entries) {
        if (!entry.ID || !entry.KeySalt) {
          continue;
        }
        map.set(entry.ID, entry.KeySalt);
      }

      this.keySaltsCache = {
        fetchedAt: Date.now(),
        data: map,
      };

      return map;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("scope")) {
        this.logger?.warn(
          "Key salts unavailable due to missing scope; falling back to address key salts if present.",
        );
        const empty = new Map<string, string>();
        this.keySaltsCache = {
          fetchedAt: Date.now(),
          data: empty,
        };
        return empty;
      }

      throw error;
    }
  }

  private async getUser(): Promise<ProtonUser> {
    const response =
      await this.apiClient.getJson<ProtonUserResponse>("/core/v4/users");
    if (!response.User) {
      throw new Error("No Proton user returned from API.");
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

async function mapAddress(
  address: ProtonAddress,
  passphrase: string,
  keySalts: Map<string, string>,
  userKey: openpgp.PrivateKey | null,
  logger?: PluginLogger,
): Promise<ProtonDriveAccountAddress> {
  const keys = address.Keys ?? [];
  const parsedKeys = await Promise.all(
    keys.map((key) =>
      parsePrivateKey(key, passphrase, keySalts, userKey, logger),
    ),
  );

  const primaryIndex = keys.findIndex(
    (key) => key.Primary === true || key.Primary === 1,
  );
  const resolvedPrimaryIndex = primaryIndex >= 0 ? primaryIndex : 0;

  return {
    email: address.Email,
    addressId: address.ID,
    primaryKeyIndex: resolvedPrimaryIndex,
    keys: parsedKeys,
  };
}

async function parsePrivateKey(
  key: ProtonAddressKey,
  passphrase: string,
  keySalts: Map<string, string>,
  userKey: openpgp.PrivateKey | null,
  logger?: PluginLogger,
): Promise<{ id: string; key: PrivateKey }> {
  logger?.debug("Parsing private key for address", { keyId: key.ID });

  const privateKey = await openpgp.readPrivateKey({
    armoredKey: key.PrivateKey,
  });

  if (privateKey.isDecrypted()) {
    logger?.debug("Private key is not encrypted", { keyId: key.ID });

    return {
      id: key.ID,
      key: privateKey as unknown as PrivateKey,
    };
  }

  if (key.Token && key.Signature && userKey) {
    try {
      const tokenPassphrase = await derivePassphraseFromToken(
        key.Token,
        key.Signature,
        userKey,
      );

      const decrypted = await openpgp.decryptKey({
        privateKey,
        passphrase: Buffer.from(tokenPassphrase).toString("utf8"),
      });

      logger?.debug("Decrypted key using token-derived passphrase", {
        keyId: key.ID,
      });

      return {
        id: key.ID,
        key: decrypted as unknown as PrivateKey,
      };
    } catch (tokenError) {
      logger?.warn(
        "Failed to decrypt key using token-derived passphrase",
        { keyId: key.ID },
        tokenError,
      );
    }
  }

  const keySalt = keySalts.get(key.ID);
  if (!keySalt) {
    logger?.warn(
      "No key salt available for deriving passphrase; cannot attempt decryption",
      { keyId: key.ID },
    );

    throw new Error(
      "No key salt available for deriving pas `sphrase; cannot attempt decryption",
    );
  }

  try {
    const derivedPassphrase = computeKeyPasswordFromSalt(passphrase, keySalt);
    const decrypted = await openpgp.decryptKey({
      privateKey,
      passphrase: derivedPassphrase,
    });
    logger?.debug("Decrypted key using salt-derived passphrase", {
      keyId: key.ID,
    });
    return {
      id: key.ID,
      key: decrypted as unknown as PrivateKey,
    };
  } catch (derivedError) {
    logger?.warn(
      "Failed to decrypt key with salt-derived passphrase",
      { keyId: key.ID },
      derivedError,
    );

    throw new Error("Failed to decrypt key with salt-derived passphrase");
  }
}

async function resolveUserKey(
  passphrase: string,
  keys: ProtonAddressKey[],
  keySalts: Map<string, string>,
  logger?: PluginLogger,
): Promise<openpgp.PrivateKey | null> {
  const activeKeys = keys.filter(
    (key) =>
      key.Active === undefined || key.Active === true || key.Active === 1,
  );
  if (!activeKeys.length) {
    logger?.warn("No active user keys available for token decryption");
    return null;
  }

  const primaryKey =
    activeKeys.find((key) => key.Primary === true || key.Primary === 1) ??
    activeKeys[0];
  const privateKey = await openpgp.readPrivateKey({
    armoredKey: primaryKey.PrivateKey,
  });
  if (privateKey.isDecrypted()) {
    return privateKey;
  }

  const keySalt = keySalts.get(primaryKey.ID);
  if (!keySalt) {
    logger?.warn(
      "No key salt available for user key; cannot decrypt user key",
      { keyId: primaryKey.ID },
    );
    return null;
  }

  try {
    const derivedPassphrase = computeKeyPasswordFromSalt(passphrase, keySalt);
    const decrypted = await openpgp.decryptKey({
      privateKey,
      passphrase: derivedPassphrase,
    });
    logger?.debug("Decrypted user key successfully", { keyId: primaryKey.ID });
    return decrypted;
  } catch (error) {
    logger?.warn(
      "Failed to decrypt user key with salt-derived passphrase",
      { keyId: primaryKey.ID },
      error,
    );
    return null;
  }
}

async function derivePassphraseFromToken(
  tokenArmored: string,
  signatureArmored: string,
  userKey: openpgp.PrivateKey,
): Promise<Uint8Array> {
  const message = await openpgp.readMessage({ armoredMessage: tokenArmored });
  const signature = await openpgp.readSignature({
    armoredSignature: signatureArmored,
  });
  const decrypted = await openpgp.decrypt({
    message,
    decryptionKeys: userKey,
    format: "binary",
  });

  const data =
    decrypted.data instanceof Uint8Array
      ? decrypted.data
      : new TextEncoder().encode(String(decrypted.data));

  const verification = await openpgp.verify({
    message: await openpgp.createMessage({ binary: data }),
    signature,
    verificationKeys: userKey.toPublic(),
  });

  if (!verification.signatures.length) {
    throw new Error("Token signature verification failed: no signatures.");
  }

  await verification.signatures[0].verified;
  return data;
}
