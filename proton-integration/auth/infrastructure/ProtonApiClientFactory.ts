import { ProtonApiClient } from './ProtonApiClient';
import type { ProtonSession } from '../../../session-store';
import type { ProtonApiClientFactory } from '../../domain/contracts';

export const defaultProtonApiClientFactory: ProtonApiClientFactory = ({ getSession, appVersion, logger }) =>
  new ProtonApiClient(getSession, appVersion, 'https://mail.proton.me/api', logger);

export function createProtonApiClientFactory(baseUrl = 'https://mail.proton.me/api'): ProtonApiClientFactory {
  return ({
    getSession,
    appVersion,
    logger
  }: {
    getSession: () => ProtonSession | null;
    appVersion: string;
    logger: Parameters<ProtonApiClientFactory>[0]['logger'];
  }) => new ProtonApiClient(getSession, appVersion, baseUrl, logger);
}
