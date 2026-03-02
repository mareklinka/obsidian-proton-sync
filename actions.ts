import { App, Notice } from 'obsidian';
import { getSyncService } from './services/vNext/SyncService';
import { Effect, Option } from 'effect';
import { ProtonDriveSyncProgressModal } from './ui/modals/sync-progress-modal';
import { promptFromModal } from './ui/modal-prompt';
import { ProtonDriveConfirmModal } from './ui/modals/confirm-modal';
import { getLogger } from './services/vNext/ObsidianSyncLogger';

export async function pushVault(app: App, confirm: boolean): Promise<void> {
  if (confirm && !(await confirmDestructiveAction(app, 'push'))) {
    return;
  }

  const syncService = getSyncService();
  const progressModal = new ProtonDriveSyncProgressModal(app, syncService.state$);
  progressModal.open();

  new Notice('Pushing vault to Proton Drive...');

  await Effect.runPromise(
    syncService.push().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          progressModal.markCompleted();
          new Notice('Push completed.');
        })
      ),
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
        getLogger('SyncActions').error('Push failed', e);
        return Effect.sync(() => {
          progressModal.markFailed('Push failed. Please try again.');
          new Notice('Push failed. Please try again.');
        });
      })
    )
  );
}

export async function pullVault(app: App, confirm: boolean): Promise<void> {
  if (confirm && !(await confirmDestructiveAction(app, 'pull'))) {
    return;
  }

  const syncService = getSyncService();
  const progressModal = new ProtonDriveSyncProgressModal(app, syncService.state$);
  progressModal.open();

  new Notice('Pulling vault data from Proton Drive...');

  await Effect.runPromise(
    syncService.pull(false).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          progressModal.markCompleted();
          new Notice('Pull completed.');
        })
      ),
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

async function confirmDestructiveAction(app: App, action: 'push' | 'pull'): Promise<boolean> {
  const confirmButtonLabel = action === 'push' ? 'Yes, push to Proton Drive' : 'Yes, pull from Proton Drive';
  const title = action === 'push' ? 'Proton Drive Sync - Push' : 'Proton Drive Sync - Pull';
  const confirmation = await Effect.runPromise(
    promptFromModal(
      app,
      app =>
        new ProtonDriveConfirmModal(
          app,
          title,
          'This is a potentially destructive operation. Do you wish to proceed?',
          confirmButtonLabel
        )
    )
  );

  if (Option.isNone(confirmation) || !confirmation.value) {
    return false;
  }

  return true;
}
