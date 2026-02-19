import type { ProtonApiClient } from '../auth/infrastructure/ProtonApiClient';
import type { ProtonSession } from '../../session-store';
import { NoSessionError, SessionRefreshError, toSafeError } from '../domain/errors';
import { OPERATION_PREFIX } from '../domain/models';
import { redactMeta, sanitizeErrorMessage } from '../domain/redaction';
import { defaultProtonApiClientFactory } from '../auth/infrastructure/ProtonApiClientFactory';
import type {
  CreateProtonIntegration,
  ProtonBootstrapOptions,
  ProtonIntegrationDeps,
  ProtonIntegrationHandle,
  ProtonIntegrationStatus
} from '../domain/contracts';
import { runLoginFlow } from './LoginFlow';
import { runRestoreFlow } from './RestoreFlow';
import { SessionLifecycle } from './SessionLifecycle';

export const createProtonIntegration: CreateProtonIntegration = (
  deps: ProtonIntegrationDeps
): ProtonIntegrationHandle => {
  const logger = deps.logger;
  const clock = deps.clock ?? { now: () => Date.now() };
  const lifecycle = new SessionLifecycle(clock);

  let session: ProtonSession | null = null;
  let apiClient: ProtonApiClient | null = null;
  let status: ProtonIntegrationStatus = { state: 'disconnected' };

  const apiClientFactory = deps.apiClientFactory ?? defaultProtonApiClientFactory;

  const setStatus = (next: ProtonIntegrationStatus, event: string, meta?: Record<string, unknown>): void => {
    status = next;
    logger.info(`Integration state changed: ${event}`, redactMeta({ nextState: next.state, ...meta }));
  };

  const ensureApiClient = (): ProtonApiClient => {
    if (!apiClient) {
      apiClient = apiClientFactory({
        appVersion: deps.appVersion,
        logger,
        getSession: () => session
      });
    }

    return apiClient;
  };

  const failWithStatus = (source: string, error: unknown, extraMeta?: Record<string, unknown>): void => {
    const safeError = toSafeError(error);
    const message = sanitizeErrorMessage(safeError.message);

    status = {
      state: 'error',
      accountEmail: status.accountEmail,
      expiresAt: session?.expiresAt,
      lastError: message
    };

    logger.error(`${source} failed`, redactMeta({ ...extraMeta, message, state: status.state }), safeError);
  };

  const nextOperationId = (operation: string): string => {
    const random =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Math.floor(Math.random() * 1_000_000)}`;
    return `${OPERATION_PREFIX}:${operation}:${random}`;
  };

  return {
    getStatus(): ProtonIntegrationStatus {
      return { ...status };
    },

    getApiClient(): ProtonApiClient | null {
      return apiClient;
    },

    getSession(): ProtonSession | null {
      return session;
    },

    async signIn(credentials): Promise<void> {
      const correlationId = nextOperationId('signin');
      setStatus(
        {
          state: 'pending',
          accountEmail: credentials.email.trim()
        },
        'signin-start',
        { correlationId, email: credentials.email }
      );

      try {
        const resolvedSession = await runLoginFlow({
          credentials,
          authGateway: deps.authGateway,
          sessionStore: deps.sessionStore,
          secretStore: deps.secretStore,
          createApiClient: resolved =>
            apiClientFactory({
              appVersion: deps.appVersion,
              logger,
              getSession: () => resolved
            }),
          logger,
          correlationId
        });

        session = resolvedSession;
        ensureApiClient();
        setStatus(
          {
            state: 'connected',
            accountEmail: credentials.email.trim(),
            expiresAt: resolvedSession.expiresAt
          },
          'signin-success',
          { correlationId, expiresAt: resolvedSession.expiresAt }
        );
      } catch (error) {
        failWithStatus('Sign-in', error, { correlationId });
        throw new Error(status.lastError ?? 'Login failed.');
      }
    },

    async restoreFromStorage(options?: ProtonBootstrapOptions): Promise<boolean> {
      const correlationId = nextOperationId('restore');
      logger.info(
        'Restore operation started',
        redactMeta({ correlationId, forceRefreshOnRestore: options?.forceRefreshOnRestore })
      );

      try {
        const resolvedSession = await runRestoreFlow({
          sessionStore: deps.sessionStore,
          authGateway: deps.authGateway,
          forceRefreshOnRestore: options?.forceRefreshOnRestore ?? true,
          logger,
          correlationId
        });

        session = resolvedSession;
        ensureApiClient();

        setStatus(
          {
            state: 'connected',
            accountEmail: status.accountEmail,
            expiresAt: resolvedSession.expiresAt
          },
          'restore-success',
          { correlationId, expiresAt: resolvedSession.expiresAt }
        );

        return true;
      } catch (error) {
        if (error instanceof NoSessionError) {
          setStatus({ state: 'disconnected' }, 'restore-no-session', {
            correlationId
          });
          return false;
        }

        session = null;
        apiClient = null;

        if (error instanceof SessionRefreshError) {
          setStatus({ state: 'disconnected' }, 'restore-refresh-invalid', {
            correlationId
          });
          return false;
        }

        failWithStatus('Restore', error, { correlationId });
        return false;
      }
    },

    async refreshIfNeeded(force = false): Promise<boolean> {
      const correlationId = nextOperationId('refresh');
      if (!session) {
        logger.debug('Refresh skipped - no session', redactMeta({ correlationId }));
        return false;
      }

      if (!lifecycle.shouldRefresh(session, force)) {
        logger.debug(
          'Refresh skipped - threshold not reached',
          redactMeta({
            correlationId,
            timeToExpiryMs: lifecycle.timeToExpiryMs(session)
          })
        );
        return true;
      }

      try {
        const refreshed = await deps.authGateway.refresh(session);
        await deps.sessionStore.save(refreshed);

        session = refreshed;
        ensureApiClient();

        setStatus(
          {
            state: 'connected',
            accountEmail: status.accountEmail,
            expiresAt: refreshed.expiresAt
          },
          'refresh-success',
          {
            correlationId,
            expiresAt: refreshed.expiresAt
          }
        );

        return true;
      } catch (error) {
        await deps.sessionStore.clear();
        session = null;
        apiClient = null;

        failWithStatus('Refresh', error, { correlationId });
        return false;
      }
    },

    async disconnect(): Promise<void> {
      const correlationId = nextOperationId('disconnect');
      logger.info('Disconnect operation started', redactMeta({ correlationId }));

      await deps.sessionStore.clear();
      deps.secretStore.clear('proton-drive-sync-key-passphrase');
      deps.secretStore.clear('proton-drive-sync-salted-passphrases');

      session = null;
      apiClient = null;
      setStatus({ state: 'disconnected' }, 'disconnect-success', {
        correlationId
      });
    }
  };
};
