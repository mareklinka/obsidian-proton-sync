import type { SyncState } from '../services/SyncService';

export interface ConfigSyncProgressViewState {
  message: string;
  details: string;
  progressPercent: number | null;
}

export function toConfigSyncProgressViewState(state: SyncState): ConfigSyncProgressViewState {
  if (state.state === 'idle') {
    return {
      message: 'No sync operations are currently running.',
      details: '',
      progressPercent: 0
    };
  }

  switch (state.subState) {
    case 'localTreeBuild':
      return {
        message: 'Scanning local files…',
        details: 'Building local file tree.',
        progressPercent: null
      };
    case 'remoteTreeBuild':
      return {
        message: 'Scanning remote files…',
        details: 'Building remote file tree.',
        progressPercent: null
      };
    case 'diffComputation':
      return {
        message: 'Comparing files…',
        details: 'Determining files to synchronize.',
        progressPercent: null
      };
    case 'applyingChanges': {
      const progressPercent =
        state.totalItems <= 0 ? 0 : clampProgressPercent((state.processedItems / state.totalItems) * 100);
      const directionText = state.state === 'pulling' ? 'Downloading notes...' : 'Uploading notes...';

      return {
        message: directionText,
        details: `Processed ${state.processedItems} of ${state.totalItems} items.`,
        progressPercent
      };
    }
    default:
      return {
        message: 'Synchronizing...',
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
