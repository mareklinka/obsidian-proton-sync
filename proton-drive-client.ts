import {
  CachedCryptoMaterial,
  MemoryCache,
  ProtonDriveClient,
  type ProtonDriveClientContructorParameters,
  type ProtonDriveCryptoCache,
  type ProtonDriveEntitiesCache,
} from "@protontech/drive-sdk";

import type { ProtonSession } from "./session-store";
import { ProtonApiClient } from "./proton-api";
import { ProtonAccount } from "./proton-account";
import { createOpenPgpCrypto } from "./proton-openpgp";
import { buildSrpProofsFromParams } from "./proton-srp";
import type { PluginLogger } from "./logger";
import { ObsidianHttpClient } from "./ObsidianHttpClient";

export type SessionProvider = () => ProtonSession | null;
type SrpModule = ProtonDriveClientContructorParameters["srpModule"];
type SrpVerifier = Awaited<ReturnType<SrpModule["getSrpVerifier"]>>;

export function createProtonDriveClient(
  getSession: SessionProvider,
  saltedPasshphrases: Record<string, string>,
  appVersion: string,
  logger: PluginLogger,
): ProtonDriveClient {
  const httpClient = new ObsidianHttpClient(getSession, appVersion, logger);
  const apiClient = new ProtonApiClient(
    getSession,
    appVersion,
    "https://mail.proton.me/api",
    logger,
  );
  const entitiesCache: ProtonDriveEntitiesCache = new MemoryCache<string>();
  const cryptoCache: ProtonDriveCryptoCache =
    new MemoryCache<CachedCryptoMaterial>();
  const account = new ProtonAccount(apiClient, saltedPasshphrases, logger);

  const openPGPCryptoModule = createOpenPgpCrypto();
  const srpModule = new PlaceholderSrpModule();

  return new ProtonDriveClient({
    httpClient,
    entitiesCache,
    cryptoCache,
    account,
    openPGPCryptoModule,
    srpModule,
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
    password: string,
  ): Promise<{
    expectedServerProof: string;
    clientProof: string;
    clientEphemeral: string;
  }> {
    const proofs = await buildSrpProofsFromParams(
      version,
      modulus,
      serverEphemeral,
      salt,
      password,
    );
    return {
      expectedServerProof: proofs.expectedServerProof,
      clientProof: proofs.clientProof,
      clientEphemeral: proofs.clientEphemeral,
    };
  }

  async getSrpVerifier(_password: string): Promise<SrpVerifier> {
    throw new Error("SRP verifier generation not implemented.");
  }

  async computeKeyPassword(_password: string, _salt: string): Promise<string> {
    throw new Error("Key password computation not implemented.");
  }
}
