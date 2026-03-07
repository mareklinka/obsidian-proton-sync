import { sha256 } from '@noble/hashes/sha2.js';
import { Data, Effect, Option } from 'effect';

import type { ProtonSession } from '../proton/auth/ProtonSession';
import { getLogger } from './ConsoleLogger';
import { bcryptBase64Encode, bcryptHashWithSalt } from './CryptoHelpers';
import { getObsidianSecretStore, type ObsidianSecretKey } from './ObsidianSecretStore';

const ENCRYPTION_VERSION = 1;
const ENCRYPTION_KDF = 'bcrypt-sha256';
const MASTER_PASSWORD_SALT_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
export const POST_SYNC_MEMORY_CLEAR_DELAY_MS = 5 * 60 * 1000; // 5 minutes

export type EncryptedSecretLabel = 'session' | 'salted-passphrases';

const SESSION_STORAGE_KEY: ObsidianSecretKey = 'proton-drive-sync-session';
const SALTED_PASSPHRASES_SECRET_KEY: ObsidianSecretKey = 'proton-drive-sync-salted-passphrases';

export interface EncryptedPersistedSessionData {
  session: ProtonSession;
  saltedPassphrases: Record<string, string>;
}

export interface PersistedProtonSession {
  uid: string;
  userId: string | null;
  accessToken: string;
  refreshToken: string;
  scope: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  lastRefreshAt: number;
}

interface EncryptedEnvelope {
  v: number;
  kdf: string;
  salt: string;
  iv: string;
  ciphertext: string;
  aadLabel: EncryptedSecretLabel;
}

export const { init: initEncryptedSecretStore, get: getEncryptedSecretStore } = (function () {
  let instance: EncryptedSecretStore | null = null;

  return {
    init: function (this: void): EncryptedSecretStore {
      return (instance ??= new EncryptedSecretStore(getObsidianSecretStore()));
    },
    get: function (this: void): EncryptedSecretStore {
      if (!instance) {
        instance = new EncryptedSecretStore(getObsidianSecretStore());
      }

      return instance;
    }
  };
})();

class EncryptedSecretStore {
  #unlockedSessionData: Option.Option<EncryptedPersistedSessionData> = Option.none();
  #memoryClearTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  readonly #logger = getLogger('EncryptedSecretStore');

  public constructor(private readonly baseStore: ReturnType<typeof getObsidianSecretStore>) {}

  public hasPersistedSessionData(): boolean {
    const session = this.baseStore.get(SESSION_STORAGE_KEY);
    const salted = this.baseStore.get(SALTED_PASSPHRASES_SECRET_KEY);

    return Boolean(session && session.trim() !== '' && salted && salted.trim() !== '');
  }

  public persistSessionData(
    data: EncryptedPersistedSessionData,
    masterPassword: string
  ): Effect.Effect<void, SecretEncryptionFailedError> {
    return Effect.gen(this, function* () {
      this.#logger.debug('Persisting session data to secret store');

      const persistedSession: PersistedProtonSession = {
        ...data.session,
        createdAt: data.session.createdAt.getTime(),
        updatedAt: data.session.updatedAt.getTime(),
        expiresAt: data.session.expiresAt.getTime(),
        lastRefreshAt: data.session.lastRefreshAt.getTime()
      };
      const encryptedSession = yield* this.#encryptSecretJson(
        'session',
        JSON.stringify(persistedSession),
        masterPassword
      );
      const encryptedPassphrases = yield* this.#encryptSecretJson(
        'salted-passphrases',
        JSON.stringify(data.saltedPassphrases),
        masterPassword
      );

      this.baseStore.set(SESSION_STORAGE_KEY, encryptedSession);
      this.baseStore.set(SALTED_PASSPHRASES_SECRET_KEY, encryptedPassphrases);

      this.#unlockedSessionData = Option.some(data);
      this.#cancelScheduledMemoryClearInternal();
    });
  }

  public loadSessionData(
    masterPassword: string
  ): Effect.Effect<EncryptedPersistedSessionData, PersistedSecretsInvalidFormatError | SecretDecryptionFailedError> {
    return Effect.gen(this, function* () {
      this.#logger.debug('Loading session data from secret store');
      if (Option.isSome(this.#unlockedSessionData)) {
        return this.#unlockedSessionData.value;
      }

      const storedSession = this.baseStore.get(SESSION_STORAGE_KEY);
      const storedSaltedPassphrases = this.baseStore.get(SALTED_PASSPHRASES_SECRET_KEY);

      if (
        !storedSession ||
        storedSession.trim() === '' ||
        !storedSaltedPassphrases ||
        storedSaltedPassphrases.trim() === ''
      ) {
        return yield* new PersistedSecretsInvalidFormatError();
      }

      if (!this.#isEncryptedEnvelopeJson(storedSession) || !this.#isEncryptedEnvelopeJson(storedSaltedPassphrases)) {
        yield* this.clearSessionData();
        return yield* new PersistedSecretsInvalidFormatError();
      }

      const decryptedSession = yield* this.#decryptSecretJson('session', storedSession, masterPassword);
      const decryptedSaltedPassphrases = yield* this.#decryptSecretJson(
        'salted-passphrases',
        storedSaltedPassphrases,
        masterPassword
      );

      const parsedSession = yield* parseSessionJson(decryptedSession);
      const session = {
        ...parsedSession,
        createdAt: new Date(parsedSession.createdAt),
        updatedAt: new Date(parsedSession.updatedAt),
        expiresAt: new Date(parsedSession.expiresAt),
        lastRefreshAt: new Date(parsedSession.lastRefreshAt)
      };
      const saltedPassphrases = yield* parseSaltedPassphrasesJson(decryptedSaltedPassphrases);

      const data = { session, saltedPassphrases };
      this.#unlockedSessionData = Option.some(data);
      this.#cancelScheduledMemoryClearInternal();

      return data;
    });
  }

  public getUnlockedSessionData(): Option.Option<EncryptedPersistedSessionData> {
    return this.#unlockedSessionData;
  }

  public clearUnlockedSessionData(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#cancelScheduledMemoryClearInternal();
      this.#unlockedSessionData = Option.none();
    });
  }

  public cancelScheduledUnlockedDataClear(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#cancelScheduledMemoryClearInternal();
    });
  }

  public clearSessionData() {
    return Effect.sync(() => {
      this.baseStore.clear(SESSION_STORAGE_KEY);
      this.baseStore.clear(SALTED_PASSPHRASES_SECRET_KEY);
      this.#cancelScheduledMemoryClearInternal();
      this.#unlockedSessionData = Option.none();
    });
  }

  public scheduleMemoryClear(): void {
    this.#logger.info('Scheduling in-memory session data clear in %d ms', POST_SYNC_MEMORY_CLEAR_DELAY_MS);
    this.#cancelScheduledMemoryClearInternal();

    this.#memoryClearTimeoutId = globalThis.setTimeout(() => {
      this.#logger.debug('Clearing in-memory session data after scheduled delay');
      this.#unlockedSessionData = Option.none();
      this.#memoryClearTimeoutId = null;
    }, POST_SYNC_MEMORY_CLEAR_DELAY_MS);
  }

  #cancelScheduledMemoryClearInternal(): void {
    if (this.#memoryClearTimeoutId === null) {
      return;
    }

    globalThis.clearTimeout(this.#memoryClearTimeoutId);
    this.#memoryClearTimeoutId = null;
  }

  #encryptSecretJson(
    label: EncryptedSecretLabel,
    payloadJson: string,
    masterPassword: string
  ): Effect.Effect<string, SecretEncryptionFailedError> {
    return Effect.tryPromise({
      try: async () => {
        const saltBytes = randomBytes(MASTER_PASSWORD_SALT_BYTES);
        const ivBytes = randomBytes(AES_GCM_IV_BYTES);

        const key = await deriveAesKey(masterPassword, saltBytes);
        const plaintext = new TextEncoder().encode(payloadJson);

        const encrypted = await globalThis.crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv: toArrayBuffer(ivBytes),
            additionalData: toArrayBuffer(new TextEncoder().encode(label))
          },
          key,
          toArrayBuffer(plaintext)
        );

        const envelope: EncryptedEnvelope = {
          v: ENCRYPTION_VERSION,
          kdf: ENCRYPTION_KDF,
          salt: toBase64(saltBytes),
          iv: toBase64(ivBytes),
          ciphertext: toBase64(new Uint8Array(encrypted)),
          aadLabel: label
        };

        return JSON.stringify(envelope);
      },
      catch: () => new SecretEncryptionFailedError()
    });
  }

  #decryptSecretJson(
    expectedLabel: EncryptedSecretLabel,
    envelopeJson: string,
    masterPassword: string
  ): Effect.Effect<string, SecretDecryptionFailedError | PersistedSecretsInvalidFormatError> {
    return Effect.gen(this, function* () {
      const envelope = yield* parseEnvelope(envelopeJson);

      if (envelope.aadLabel !== expectedLabel) {
        return yield* new PersistedSecretsInvalidFormatError();
      }

      return yield* Effect.tryPromise({
        try: async () => {
          const saltBytes = fromBase64(envelope.salt);
          const ivBytes = fromBase64(envelope.iv);
          const ciphertextBytes = fromBase64(envelope.ciphertext);

          const key = await deriveAesKey(masterPassword, saltBytes);

          const decrypted = await globalThis.crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: toArrayBuffer(ivBytes),
              additionalData: toArrayBuffer(new TextEncoder().encode(expectedLabel))
            },
            key,
            toArrayBuffer(ciphertextBytes)
          );

          return new TextDecoder().decode(new Uint8Array(decrypted));
        },
        catch: () => new SecretDecryptionFailedError()
      });
    });
  }

  #isEncryptedEnvelopeJson(value: string): boolean {
    const parsed = tryParseJson(value);
    if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
      return false;
    }

    return isEnvelopeRecord(parsed);
  }
}

function parseEnvelope(value: string): Effect.Effect<EncryptedEnvelope, PersistedSecretsInvalidFormatError> {
  return Effect.try({
    try: () => {
      const parsed = JSON.parse(value) as unknown;
      if (!isEnvelopeRecord(parsed)) {
        throw new PersistedSecretsInvalidFormatError();
      }

      return parsed;
    },
    catch: () => new PersistedSecretsInvalidFormatError()
  });
}

function parseSessionJson(payload: string): Effect.Effect<PersistedProtonSession, PersistedSecretsInvalidFormatError> {
  return Effect.try({
    try: () => {
      const parsed = JSON.parse(payload) as unknown;
      if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
        throw new PersistedSecretsInvalidFormatError();
      }

      const session = parsed as Partial<PersistedProtonSession>;
      if (
        typeof session.uid !== 'string' ||
        typeof session.accessToken !== 'string' ||
        typeof session.refreshToken !== 'string'
      ) {
        throw new PersistedSecretsInvalidFormatError();
      }

      return parsed as PersistedProtonSession;
    },
    catch: () => new PersistedSecretsInvalidFormatError()
  });
}

function parseSaltedPassphrasesJson(
  payload: string
): Effect.Effect<Record<string, string>, PersistedSecretsInvalidFormatError> {
  return Effect.try({
    try: () => {
      const parsed = JSON.parse(payload) as unknown;
      if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new PersistedSecretsInvalidFormatError();
      }

      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== 'string') {
          throw new PersistedSecretsInvalidFormatError();
        }
        result[key] = value;
      }

      if (Object.keys(result).length === 0) {
        throw new PersistedSecretsInvalidFormatError();
      }

      return result;
    },
    catch: () => new PersistedSecretsInvalidFormatError()
  });
}

function isEnvelopeRecord(value: unknown): value is EncryptedEnvelope {
  if (value === null || value === undefined || typeof value !== 'object') {
    return false;
  }

  const envelope = value as Partial<EncryptedEnvelope>;

  return (
    envelope.v === ENCRYPTION_VERSION &&
    envelope.kdf === ENCRYPTION_KDF &&
    (envelope.aadLabel === 'session' || envelope.aadLabel === 'salted-passphrases') &&
    typeof envelope.salt === 'string' &&
    envelope.salt.trim().length > 0 &&
    typeof envelope.iv === 'string' &&
    envelope.iv.trim().length > 0 &&
    typeof envelope.ciphertext === 'string' &&
    envelope.ciphertext.trim().length > 0
  );
}

async function deriveAesKey(masterPassword: string, saltBytes: Uint8Array): Promise<CryptoKey> {
  const bcryptSalt = bcryptBase64Encode(saltBytes, 22);
  const bcryptOutput = bcryptHashWithSalt(masterPassword, bcryptSalt, 12);
  const rawKey = Uint8Array.from(sha256(new TextEncoder().encode(bcryptOutput)));

  return globalThis.crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function randomBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, 'base64'));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export class SecretEncryptionFailedError extends Data.TaggedError('SecretEncryptionFailedError') {}
export class SecretDecryptionFailedError extends Data.TaggedError('SecretDecryptionFailedError') {}
export class PersistedSecretsInvalidFormatError extends Data.TaggedError('PersistedSecretsInvalidFormatError') {}
