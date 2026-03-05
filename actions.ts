import { Effect, Option } from 'effect';
import { Notice } from 'obsidian';

import { getLogger } from './services/ConsoleLogger';
import { getSyncService, SyncAlreadyInProgressError } from './services/SyncService';
import { promptFromModal } from './ui/modal-prompt';
import { ProtonDriveConfirmModal } from './ui/modals/confirm-modal';
import { getSyncProgressModal } from './ui/modals/sync-progress-modal';

import type { App } from 'obsidian';

export async function pushVault(app: App): Promise<void> {
  const confirmation = await confirmPrune(app, 'push');

  if (!confirmation || !confirmation.confirmed) {
    return;
  }

  const syncService = getSyncService();
  const progressModal = getSyncProgressModal();
  progressModal.open();

  new Notice('Pushing vault to Proton Drive...');

  await Effect.runPromise(
    Effect.gen(function* () {
      const state = syncService.getState().state;
      if (state === 'pulling') {
        return yield* new SyncAlreadyInProgressError();
      }

      if (state === 'pushing') {
        getSyncProgressModal().open();
        return;
      }

      yield* syncService.push(confirmation.prune).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            progressModal.markCompleted();
            new Notice('Push completed.');
          })
        )
      );
    }).pipe(
      Effect.catchTag('SyncAlreadyInProgressError', () =>
        Effect.sync(() => {
          progressModal.close();
          new Notice('A sync is already in progress. Please wait for it to complete.');
        })
      ),
      Effect.catchTag('VaultRootIdNotAvailableError', () =>
        Effect.sync(() => {
          progressModal.close();
          new Notice('Vault root ID is not available. Please ensure your Proton account is connected correctly.');
        })
      ),
      Effect.catchTag('ProtonApiError', e =>
        Effect.sync(() => {
          getLogger('SyncActions').error(`Push failed due to Proton API error ${e.code}: ${e.message}`);
          progressModal.markFailed('Push failed. Please try again.');
        })
      ),
      Effect.catchAll(e => {
        getLogger('SyncActions').error('Push failed', e);
        return Effect.sync(() => {
          progressModal.markFailed('Push failed. Please try again.');
          new Notice('Push failed. Please try again.');
        });
      })
    )
  );
}

export async function pullVault(app: App): Promise<void> {
  const confirmation = await confirmPrune(app, 'pull');
  if (!confirmation || !confirmation.confirmed) {
    return;
  }

  const syncService = getSyncService();
  const progressModal = getSyncProgressModal();
  progressModal.open();

  new Notice('Pulling vault data from Proton Drive...');

  await Effect.runPromise(
    Effect.gen(function* () {
      const state = syncService.getState().state;
      if (state === 'pushing') {
        return yield* new SyncAlreadyInProgressError();
      }

      if (state === 'pulling') {
        getSyncProgressModal().open();
        return;
      }

      yield* syncService.pull(confirmation.prune).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            progressModal.markCompleted();
            new Notice('Pull completed.');
          })
        )
      );
    }).pipe(
      Effect.catchTag('SyncAlreadyInProgressError', () =>
        Effect.sync(() => {
          progressModal.close();
          new Notice('A sync is already in progress. Please wait for it to complete.');
        })
      ),
      Effect.catchTag('VaultRootIdNotAvailableError', () =>
        Effect.sync(() => {
          progressModal.close();
          new Notice('Vault root ID is not available. Please ensure your Proton account is connected correctly.');
        })
      ),
      Effect.catchAll(e => {
        getLogger('SyncActions').error('Pull failed', e);
        return Effect.sync(() => {
          progressModal.markFailed('Pull failed. Please try again.');
          new Notice('Pull failed. Please try again.');
        });
      })
    )
  );
}

async function confirmPrune(
  app: App,
  action: 'push' | 'pull'
): Promise<{ confirmed: boolean; prune: boolean } | false> {
  const title = action === 'push' ? 'Push vault to Proton Drive' : 'Pull vault from Proton Drive';
  const toggleLabel = action === 'push' ? 'Prune remote vault' : 'Prune local vault';
  const toggleDescription =
    action === 'push'
      ? 'This will remove all remote files not present locally.'
      : 'This will remove all local files not present in Proton Drive.';
  const confirmButtonLabel = action === 'push' ? 'Push' : 'Pull';

  const confirmation = await Effect.runPromise(
    promptFromModal(
      app,
      app => new ProtonDriveConfirmModal(app, title, confirmButtonLabel, toggleLabel, toggleDescription)
    )
  );

  if (Option.isNone(confirmation) || !confirmation.value) {
    return false;
  }

  return { confirmed: confirmation.value.confirmed, prune: confirmation.value.toggleValue };
}
