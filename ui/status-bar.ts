import { combineLatest, map, type Observable } from 'rxjs';

import { toLoginIcon, toLoginLabel } from './ui-helpers';

import type { ProtonAuthStatus } from '../proton/auth/ProtonSessionService';
import type { SyncState } from '../services/SyncService';
import type { Plugin } from 'obsidian';

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

  const subscription = combineLatest([input.loginState$, input.syncState$])
    .pipe(
      map(([loginState, syncState]) => ({
        loginState,
        syncState: toEffectiveSyncState(syncState)
      }))
    )
    .subscribe(({ loginState, syncState }) => {
      const loginText = toLoginLabel(loginState);
      const loginIcon = toLoginIcon(loginState);
      const syncText = toSyncLabel(syncState);
      const syncIcon = toSyncIcon(syncState);

      itemEl.setAttribute('aria-label', `Proton Sync status: ${loginText} / ${syncText}`);
      itemEl.innerHTML =
        `Proton Sync: ` +
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
  switch (state) {
    case 'pulling':
      return 'Downloading';
    case 'pushing':
      return 'Uploading';
    case 'idle':
    default:
      return 'Idle';
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
