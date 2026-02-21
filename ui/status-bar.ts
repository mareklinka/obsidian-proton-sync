import type { Plugin } from 'obsidian';
import { combineLatest, map, type Observable } from 'rxjs';

import type { ReconcileState } from '../CloudReconciliationQueue';
import type { SyncEngineState } from '../isolated-sync/RxSyncService';
import type { ProtonAuthStatus } from '../proton/auth/ProtonSessionService';
import { toLoginIcon, toLoginLabel } from './ui-helpers';

type StatusBarSyncState = 'idle' | 'reconciling' | 'syncing' | 'retrying' | 'error';

export interface SyncStatusBarController {
  dispose(): void;
}

export function createSyncStatusBar(
  plugin: Plugin,
  input: {
    loginState$: Observable<ProtonAuthStatus>;
    syncState$: Observable<SyncEngineState>;
    reconcileState$: Observable<ReconcileState>;
  }
): SyncStatusBarController {
  const itemEl = plugin.addStatusBarItem();
  itemEl.addClass('proton-sync-status');

  const subscription = combineLatest([input.loginState$, input.syncState$, input.reconcileState$])
    .pipe(
      map(([loginState, syncState, reconcileState]) => ({
        loginState,
        syncState: toEffectiveSyncState(syncState, reconcileState)
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

function toEffectiveSyncState(syncState: SyncEngineState, reconcileState: ReconcileState): StatusBarSyncState {
  if (reconcileState === 'reconciling') {
    return 'reconciling';
  }

  if (reconcileState === 'error' || syncState === 'error') {
    return 'error';
  }

  if (syncState === 'retrying') {
    return 'retrying';
  }

  if (syncState === 'syncing') {
    return 'syncing';
  }

  return 'idle';
}

function toSyncLabel(state: StatusBarSyncState): string {
  switch (state) {
    case 'reconciling':
      return 'Reconciling';
    case 'syncing':
      return 'Syncing';
    case 'retrying':
      return 'Retrying';
    case 'error':
      return 'Error';
    case 'idle':
    default:
      return 'Idle';
  }
}

function toSyncIcon(state: StatusBarSyncState): string {
  switch (state) {
    case 'reconciling':
      return '⬇️';
    case 'syncing':
      return '⬆️';
    case 'retrying':
      return '🔁';
    case 'error':
      return '⚠️';
    case 'idle':
    default:
      return '💤';
  }
}
