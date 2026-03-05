import { Effect, Option } from 'effect';
import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import { getI18n } from './i18n';
import { getLogger } from './services/ConsoleLogger';
import { getSyncService, SyncAlreadyInProgressError } from './services/SyncService';
import { promptFromModal } from './ui/modal-prompt';
import { ProtonDriveConfirmModal } from './ui/modals/confirm-modal';
import { getSyncProgressModal } from './ui/modals/sync-progress-modal';

export async function pushVault(app: App): Promise<void> {
  const { t } = getI18n();
  const confirmation = await confirmPrune(app, 'push');

  if (!confirmation || !confirmation.confirmed) {
    return;
  }

  const syncService = getSyncService();
  const progressModal = getSyncProgressModal();
  progressModal.open();

  new Notice(t.actions.notices.pushingStarted);

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
            new Notice(t.actions.notices.pushCompleted);
          })
        )
      );
    }).pipe(
      Effect.catchTag('SyncAlreadyInProgressError', () =>
        Effect.sync(() => {
          progressModal.close();
          new Notice(t.actions.notices.syncAlreadyInProgress);
        })
      ),
      Effect.catchTag('VaultRootIdNotAvailableError', () =>
        Effect.sync(() => {
          progressModal.close();
          new Notice(t.actions.notices.vaultRootUnavailable);
        })
      ),
      Effect.catchTag('ProtonApiError', e =>
        Effect.sync(() => {
          getLogger('SyncActions').error(`Push failed due to Proton API error ${e.code}: ${e.message}`);
          progressModal.markFailed(t.actions.notices.pushFailed);
        })
      ),
      Effect.catchAll(e => {
        getLogger('SyncActions').error('Push failed', e);
        return Effect.sync(() => {
          progressModal.markFailed(t.actions.notices.pushFailed);
          new Notice(t.actions.notices.pushFailed);
        });
      })
    )
  );
}

export async function pullVault(app: App): Promise<void> {
  const { t } = getI18n();

  const confirmation = await confirmPrune(app, 'pull');
  if (!confirmation || !confirmation.confirmed) {
    return;
  }

  const syncService = getSyncService();
  const progressModal = getSyncProgressModal();
  progressModal.open();

  new Notice(t.actions.notices.pullStarted);

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
            new Notice(t.actions.notices.pullCompleted);
          })
        )
      );
    }).pipe(
      Effect.catchTag('SyncAlreadyInProgressError', () =>
        Effect.sync(() => {
          progressModal.close();
          new Notice(t.actions.notices.syncAlreadyInProgress);
        })
      ),
      Effect.catchTag('VaultRootIdNotAvailableError', () =>
        Effect.sync(() => {
          progressModal.close();
          new Notice(t.actions.notices.vaultRootUnavailable);
        })
      ),
      Effect.catchAll(e => {
        getLogger('SyncActions').error('Pull failed', e);
        return Effect.sync(() => {
          progressModal.markFailed(t.actions.notices.pullFailed);
          new Notice(t.actions.notices.pullFailed);
        });
      })
    )
  );
}

async function confirmPrune(
  app: App,
  action: 'push' | 'pull'
): Promise<{ confirmed: boolean; prune: boolean } | false> {
  const { t } = getI18n();
  const title = action === 'push' ? t.actions.confirmation.pushTitle : t.actions.confirmation.pullTitle;
  const toggleLabel =
    action === 'push' ? t.actions.confirmation.pruneRemoteLabel : t.actions.confirmation.pruneLocalLabel;
  const toggleDescription =
    action === 'push' ? t.actions.confirmation.pruneRemoteDescription : t.actions.confirmation.pruneLocalDescription;
  const confirmButtonLabel = action === 'push' ? t.actions.confirmation.pushLabel : t.actions.confirmation.pullLabel;

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
