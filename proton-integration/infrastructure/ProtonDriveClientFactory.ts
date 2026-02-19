import type { ProtonDriveClient } from '@protontech/drive-sdk';

import { createProtonDriveClient } from '../../proton-drive-client';
import type { ProtonSession } from '../../session-store';
import type { ProtonLogger } from '../public/types';

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
