import {
  CachedCryptoMaterial,
  MemoryCache,
  ProtonDriveClient,
  ProtonDriveHTTPClient,
  type LatestEventIdProvider,
  type ProtonDriveClientContructorParameters,
  type ProtonDriveCryptoCache,
  type ProtonDriveEntitiesCache
} from '@protontech/drive-sdk';

import type { ProtonSession } from '../auth/ProtonSession';
import { ProtonAccount } from './ProtonAccount';
import { createOpenPgpCrypto } from './ProtonOpenPgp';
import { buildSrpProofsFromParams } from '../auth/ProtonSrp';

export type SessionProvider = () => ProtonSession | null;
type SrpModule = ProtonDriveClientContructorParameters['srpModule'];
type SrpVerifier = Awaited<ReturnType<SrpModule['getSrpVerifier']>>;

export function createProtonDriveClient(
  account: ProtonAccount,
  httpClient: ProtonDriveHTTPClient,
  latestEventIdProvider: LatestEventIdProvider
): ProtonDriveClient {
  const entitiesCache: ProtonDriveEntitiesCache = new MemoryCache<string>();
  const cryptoCache: ProtonDriveCryptoCache = new MemoryCache<CachedCryptoMaterial>();

  const openPGPCryptoModule = createOpenPgpCrypto();
  const srpModule = new PlaceholderSrpModule();

  return new ProtonDriveClient({
    httpClient,
    entitiesCache,
    cryptoCache,
    account,
    openPGPCryptoModule,
    srpModule,
    latestEventIdProvider
  });
}

export function headersToObject(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key] = value;
  });
  return output;
}

class PlaceholderSrpModule implements SrpModule {
  async getSrp(
    version: number,
    modulus: string,
    serverEphemeral: string,
    salt: string,
    password: string
  ): Promise<{
    expectedServerProof: string;
    clientProof: string;
    clientEphemeral: string;
  }> {
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
