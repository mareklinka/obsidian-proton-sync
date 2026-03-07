import { type Plugin, setIcon } from 'obsidian';
import { type Observable } from 'rxjs';

import { getI18n } from '../i18n';
import { type SyncState } from '../services/SyncService';
import { getSyncProgressModal } from './modals/sync-progress-modal';

export interface SyncStatusBarController {
  dispose(): void;
}

export function createSyncStatusBar(plugin: Plugin, syncState$: Observable<SyncState>): SyncStatusBarController {
  const itemEl = plugin.addStatusBarItem();
  itemEl.addClass('proton-sync-status');
  itemEl.onClickEvent((e: MouseEvent) => {
    if (e.button !== 0) {
      return;
    }

    getSyncProgressModal().open();
  });

  const subscription = syncState$.subscribe(syncState => {
    const { t } = getI18n();
    itemEl.empty();
    itemEl.title = `${t.statusBar.prefix} ${t.statusBar.titles[syncState.state]}`;

    setIcon(itemEl.createEl('span'), toSyncIcon(syncState.state));
  });

  return {
    dispose(): void {
      subscription.unsubscribe();
      itemEl.remove();
    }
  };
}

function toSyncIcon(state: SyncState['state']): string {
  switch (state) {
    case 'pulling':
      return 'cloud-download';
    case 'pushing':
      return 'cloud-upload';
    case 'idle':
      return 'octagon-pause';
    case 'auth':
      return 'key-round';
  }
}
