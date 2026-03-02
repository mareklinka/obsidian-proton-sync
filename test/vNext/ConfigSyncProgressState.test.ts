import { describe, expect, it } from 'vitest';

import { toConfigSyncProgressViewState } from '../../ui/config-sync-progress-state';

import type { SyncState } from '../../services/vNext/SyncService';

describe('toConfigSyncProgressViewState', () => {
  it('returns indeterminate progress for local tree build', () => {
    const state: SyncState = {
      state: 'pushing',
      subState: 'localTreeBuild',
      totalItems: 0,
      processedItems: 0
    };

    const viewState = toConfigSyncProgressViewState(state);

    expect(viewState.progressPercent).toBeNull();
    expect(viewState.message).toContain('Scanning local');
  });

  it('maps applying changes to percentage and count details', () => {
    const state: SyncState = {
      state: 'pushing',
      subState: 'applyingChanges',
      totalItems: 10,
      processedItems: 3
    };

    const viewState = toConfigSyncProgressViewState(state);

    expect(viewState.progressPercent).toBe(30);
    expect(viewState.details).toBe('Processed 3 of 10 items.');
  });

  it('maps applying changes with zero total to zero percent', () => {
    const state: SyncState = {
      state: 'pushing',
      subState: 'applyingChanges',
      totalItems: 0,
      processedItems: 5
    };

    const viewState = toConfigSyncProgressViewState(state);

    expect(viewState.progressPercent).toBe(0);
  });

  it('clamps applying changes percent above 100', () => {
    const state: SyncState = {
      state: 'pushing',
      subState: 'applyingChanges',
      totalItems: 3,
      processedItems: 9
    };

    const viewState = toConfigSyncProgressViewState(state);

    expect(viewState.progressPercent).toBe(100);
  });
});
