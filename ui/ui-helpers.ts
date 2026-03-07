import { getI18n } from '../i18n';

export function toLoginLabel(hasPersistedSession: boolean): string {
  const { t } = getI18n();

  if (hasPersistedSession) {
    return t.auth.labels.connected;
  } else {
    return t.auth.labels.disconnected;
  }
}

export function toLoginIcon(hasPersistedSession: boolean): string {
  if (hasPersistedSession) {
    return '🟢';
  } else {
    return '⚫';
  }
}
