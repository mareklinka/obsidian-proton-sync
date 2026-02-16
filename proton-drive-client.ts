import { requestUrl } from 'obsidian';
import {
  CachedCryptoMaterial,
  MemoryCache,
  ProtonDriveClient,
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
import { ProtonApiClient } from './proton-api';
import { ProtonAccount, type KeyPassphraseProvider } from './proton-account';
import { createOpenPgpCrypto } from './proton-openpgp';
import { buildSrpProofsFromParams } from './proton-srp';

type SessionProvider = () => ProtonSession | null;
type SrpModule = ProtonDriveClientContructorParameters['srpModule'];
type SrpVerifier = Awaited<ReturnType<SrpModule['getSrpVerifier']>>;

export function createProtonDriveClient(
  getSession: SessionProvider,
  getKeyPassphrase: KeyPassphraseProvider,
  appVersion: string,
  config?: ProtonDriveConfig
): ProtonDriveClient {
  const httpClient = new ObsidianHttpClient(getSession, appVersion);
  const apiClient = new ProtonApiClient(getSession, appVersion);
  const entitiesCache: ProtonDriveEntitiesCache = new MemoryCache<string>();
  const cryptoCache: ProtonDriveCryptoCache = new MemoryCache<CachedCryptoMaterial>();
  const account = new ProtonAccount(apiClient, getKeyPassphrase);
  const openPGPCryptoModule = createOpenPgpCrypto();
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
