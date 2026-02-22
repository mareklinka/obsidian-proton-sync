import type { Plugin } from 'obsidian';
import { combineLatest, map, type Observable } from 'rxjs';

import type { SyncEngineState } from '../services/ObsidianSyncService';
import type { ProtonAuthStatus } from '../proton/auth/ProtonSessionService';
import { toLoginIcon, toLoginLabel } from './ui-helpers';
import { ReconcileState } from '../services/CloudReconciliationService';
import { ConfigSyncState } from '../services/ConfigSyncService';

type StatusBarSyncState = 'idle' | 'downloading' | 'uploading' | 'error';

export interface SyncStatusBarController {
  dispose(): void;
}

export function createSyncStatusBar(
  plugin: Plugin,
  input: {
    loginState$: Observable<ProtonAuthStatus>;
    syncState$: Observable<SyncEngineState>;
    reconcileState$: Observable<ReconcileState>;
    configSyncState$: Observable<ConfigSyncState>;
  }
): SyncStatusBarController {
  const itemEl = plugin.addStatusBarItem();
  itemEl.addClass('proton-sync-status');

  const subscription = combineLatest([
    input.loginState$,
    input.syncState$,
    input.reconcileState$,
    input.configSyncState$
  ])
    .pipe(
      map(([loginState, syncState, reconcileState, configSyncState]) => ({
        loginState,
        syncState: toEffectiveSyncState(syncState, reconcileState, configSyncState)
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

function toEffectiveSyncState(
  syncState: SyncEngineState,
  reconcileState: ReconcileState,
  configSyncState: ConfigSyncState
): StatusBarSyncState {
  if (reconcileState === 'reconciling' || configSyncState === 'pulling') {
    return 'downloading';
  }

  if (syncState === 'error') {
    return 'error';
  }

  if (syncState === 'syncing' || configSyncState === 'pushing') {
    return 'uploading';
  }

  return 'idle';
}

function toSyncLabel(state: StatusBarSyncState): string {
  switch (state) {
    case 'downloading':
      return 'Downloading';
    case 'uploading':
      return 'Uploading';
    case 'error':
      return 'Error';
    case 'idle':
    default:
      return 'Idle';
  }
}

function toSyncIcon(state: StatusBarSyncState): string {
  switch (state) {
    case 'downloading':
      return '⬇️';
    case 'uploading':
      return '⬆️';
    case 'error':
      return '⚠️';
    case 'idle':
    default:
      return '💤';
  }
}
