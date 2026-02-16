import * as openpgp from 'openpgp';
import { OpenPGPCryptoWithCryptoProxy, type OpenPGPCrypto, type OpenPGPCryptoProxy } from '@protontech/drive-sdk';
import { VERIFICATION_STATUS, type PrivateKey, type PublicKey, type SessionKey } from '@protontech/drive-sdk/dist/crypto';

export function createOpenPgpCrypto(): OpenPGPCrypto {
  return new OpenPGPCryptoWithCryptoProxy(new OpenPgpCryptoProxy());
}

class OpenPgpCryptoProxy implements OpenPGPCryptoProxy {
  async generateKey(options: { userIDs: { name: string }[]; type: 'ecc'; curve: 'ed25519Legacy' }): Promise<PrivateKey> {
    const result = await openpgp.generateKey({
      type: options.type,
      curve: options.curve,
      format: 'object',
      userIDs: options.userIDs
    });

    return result.privateKey as unknown as PrivateKey;
  }

  async exportPrivateKey(options: { privateKey: PrivateKey; passphrase: string | null }): Promise<string> {
    const key = options.passphrase
      ? await openpgp.encryptKey({ privateKey: toOpenPgpPrivateKey(options.privateKey), passphrase: options.passphrase })
      : toOpenPgpPrivateKey(options.privateKey);

    return key.armor();
  }

  async importPrivateKey(options: { armoredKey: string; passphrase: string | null }): Promise<PrivateKey> {
    const privateKey = await openpgp.readPrivateKey({ armoredKey: options.armoredKey });
    const decrypted = options.passphrase
      ? await openpgp.decryptKey({ privateKey, passphrase: options.passphrase })
      : privateKey;

    return decrypted as unknown as PrivateKey;
  }

  async generateSessionKey(options: { recipientKeys: PublicKey[] }): Promise<SessionKey> {
    const sessionKey = await openpgp.generateSessionKey({ encryptionKeys: toOpenPgpPublicKeysRequired(options.recipientKeys) });
    return mapSessionKey(sessionKey);
  }

  async encryptSessionKey(options: SessionKey & { format: 'binary'; encryptionKeys?: PublicKey | PublicKey[]; passwords?: string[] }): Promise<Uint8Array> {
    const openPgpSessionKey = toOpenPgpSessionKey(options);
    return openpgp.encryptSessionKey({
      data: options.data,
      algorithm: openPgpSessionKey.algorithm,
      aeadAlgorithm: openPgpSessionKey.aeadAlgorithm,
      format: 'binary',
      encryptionKeys: toArray(options.encryptionKeys) as openpgp.PublicKey[] | undefined,
      passwords: options.passwords
    });
  }

  async decryptSessionKey(options: {
    armoredMessage?: string;
    binaryMessage?: Uint8Array;
    decryptionKeys: PrivateKey | PrivateKey[];
  }): Promise<SessionKey | undefined> {
    const decrypted = options.armoredMessage
      ? await openpgp.decryptSessionKeys({
          message: await openpgp.readMessage({ armoredMessage: options.armoredMessage }),
          decryptionKeys: toOpenPgpPrivateKeys(options.decryptionKeys)
        })
      : await openpgp.decryptSessionKeys({
          message: await openpgp.readMessage({ binaryMessage: options.binaryMessage ?? new Uint8Array() }),
          decryptionKeys: toOpenPgpPrivateKeys(options.decryptionKeys)
        });

    if (!decrypted.length) {
      return undefined;
    }

    const [first] = decrypted;
    return mapSessionKey({
      data: first.data,
      algorithm: first.algorithm ?? 'aes256'
    });
  }

  async encryptMessage<Format extends 'armored' | 'binary' = 'armored', Detached extends boolean = false>(options: {
    format?: Format;
    binaryData: Uint8Array;
    sessionKey?: SessionKey;
    encryptionKeys: PublicKey[];
    signingKeys?: PrivateKey;
    detached?: Detached;
    compress?: boolean;
  }): Promise<Detached extends true ? { message: Format extends 'binary' ? Uint8Array : string; signature: Format extends 'binary' ? Uint8Array : string } : { message: Format extends 'binary' ? Uint8Array : string }> {
    const message = await openpgp.createMessage({ binary: options.binaryData });
    const format = options.format ?? 'armored';

    const encrypted = format === 'binary'
      ? await openpgp.encrypt({
          message,
          format: 'binary',
          encryptionKeys: toOpenPgpPublicKeys(options.encryptionKeys),
          signingKeys: options.signingKeys ? [toOpenPgpPrivateKey(options.signingKeys)] : undefined,
          sessionKey: options.sessionKey ? toOpenPgpSessionKey(options.sessionKey) : undefined,
          config: options.compress === false ? { allowUnauthenticatedMessages: true } : undefined
        })
      : await openpgp.encrypt({
          message,
          format: 'armored',
          encryptionKeys: toOpenPgpPublicKeys(options.encryptionKeys),
          signingKeys: options.signingKeys ? [toOpenPgpPrivateKey(options.signingKeys)] : undefined,
          sessionKey: options.sessionKey ? toOpenPgpSessionKey(options.sessionKey) : undefined,
          config: options.compress === false ? { allowUnauthenticatedMessages: true } : undefined
        });

    if (!options.detached) {
      return { message: encrypted as any } as any;
    }

    if (!options.signingKeys) {
      throw new Error('Detached encryption requires signing keys.');
    }

    const signature = format === 'binary'
      ? await openpgp.sign({
          message,
          format: 'binary',
          signingKeys: [toOpenPgpPrivateKey(options.signingKeys)],
          detached: true
        })
      : await openpgp.sign({
          message,
          format: 'armored',
          signingKeys: [toOpenPgpPrivateKey(options.signingKeys)],
          detached: true
        });

    return {
      message: encrypted as any,
      signature: signature as any
    } as any;
  }

  async decryptMessage<Format extends 'utf8' | 'binary' = 'utf8'>(options: {
    format: Format;
    armoredMessage?: string;
    binaryMessage?: Uint8Array;
    armoredSignature?: string;
    binarySignature?: Uint8Array;
    sessionKeys?: SessionKey;
    passwords?: string[];
    decryptionKeys?: PrivateKey | PrivateKey[];
    verificationKeys?: PublicKey | PublicKey[];
  }): Promise<{ data: Format extends 'binary' ? Uint8Array : string; verificationStatus: VERIFICATION_STATUS; verificationErrors?: Error[] }> {
    const signature = options.armoredSignature
      ? await openpgp.readSignature({ armoredSignature: options.armoredSignature })
      : options.binarySignature
      ? await openpgp.readSignature({ binarySignature: options.binarySignature })
      : undefined;

    const result = options.armoredMessage
      ? options.format === 'binary'
        ? await openpgp.decrypt({
            message: await openpgp.readMessage({ armoredMessage: options.armoredMessage }),
            format: 'binary',
            decryptionKeys: toOpenPgpPrivateKeys(options.decryptionKeys),
            passwords: options.passwords,
            sessionKeys: options.sessionKeys ? [toOpenPgpSessionKey(options.sessionKeys)] : undefined,
            verificationKeys: toOpenPgpPublicKeys(options.verificationKeys),
            signature
          })
        : await openpgp.decrypt({
            message: await openpgp.readMessage({ armoredMessage: options.armoredMessage }),
            format: 'utf8',
            decryptionKeys: toOpenPgpPrivateKeys(options.decryptionKeys),
            passwords: options.passwords,
            sessionKeys: options.sessionKeys ? [toOpenPgpSessionKey(options.sessionKeys)] : undefined,
            verificationKeys: toOpenPgpPublicKeys(options.verificationKeys),
            signature
          })
      : options.format === 'binary'
      ? await openpgp.decrypt({
          message: await openpgp.readMessage({ binaryMessage: options.binaryMessage ?? new Uint8Array() }),
          format: 'binary',
          decryptionKeys: toOpenPgpPrivateKeys(options.decryptionKeys),
          passwords: options.passwords,
          sessionKeys: options.sessionKeys ? [toOpenPgpSessionKey(options.sessionKeys)] : undefined,
          verificationKeys: toOpenPgpPublicKeys(options.verificationKeys),
          signature
        })
      : await openpgp.decrypt({
          message: await openpgp.readMessage({ binaryMessage: options.binaryMessage ?? new Uint8Array() }),
          format: 'utf8',
          decryptionKeys: toOpenPgpPrivateKeys(options.decryptionKeys),
          passwords: options.passwords,
          sessionKeys: options.sessionKeys ? [toOpenPgpSessionKey(options.sessionKeys)] : undefined,
          verificationKeys: toOpenPgpPublicKeys(options.verificationKeys),
          signature
        });

    const verification = await mapVerificationResult(result.signatures);

    return {
      data: result.data as any,
      verificationStatus: verification.status,
      verificationErrors: verification.errors
    };
  }

  async signMessage<Format extends 'binary' | 'armored' = 'armored'>(options: {
    format: Format;
    binaryData: Uint8Array;
    signingKeys: PrivateKey | PrivateKey[];
    detached: boolean;
    signatureContext?: { critical: boolean; value: string };
  }): Promise<Format extends 'binary' ? Uint8Array : string> {
    const message = await openpgp.createMessage({ binary: options.binaryData });

    const signatureNotations = options.signatureContext
      ? [
          {
            name: 'context',
            value: new TextEncoder().encode(options.signatureContext.value),
            humanReadable: true,
            critical: options.signatureContext.critical
          }
        ]
      : undefined;

    const signature = options.format === 'binary'
      ? await openpgp.sign({
          message,
          format: 'binary',
          signingKeys: toOpenPgpPrivateKeysRequired(options.signingKeys),
          detached: options.detached,
          signatureNotations
        })
      : await openpgp.sign({
          message,
          format: 'armored',
          signingKeys: toOpenPgpPrivateKeysRequired(options.signingKeys),
          detached: options.detached,
          signatureNotations
        });

    return signature as any;
  }

  async verifyMessage(options: {
    binaryData: Uint8Array;
    armoredSignature?: string;
    binarySignature?: Uint8Array;
    verificationKeys: PublicKey | PublicKey[];
    signatureContext?: { critical: boolean; value: string };
  }): Promise<{ verificationStatus: VERIFICATION_STATUS; errors?: Error[] }> {
    const message = await openpgp.createMessage({ binary: options.binaryData });
    const signature = options.armoredSignature
      ? await openpgp.readSignature({ armoredSignature: options.armoredSignature })
      : options.binarySignature
      ? await openpgp.readSignature({ binarySignature: options.binarySignature })
      : undefined;

    const result = await openpgp.verify({
      message,
      signature,
      verificationKeys: toOpenPgpPublicKeysRequired(options.verificationKeys)
    });

    const verification = await mapVerificationResult(result.signatures);

    return {
      verificationStatus: verification.status,
      errors: verification.errors
    };
  }
}

function toArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (!value) {
    return undefined;
  }

  return Array.isArray(value) ? value : [value];
}

function toOpenPgpPublicKeys(keys: PublicKey | PublicKey[] | undefined): openpgp.PublicKey[] | undefined {
  const resolved = toArray(keys);
  if (!resolved) {
    return undefined;
  }

  return resolved.map((key) => key as unknown as openpgp.PublicKey);
}

function toOpenPgpPublicKeysRequired(keys: PublicKey | PublicKey[]): openpgp.PublicKey[] {
  return toArray(keys)?.map((key) => key as unknown as openpgp.PublicKey) ?? [];
}

function toOpenPgpPrivateKeys(keys: PrivateKey | PrivateKey[] | undefined): openpgp.PrivateKey[] | undefined {
  const resolved = toArray(keys);
  if (!resolved) {
    return undefined;
  }

  return resolved.map((key) => toOpenPgpPrivateKey(key));
}

function toOpenPgpPrivateKeysRequired(keys: PrivateKey | PrivateKey[]): openpgp.PrivateKey[] {
  return toArray(keys)?.map((key) => toOpenPgpPrivateKey(key)) ?? [];
}

function toOpenPgpPrivateKey(key: PrivateKey): openpgp.PrivateKey {
  return key as unknown as openpgp.PrivateKey;
}

function toOpenPgpSessionKey(sessionKey: SessionKey): openpgp.SessionKey {
  const candidate = sessionKey as Partial<openpgp.SessionKey>;

  return {
    data: sessionKey.data,
    algorithm: candidate.algorithm ?? 'aes256',
    aeadAlgorithm: candidate.aeadAlgorithm
  };
}

function mapSessionKey(sessionKey: openpgp.SessionKey): SessionKey {
  return {
    data: sessionKey.data,
    algorithm: sessionKey.algorithm,
    aeadAlgorithm: sessionKey.aeadAlgorithm
  } as SessionKey;
}

type VerificationSummary = {
  status: VERIFICATION_STATUS;
  errors?: Error[];
};

type OpenPgpVerification = openpgp.VerifyMessageResult['signatures'][number];

async function mapVerificationResult(signatures: OpenPgpVerification[]): Promise<VerificationSummary> {
  if (!signatures.length) {
    return { status: VERIFICATION_STATUS.NOT_SIGNED };
  }

  const errors: Error[] = [];
  let hasValid = false;

  for (const signature of signatures) {
    try {
      await signature.verified;
      hasValid = true;
    } catch (error) {
      if (error instanceof Error) {
        errors.push(error);
      } else {
        errors.push(new Error('Signature verification failed.'));
      }
    }
  }

  if (hasValid) {
    return { status: VERIFICATION_STATUS.SIGNED_AND_VALID };
  }

  return {
    status: VERIFICATION_STATUS.SIGNED_AND_INVALID,
    errors
  };
}
