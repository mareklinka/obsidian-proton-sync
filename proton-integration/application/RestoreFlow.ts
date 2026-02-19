import type { ProtonSession } from '../../session-store';
import { NoSessionError, SessionRefreshError, toSafeError } from '../domain/errors';
import { redactMeta } from '../domain/redaction';
import type { ProtonAuthGateway, ProtonLogger, SessionStore } from '../public/types';

export async function runRestoreFlow(args: {
  sessionStore: SessionStore;
  authGateway: ProtonAuthGateway;
  forceRefreshOnRestore: boolean;
  logger: ProtonLogger;
  correlationId: string;
}): Promise<ProtonSession> {
  const { sessionStore, authGateway, forceRefreshOnRestore, logger, correlationId } = args;

  const storedSession = await sessionStore.load();
  if (!storedSession) {
    throw new NoSessionError();
  }

  if (!forceRefreshOnRestore) {
    return storedSession;
  }

  try {
    const refreshed = await authGateway.refresh(storedSession);
    await sessionStore.save(refreshed);
    return refreshed;
  } catch (error) {
    const safeError = toSafeError(error);
    await sessionStore.clear();
    logger.warn(
      'Restore refresh failed; session invalidated',
      redactMeta({ correlationId, reason: safeError.message }),
      safeError
    );
    throw new SessionRefreshError(safeError.message);
  }
}
