import type { ProtonDriveClient } from '@protontech/drive-sdk';

import type { ProtonAuthContext } from '../../auth/public/types';

export interface ProtonDriveFactory {
  createFromAuthContext(context: ProtonAuthContext): ProtonDriveClient;
}
