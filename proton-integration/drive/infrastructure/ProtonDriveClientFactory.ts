import type { ProtonDriveClient } from '@protontech/drive-sdk';

import { createProtonDriveClient } from './ProtonDriveClient';
import type { ProtonSession } from '../../../session-store';
import type { ProtonLogger } from '../../domain/contracts';

export type ProtonDriveClientFactoryArgs = {
  getSession: () => ProtonSession | null;
  saltedPassphrases: Record<string, string>;
  appVersion: string;
  logger: ProtonLogger;
};

export type ProtonDriveClientFactory = (args: ProtonDriveClientFactoryArgs) => ProtonDriveClient;

export const defaultProtonDriveClientFactory: ProtonDriveClientFactory = ({
  getSession,
  saltedPassphrases,
  appVersion,
  logger
}) => createProtonDriveClient(getSession, saltedPassphrases, appVersion, logger);
