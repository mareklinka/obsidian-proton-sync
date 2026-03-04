import { getI18n } from '../i18n';

import type { SyncState } from '../services/SyncService';

export interface ConfigSyncProgressViewState {
  message: string;
  details: string;
  progressPercent: number | null;
}

export function toConfigSyncProgressViewState(state: SyncState): ConfigSyncProgressViewState {
  const { t } = getI18n();

  if (state.state === 'idle') {
    return {
      message: t.syncProgressState.idle.message,
      details: t.syncProgressState.idle.details,
      progressPercent: 0
    };
  }

  switch (state.subState) {
    case 'localTreeBuild':
      return {
        message: t.syncProgressState.localTreeBuild.message,
        details: t.syncProgressState.localTreeBuild.details,
        progressPercent: null
      };
    case 'remoteTreeBuild':
      return {
        message: t.syncProgressState.remoteTreeBuild.message,
        details: t.syncProgressState.remoteTreeBuild.details,
        progressPercent: null
      };
    case 'diffComputation':
      return {
        message: t.syncProgressState.diffComputation.message,
        details: t.syncProgressState.diffComputation.details,
        progressPercent: null
      };
    case 'applyingChanges': {
      const progressPercent =
        state.totalItems <= 0 ? 0 : clampProgressPercent((state.processedItems / state.totalItems) * 100);
      const directionText =
        state.state === 'pulling'
          ? t.syncProgressState.applyingChanges.downloading
          : t.syncProgressState.applyingChanges.uploading;

      return {
        message: directionText,
        details: t.syncProgressState.applyingChanges.details(state.processedItems, state.totalItems),
        progressPercent
      };
    }
    default:
      return {
        message: t.syncProgressState.fallback.message,
        details: '',
        progressPercent: null
      };
  }
}

function clampProgressPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}
