import type { ConfigSyncState } from '../services/vNext/ConfigSyncService';

export interface ConfigSyncProgressViewState {
  message: string;
  details: string;
  progressPercent: number | null;
}

export function toConfigSyncProgressViewState(state: ConfigSyncState): ConfigSyncProgressViewState {
  if (state.state === 'idle') {
    return {
      message: 'Preparing configuration push…',
      details: 'Waiting for progress updates.',
      progressPercent: 0
    };
  }

  switch (state.subState) {
    case 'localTreeBuild':
      return {
        message: 'Scanning local configuration files…',
        details: 'Building local file tree.',
        progressPercent: null
      };
    case 'remoteTreeBuild':
      return {
        message: 'Scanning remote configuration files…',
        details: 'Building remote file tree from Proton Drive.',
        progressPercent: null
      };
    case 'diffComputation':
      return {
        message: 'Computing configuration differences…',
        details: 'Preparing the operation plan.',
        progressPercent: null
      };
    case 'applyingChanges': {
      const progressPercent =
        state.totalItems <= 0 ? 0 : clampProgressPercent((state.processedItems / state.totalItems) * 100);
      const directionText =
        state.state === 'pulling' ? 'Applying changes to local configuration…' : 'Applying changes to Proton Drive…';

      return {
        message: directionText,
        details: `Processed ${state.processedItems} of ${state.totalItems} items.`,
        progressPercent
      };
    }
    default:
      return {
        message: 'Synchronizing configuration…',
        details: 'Processing changes.',
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
