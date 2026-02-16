import { requestUrl } from 'obsidian';
import {
  CachedCryptoMaterial,
  MemoryCache,
  ProtonDriveClient,
  type OpenPGPCrypto,
  type ProtonDriveAccount,
  type ProtonDriveAccountAddress,
  type ProtonDriveClientContructorParameters,
  type ProtonDriveCryptoCache,
  type ProtonDriveConfig,
  type ProtonDriveEntitiesCache,
  type ProtonDriveHTTPClient,
  type ProtonDriveHTTPClientBlobRequest,
  type ProtonDriveHTTPClientJsonRequest
} from '@protontech/drive-sdk';

import type { ProtonSession } from './session-store';
import { buildSrpProofsFromParams } from './proton-srp';

type SessionProvider = () => ProtonSession | null;
type SrpModule = ProtonDriveClientContructorParameters['srpModule'];
type SrpVerifier = Awaited<ReturnType<SrpModule['getSrpVerifier']>>;
type OpenPGPPublicKey = Parameters<OpenPGPCrypto['generateSessionKey']>[0][number];
type OpenPGPPrivateKey = Awaited<ReturnType<OpenPGPCrypto['generateKey']>>['privateKey'];
type OpenPGPSessionKey = Awaited<ReturnType<OpenPGPCrypto['generateSessionKey']>>;
type OpenPGPVerificationStatus = Awaited<ReturnType<OpenPGPCrypto['verify']>>['verified'];

export function createProtonDriveClient(
  getSession: SessionProvider,
  appVersion: string,
  config?: ProtonDriveConfig
): ProtonDriveClient {
  const httpClient = new ObsidianHttpClient(getSession, appVersion);
  const entitiesCache: ProtonDriveEntitiesCache = new MemoryCache<string>();
  const cryptoCache: ProtonDriveCryptoCache = new MemoryCache<CachedCryptoMaterial>();
  const account = new PlaceholderAccount();
  const openPGPCryptoModule = new PlaceholderOpenPGPCrypto();
  const srpModule = new PlaceholderSrpModule();

  return new ProtonDriveClient({
    httpClient,
    entitiesCache,
    cryptoCache,
    account,
    openPGPCryptoModule,
    srpModule,
    config
  });
}

class ObsidianHttpClient implements ProtonDriveHTTPClient {
  private readonly appVersionHeader: string;

  constructor(private readonly getSession: SessionProvider, appVersion: string) {
    this.appVersionHeader = `external-drive-obsidian-proton-sync@${appVersion}`;
  }

  async fetchJson(request: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
    return this.fetch(request, true);
  }

  async fetchBlob(request: ProtonDriveHTTPClientBlobRequest): Promise<Response> {
    return this.fetch(request, false);
  }

  private async fetch(
    request: ProtonDriveHTTPClientJsonRequest | ProtonDriveHTTPClientBlobRequest,
    isJson: boolean
  ): Promise<Response> {
    const session = this.getSession();
    if (!session) {
      throw new Error('No Proton session available for SDK requests.');
    }

    const headers = this.buildHeaders(request.headers, session);
    let body: XMLHttpRequestBodyInit | undefined;
    if ('json' in request && request.json) {
      body = JSON.stringify(request.json);
    } else if ('body' in request) {
      body = request.body;
    }

    const resolvedBody = await normalizeBody(body);

    const response = await requestUrl({
      url: request.url,
      method: request.method,
      headers: headersToObject(headers),
      contentType: isJson ? 'application/json' : undefined,
      body: resolvedBody
    });

    if (isJson) {
      return new Response(response.text, {
        status: response.status,
        headers: response.headers
      });
    }

    return new Response(response.arrayBuffer, {
      status: response.status,
      headers: response.headers
    });
  }

  private buildHeaders(baseHeaders: Headers, session: ProtonSession): Headers {
    const headers = new Headers(baseHeaders);

    headers.set('x-pm-uid', session.uid);
    headers.set('authorization', `Bearer ${session.accessToken}`);
    headers.set('x-pm-appversion', this.appVersionHeader);

    return headers;
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key] = value;
  });
  return output;
}

async function normalizeBody(body: XMLHttpRequestBodyInit | undefined): Promise<string | ArrayBuffer | undefined> {
  if (!body) {
    return undefined;
  }

  if (typeof body === 'string') {
    return body;
  }

  if (body instanceof ArrayBuffer) {
    return body;
  }

  if (ArrayBuffer.isView(body)) {
    return body.buffer;
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  if (body instanceof Blob) {
    return body.arrayBuffer();
  }

  throw new Error('Unsupported request body type for Obsidian requestUrl.');
}

class PlaceholderAccount implements ProtonDriveAccount {
  async getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
    throw new Error('Account provider not implemented.');
  }

  async getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
    throw new Error('Account provider not implemented.');
  }

  async getOwnAddress(_emailOrAddressId: string): Promise<ProtonDriveAccountAddress> {
    throw new Error('Account provider not implemented.');
  }

  async hasProtonAccount(_email: string): Promise<boolean> {
    throw new Error('Account provider not implemented.');
  }

  async getPublicKeys(_email: string): Promise<OpenPGPPublicKey[]> {
    throw new Error('Account provider not implemented.');
  }
}

class PlaceholderOpenPGPCrypto implements OpenPGPCrypto {
  generatePassphrase(): string {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async generateSessionKey(_encryptionKeys: OpenPGPPublicKey[]): Promise<OpenPGPSessionKey> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async encryptSessionKey(
    _sessionKey: OpenPGPSessionKey,
    _encryptionKeys: OpenPGPPublicKey | OpenPGPPublicKey[]
  ): Promise<{ keyPacket: Uint8Array }> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async encryptSessionKeyWithPassword(
    _sessionKey: OpenPGPSessionKey,
    _password: string
  ): Promise<{ keyPacket: Uint8Array }> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async generateKey(_passphrase: string): Promise<{ privateKey: OpenPGPPrivateKey; armoredKey: string }> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async encryptArmored(
    _data: Uint8Array,
    _encryptionKeys: OpenPGPPublicKey[],
    _sessionKey?: OpenPGPSessionKey
  ): Promise<{ armoredData: string }> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async encryptAndSign(
    _data: Uint8Array,
    _sessionKey: OpenPGPSessionKey,
    _encryptionKeys: OpenPGPPublicKey[],
    _signingKey: OpenPGPPrivateKey
  ): Promise<{ encryptedData: Uint8Array }> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async encryptAndSignArmored(
    _data: Uint8Array,
    _sessionKey: OpenPGPSessionKey | undefined,
    _encryptionKeys: OpenPGPPublicKey[],
    _signingKey: OpenPGPPrivateKey,
    _options?: { compress?: boolean }
  ): Promise<{ armoredData: string }> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async encryptAndSignDetached(
    _data: Uint8Array,
    _sessionKey: OpenPGPSessionKey,
    _encryptionKeys: OpenPGPPublicKey[],
    _signingKey: OpenPGPPrivateKey
  ): Promise<{ encryptedData: Uint8Array; signature: Uint8Array }> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async encryptAndSignDetachedArmored(
    _data: Uint8Array,
    _sessionKey: OpenPGPSessionKey,
    _encryptionKeys: OpenPGPPublicKey[],
    _signingKey: OpenPGPPrivateKey
  ): Promise<{ armoredData: string; armoredSignature: string }> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async sign(
    _data: Uint8Array,
    _signingKey: OpenPGPPrivateKey,
    _signatureContext: string
  ): Promise<{ signature: Uint8Array }> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async signArmored(
    _data: Uint8Array,
    _signingKey: OpenPGPPrivateKey | OpenPGPPrivateKey[]
  ): Promise<{ signature: string }> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async verify(
    _data: Uint8Array,
    _signature: Uint8Array,
    _verificationKeys: OpenPGPPublicKey | OpenPGPPublicKey[]
  ): Promise<{ verified: OpenPGPVerificationStatus; verificationErrors?: Error[] }> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async verifyArmored(
    _data: Uint8Array,
    _armoredSignature: string,
    _verificationKeys: OpenPGPPublicKey | OpenPGPPublicKey[],
    _signatureContext?: string
  ): Promise<{ verified: OpenPGPVerificationStatus; verificationErrors?: Error[] }> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async decryptSessionKey(
    _data: Uint8Array,
    _decryptionKeys: OpenPGPPrivateKey | OpenPGPPrivateKey[]
  ): Promise<OpenPGPSessionKey> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async decryptArmoredSessionKey(
    _armoredData: string,
    _decryptionKeys: OpenPGPPrivateKey | OpenPGPPrivateKey[]
  ): Promise<OpenPGPSessionKey> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async decryptKey(_armoredKey: string, _passphrase: string): Promise<OpenPGPPrivateKey> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async decryptAndVerify(
    _data: Uint8Array,
    _sessionKey: OpenPGPSessionKey,
    _verificationKeys: OpenPGPPublicKey | OpenPGPPublicKey[]
  ): Promise<{ data: Uint8Array; verified: OpenPGPVerificationStatus; verificationErrors?: Error[] }> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async decryptAndVerifyDetached(
    _data: Uint8Array,
    _signature: Uint8Array | undefined,
    _sessionKey: OpenPGPSessionKey,
    _verificationKeys?: OpenPGPPublicKey | OpenPGPPublicKey[]
  ): Promise<{ data: Uint8Array; verified: OpenPGPVerificationStatus; verificationErrors?: Error[] }> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async decryptArmored(
    _armoredData: string,
    _decryptionKeys: OpenPGPPrivateKey | OpenPGPPrivateKey[]
  ): Promise<Uint8Array> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async decryptArmoredAndVerify(
    _armoredData: string,
    _decryptionKeys: OpenPGPPrivateKey | OpenPGPPrivateKey[],
    _verificationKeys: OpenPGPPublicKey | OpenPGPPublicKey[]
  ): Promise<{ data: Uint8Array; verified: OpenPGPVerificationStatus; verificationErrors?: Error[] }> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async decryptArmoredAndVerifyDetached(
    _armoredData: string,
    _armoredSignature: string | undefined,
    _sessionKey: OpenPGPSessionKey,
    _verificationKeys: OpenPGPPublicKey | OpenPGPPublicKey[]
  ): Promise<{ data: Uint8Array; verified: OpenPGPVerificationStatus; verificationErrors?: Error[] }> {
    throw new Error('OpenPGP crypto module not implemented.');
  }

  async decryptArmoredWithPassword(_armoredData: string, _password: string): Promise<Uint8Array> {
    throw new Error('OpenPGP crypto module not implemented.');
  }
}

class PlaceholderSrpModule implements SrpModule {
  async getSrp(
    version: number,
    modulus: string,
    serverEphemeral: string,
    salt: string,
    password: string
  ): Promise<{ expectedServerProof: string; clientProof: string; clientEphemeral: string }> {
    const proofs = await buildSrpProofsFromParams(version, modulus, serverEphemeral, salt, password);
    return {
      expectedServerProof: proofs.expectedServerProof,
      clientProof: proofs.clientProof,
      clientEphemeral: proofs.clientEphemeral
    };
  }

  async getSrpVerifier(_password: string): Promise<SrpVerifier> {
    throw new Error('SRP verifier generation not implemented.');
  }

  async computeKeyPassword(_password: string, _salt: string): Promise<string> {
    throw new Error('Key password computation not implemented.');
  }
}
