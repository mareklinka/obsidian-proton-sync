import type { Plugin } from 'obsidian';
import { combineLatest, map, type Observable } from 'rxjs';

import { getI18n } from '../i18n';
import type { ProtonAuthStatus } from '../proton/auth/ProtonSessionService';
import { type SyncState } from '../services/SyncService';
import { getSyncProgressModal } from './modals/sync-progress-modal';
import { toLoginIcon, toLoginLabel } from './ui-helpers';

export interface SyncStatusBarController {
  dispose(): void;
}

export function createSyncStatusBar(
  plugin: Plugin,
  input: {
    loginState$: Observable<ProtonAuthStatus>;
    syncState$: Observable<SyncState>;
  }
): SyncStatusBarController {
  const itemEl = plugin.addStatusBarItem();
  itemEl.addClass('proton-sync-status');
  itemEl.onClickEvent((e: MouseEvent) => {
    if (e.button !== 0) {
      return;
    }

    getSyncProgressModal().open();
  });

  const subscription = combineLatest([input.loginState$, input.syncState$])
    .pipe(
      map(([loginState, syncState]) => ({
        loginState,
        syncState: toEffectiveSyncState(syncState)
      }))
    )
    .subscribe(({ loginState, syncState }) => {
      const { t } = getI18n();
      const loginText = toLoginLabel(loginState);
      const loginIcon = toLoginIcon(loginState);
      const syncText = toSyncLabel(syncState);
      const syncIcon = toSyncIcon(syncState);

      itemEl.setAttribute('aria-label', t.statusBar.ariaLabel(loginText, syncText));
      itemEl.innerHTML =
        `${t.statusBar.prefix}: ` +
        `<span class="proton-sync-status__label proton-sync-status__label--${loginState}">` +
        `${loginIcon}</span>` +
        '<span class="proton-sync-status__separator">•</span>' +
        `<span class="proton-sync-status__label proton-sync-status__label--${syncState}">` +
        `${syncIcon}</span>`;
    });

  return {
    dispose(): void {
      subscription.unsubscribe();
      itemEl.remove();
    }
  };
}

function toEffectiveSyncState(syncState: SyncState): SyncState['state'] {
  return syncState.state;
}

function toSyncLabel(state: SyncState['state']): string {
  const { t } = getI18n();

  switch (state) {
    case 'pulling':
      return t.statusBar.syncLabels.pulling;
    case 'pushing':
      return t.statusBar.syncLabels.pushing;
    case 'idle':
    default:
      return t.statusBar.syncLabels.idle;
  }
}

function toSyncIcon(state: SyncState['state']): string {
  switch (state) {
    case 'pulling':
      return '⬇️';
    case 'pushing':
      return '⬆️';
    case 'idle':
    default:
      return '💤';
  }
}
