import type { ProtonSession } from '../../session-store';
import type { ProtonIntegrationStatus } from '../public/types';

export interface ProtonIntegrationState {
  status: ProtonIntegrationStatus;
  session: ProtonSession | null;
}

export const SALTED_PASSPHRASES_SECRET_KEY = 'proton-drive-sync-salted-passphrases';

export const OPERATION_PREFIX = 'proton-integration';
