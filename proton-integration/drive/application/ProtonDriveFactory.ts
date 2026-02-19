import {
  defaultProtonDriveClientFactory,
  type ProtonDriveClientFactory
} from '../infrastructure/ProtonDriveClientFactory';
import type { ProtonLogger } from '../../domain/contracts';
import type { ProtonAuthContext } from '../../auth/public/types';
import type { ProtonDriveFactory } from '../public/types';

export function createProtonDriveFactory(args: {
  logger: ProtonLogger;
  driveClientFactory?: ProtonDriveClientFactory;
}): ProtonDriveFactory {
  const driveClientFactory = args.driveClientFactory ?? defaultProtonDriveClientFactory;

  return {
    createFromAuthContext(context: ProtonAuthContext) {
      return driveClientFactory({
        getSession: context.getSession,
        saltedPassphrases: context.saltedPassphrases,
        appVersion: context.appVersion,
        logger: args.logger
      });
    }
  };
}
