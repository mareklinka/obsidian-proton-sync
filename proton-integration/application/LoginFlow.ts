import { computeKeyPasswordFromSalt } from '../auth/infrastructure/ProtonSrp';
import type { ProtonApiClient } from '../auth/infrastructure/ProtonApiClient';
import type { ProtonSession } from '../../session-store';
import { AuthFailedError, SecretStorageError, TwoFactorRequiredError, toSafeError } from '../domain/errors';
import { SALTED_PASSPHRASES_SECRET_KEY } from '../domain/models';
import { redactMeta } from '../domain/redaction';
import type {
  ProtonAuthGateway,
  ProtonCredentials,
  ProtonLogger,
  ProtonSecretStore,
  ProtonSessionStore
} from '../domain/contracts';

type ProtonKeySaltEntry = {
  ID?: string;
  KeySalt?: string;
};

type ProtonKeySaltsResponse = {
  KeySalts?: ProtonKeySaltEntry[];
};

export async function runLoginFlow(args: {
  credentials: ProtonCredentials;
  authGateway: ProtonAuthGateway;
  sessionStore: ProtonSessionStore;
  secretStore: ProtonSecretStore;
  createApiClient: (session: ProtonSession) => ProtonApiClient;
  logger: ProtonLogger;
  correlationId: string;
}): Promise<ProtonSession> {
  const { credentials, authGateway, sessionStore, secretStore, createApiClient, logger, correlationId } = args;

  try {
    const result = await authGateway.signIn(credentials);

    if (result.passwordMode === 2 && !credentials.mailboxPassword) {
      throw new TwoFactorRequiredError('Mailbox password required for this Proton account.');
    }

    await sessionStore.save(result.session);

    const apiClient = createApiClient(result.session);
    const basePassword = credentials.mailboxPassword?.trim() || credentials.password;
    const salts = await getKeySalts(apiClient, logger, correlationId);
    const saltedPassphrases = deriveKeyPassphrasesFromSalts(basePassword, salts);

    try {
      secretStore.set(SALTED_PASSPHRASES_SECRET_KEY, JSON.stringify(saltedPassphrases));
    } catch (error) {
      throw new SecretStorageError(toSafeError(error).message);
    }

    return result.session;
  } catch (error) {
    const safeError = toSafeError(error);
    logger.warn(
      'Login flow failed',
      redactMeta({
        correlationId,
        email: credentials.email,
        reason: safeError.message
      }),
      safeError
    );

    if (safeError instanceof TwoFactorRequiredError) {
      throw safeError;
    }

    throw new AuthFailedError(safeError.message);
  }
}

async function getKeySalts(
  apiClient: ProtonApiClient,
  logger: ProtonLogger,
  correlationId: string
): Promise<Map<string, string>> {
  try {
    const response = await apiClient.getJson<ProtonKeySaltsResponse>('/core/v4/keys/salts');

    const entries = response.KeySalts ?? [];
    const map = new Map<string, string>();

    for (const entry of entries) {
      if (!entry.ID || !entry.KeySalt) {
        continue;
      }

      map.set(entry.ID, entry.KeySalt);
    }

    return map;
  } catch (error) {
    const safeError = toSafeError(error);
    if (safeError.message.toLowerCase().includes('scope')) {
      logger.warn('Key salts unavailable due to scope', redactMeta({ correlationId, endpoint: '/core/v4/keys/salts' }));
      return new Map<string, string>();
    }

    throw safeError;
  }
}

function deriveKeyPassphrasesFromSalts(passphrase: string, keySalts: Map<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [keyId, keySalt] of keySalts.entries()) {
    result[keyId] = computeKeyPasswordFromSalt(passphrase, keySalt);
  }

  return result;
}
