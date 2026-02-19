import type { ProtonApiClient } from '../infrastructure/ProtonApiClient';
import { createProtonIntegration } from '../../application/ProtonIntegrationService';
import { SALTED_PASSPHRASES_SECRET_KEY } from '../../domain/models';
import { sanitizeErrorMessage } from '../../domain/redaction';
import type {
  ProtonApiClientFactory,
  ProtonAuthGateway,
  ProtonCredentials,
  ProtonIntegrationDeps,
  ProtonIntegrationHandle,
  ProtonLogger,
  ProtonSecretStore,
  ProtonSessionStore
} from '../../domain/contracts';
import type {
  ProtonAuthContext,
  ProtonAuthFailureReason,
  ProtonAuthFacade,
  ProtonAuthResult,
  ProtonConnectInput,
  ProtonRefreshCallbacks
} from '../public/types';

const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

type ProtonAuthFacadeDeps = {
  appVersion: string;
  logger: ProtonLogger;
  sessionStore: ProtonSessionStore;
  secretStore: ProtonSecretStore;
  authGateway: ProtonAuthGateway;
  apiClientFactory?: ProtonApiClientFactory;
  clock?: { now(): number };
  refreshIntervalMs?: number;
};

export function createProtonAuthFacade(deps: ProtonAuthFacadeDeps): ProtonAuthFacade {
  const integrationDeps: ProtonIntegrationDeps = {
    appVersion: deps.appVersion,
    logger: deps.logger,
    sessionStore: deps.sessionStore,
    secretStore: deps.secretStore,
    authGateway: deps.authGateway,
    apiClientFactory: deps.apiClientFactory,
    clock: deps.clock
  };

  const integration: ProtonIntegrationHandle = createProtonIntegration(integrationDeps);

  let refreshIntervalId: number | null = null;

  const apiClientFactory = deps.apiClientFactory;

  const toFailure = (
    source: 'connect' | 'reconnect',
    reason: ProtonAuthFailureReason,
    message: string
  ): Extract<ProtonAuthResult, { ok: false }> => ({
    ok: false,
    source,
    reason,
    message: sanitizeErrorMessage(message)
  });

  const buildAuthContext = (): ProtonAuthContext | null => {
    const session = integration.getSession();
    if (!session) {
      return null;
    }

    const saltedPassphrases = loadSaltedPassphrases(deps.secretStore);
    if (!saltedPassphrases) {
      return null;
    }

    return {
      appVersion: deps.appVersion,
      session,
      getSession: () => integration.getSession(),
      saltedPassphrases
    };
  };

  const mapErrorReason = (message: string): ProtonAuthFailureReason => {
    const lower = message.toLowerCase();

    if (lower.includes('two-factor')) {
      return 'two-factor-required';
    }

    if (lower.includes('mailbox password')) {
      return 'mailbox-password-required';
    }

    if (lower.includes('network') || lower.includes('timeout') || lower.includes('failed to fetch')) {
      return 'network-error';
    }

    if (lower.includes('credentials') || lower.includes('login') || lower.includes('authentication')) {
      return 'invalid-credentials';
    }

    return 'unknown';
  };

  const buildSessionRefreshContext = async (): Promise<ProtonAuthContext | null> => {
    const context = buildAuthContext();
    if (context) {
      return context;
    }

    const session = integration.getSession();
    if (!session || !apiClientFactory) {
      return null;
    }

    try {
      const apiClient: ProtonApiClient = apiClientFactory({
        getSession: () => integration.getSession(),
        appVersion: deps.appVersion,
        logger: deps.logger
      });

      const response = await apiClient.getJson<{ KeySalts?: Array<{ ID?: string; KeySalt?: string }> }>(
        '/core/v4/keys/salts'
      );

      const keySalts = response.KeySalts ?? [];
      const existing = loadSaltedPassphrases(deps.secretStore) ?? {};
      if (!keySalts.length && Object.keys(existing).length > 0) {
        return {
          appVersion: deps.appVersion,
          session,
          getSession: () => integration.getSession(),
          saltedPassphrases: existing
        };
      }

      return null;
    } catch {
      return null;
    }
  };

  const refreshNow = async (
    callbacks?: ProtonRefreshCallbacks,
    force = false
  ): Promise<Extract<ProtonAuthResult, { ok: false }> | null> => {
    const refreshed = await integration.refreshIfNeeded(force);
    if (!refreshed) {
      const status = integration.getStatus();
      if (status.state === 'error') {
        const failure = toFailure('reconnect', 'session-expired', status.lastError ?? 'Session refresh failed.');
        callbacks?.onRefreshError?.(failure);
        return failure;
      }
      return null;
    }

    const context = await buildSessionRefreshContext();
    if (!context) {
      const failure = toFailure('reconnect', 'passphrase-missing', 'Session restored but key passphrases are missing.');
      callbacks?.onRefreshError?.(failure);
      return failure;
    }

    await callbacks?.onRefreshSuccess?.(context);
    return null;
  };

  return {
    async connect(input: ProtonConnectInput): Promise<ProtonAuthResult> {
      const credentials: ProtonCredentials = {
        email: input.email,
        password: input.password,
        mailboxPassword: input.mailboxPassword,
        twoFactorCode: input.twoFactorCode
      };

      try {
        await integration.signIn(credentials);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Login failed.';
        return toFailure('connect', mapErrorReason(message), message);
      }

      const context = buildAuthContext();
      if (!context) {
        return toFailure('connect', 'passphrase-missing', 'Authenticated, but key passphrases are unavailable.');
      }

      return {
        ok: true,
        source: 'connect',
        context
      };
    },

    async reconnect(): Promise<ProtonAuthResult> {
      const stored = await deps.sessionStore.load();
      if (!stored) {
        return toFailure('reconnect', 'no-session', 'No stored Proton session was found.');
      }

      const restored = await integration.restoreFromStorage({
        forceRefreshOnRestore: true
      });

      if (!restored) {
        const status = integration.getStatus();
        return toFailure('reconnect', 'session-expired', status.lastError ?? 'Stored session could not be restored.');
      }

      const context = buildAuthContext();
      if (!context) {
        return toFailure(
          'reconnect',
          'passphrase-missing',
          'Stored session restored, but key passphrases are missing.'
        );
      }

      return {
        ok: true,
        source: 'reconnect',
        context
      };
    },

    async disconnect(): Promise<void> {
      await integration.disconnect();
      this.stopAutoRefresh();
    },

    startAutoRefresh(callbacks?: ProtonRefreshCallbacks): void {
      if (refreshIntervalId !== null) {
        return;
      }

      const intervalMs = deps.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
      refreshIntervalId = window.setInterval(() => {
        void refreshNow(callbacks, false).then(result => {
          if (result) {
            this.stopAutoRefresh();
          }
        });
      }, intervalMs);
    },

    stopAutoRefresh(): void {
      if (refreshIntervalId === null) {
        return;
      }

      window.clearInterval(refreshIntervalId);
      refreshIntervalId = null;
    },

    dispose(): void {
      this.stopAutoRefresh();
    },

    getCurrentSession() {
      return integration.getSession();
    }
  };
}

function loadSaltedPassphrases(secretStore: ProtonSecretStore): Record<string, string> | null {
  try {
    const raw = secretStore.get(SALTED_PASSPHRASES_SECRET_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Record<string, string>;
    return Object.keys(parsed).length ? parsed : {};
  } catch {
    return null;
  }
}
