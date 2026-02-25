import {
  CachedCryptoMaterial,
  MemoryCache,
  ProtonDriveClient,
  type ProtonDriveClientContructorParameters
} from '@protontech/drive-sdk';

import { createOpenPgpCrypto } from './ProtonOpenPgp';
import { buildSrpProofsFromParams } from '../auth/ProtonSrp';
import { getObsidianSettingsStore } from '../../services/vNext/ObsidianSettingsStore';
import { getProtonHttpClient } from './ObsidianHttpClient';
import { getProtonAccount } from './ProtonAccount';

export const { init: initProtonDriveClient, get: getProtonDriveClient } = (function () {
  let instance: ProtonDriveClient | null = null;

  return {
    init: function initProtonDriveClient(): ProtonDriveClient {
      return (instance ??= new ProtonDriveClient({
        httpClient: getProtonHttpClient(),
        entitiesCache: new MemoryCache<string>(),
        cryptoCache: new MemoryCache<CachedCryptoMaterial>(),
        account: getProtonAccount(),
        openPGPCryptoModule: createOpenPgpCrypto(),
        srpModule: new PlaceholderSrpModule(),
        latestEventIdProvider: {
          getLatestEventId: (): string | null => {
            return getObsidianSettingsStore().getLatestProtonEventId();
          }
        }
      }));
    },
    get: function getProtonDriveClient(): ProtonDriveClient {
      if (!instance) {
        throw new Error('ProtonDriveClient has not been initialized. Please call initProtonDriveClient first.');
      }
      return instance;
    }
  };
})();

type SrpModule = ProtonDriveClientContructorParameters['srpModule'];
type SrpVerifier = Awaited<ReturnType<SrpModule['getSrpVerifier']>>;

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
