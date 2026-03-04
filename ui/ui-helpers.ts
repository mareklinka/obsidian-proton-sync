import { getI18n } from '../i18n';

import type { ProtonAuthStatus } from '../proton/auth/ProtonSessionService';

export function toLoginLabel(state: ProtonAuthStatus): string {
  const { t } = getI18n();

  switch (state) {
    case 'connected':
      return t.auth.labels.connected;
    case 'connecting':
      return t.auth.labels.connecting;
    case 'error':
      return t.auth.labels.error;
    case 'disconnected':
    default:
      return t.auth.labels.disconnected;
  }
}

export function toLoginIcon(state: ProtonAuthStatus): string {
  switch (state) {
    case 'connected':
      return '🟢';
    case 'connecting':
      return '⏳';
    case 'error':
      return '⚠️';
    case 'disconnected':
    default:
      return '⚫';
  }
}
