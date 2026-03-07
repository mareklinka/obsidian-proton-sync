import { Data, Effect, Option } from 'effect';
import type { App } from 'obsidian';
import { normalizePath, Notice } from 'obsidian';

import { getI18n } from './i18n';
import {
  getProtonSessionService,
  MasterPasswordRequiredError,
  PersistedSessionNotFoundError
} from './proton/auth/ProtonSessionService';
import { initProtonHttpClient } from './proton/drive/ObsidianHttpClient';
import { initProtonAccount } from './proton/drive/ProtonAccount';
import { initProtonDriveClient } from './proton/drive/ProtonDriveClient';
import { getLogger } from './services/ConsoleLogger';
import { getEncryptedSecretStore } from './services/EncryptedSecretStore';
import { getObsidianSettingsStore } from './services/ObsidianSettingsStore';
import { initProtonCloudObserver } from './services/ProtonCloudObserver';
import type { ProtonFolder } from './services/ProtonDriveApi';
import { getProtonDriveApi, initProtonDriveApi } from './services/ProtonDriveApi';
import { beginSyncOperationCancellation, clearSyncOperationCancellation } from './services/SyncOperationCancellation';
import { getSyncService, SyncAlreadyInProgressError, SyncCancelledError } from './services/SyncService';
import { promptFromModal } from './ui/modal-prompt';
import { ProtonDriveConfirmModal } from './ui/modals/confirm-modal';
import { ProtonDriveMasterPasswordModal } from './ui/modals/master-password-modal';
import { getSyncProgressModal } from './ui/modals/sync-progress-modal';

export function pushVault(app: App): Effect.Effect<void, never, never> {
  const { t } = getI18n();
  const progressModal = getSyncProgressModal();
  return Effect.gen(function* () {
    const syncService = getSyncService();

    const state = syncService.getState().state;
    if (state === 'pulling') {
      return yield* new SyncAlreadyInProgressError();
    }

    if (state === 'pushing') {
      getSyncProgressModal().open();
      return;
    }

    const confirmation = yield* confirmOperation(app, 'push');

    if (!confirmation.confirmed) {
      return;
    }

    const operationController = beginSyncOperationCancellation();

    progressModal.open();

    const ready = yield* prepareSyncOperation(app, operationController.signal);
    if (!ready) {
      return;
    }

    new Notice(t.actions.notices.pushingStarted);

    yield* syncService.push(confirmation.prune, operationController.signal).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          progressModal.markCompleted();
          new Notice(t.actions.notices.pushCompleted);
        })
      )
    );
  }).pipe(
    Effect.tapBoth({ onSuccess: finalizeSync, onFailure: finalizeSync }),
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
    Effect.catchTag('PermissionError', () =>
      Effect.sync(() => {
        getLogger('SyncActions').error(`Push failed due to permission issues.`);
        progressModal.markFailed(t.actions.notices.permissionError);
      })
    ),
    Effect.catchTag('SyncCancelledError', () =>
      Effect.sync(() => {
        getLogger('SyncActions').info('Push cancelled by user.');
        progressModal.markCancelled();
        new Notice(t.actions.notices.syncCancelled);
      })
    ),
    Effect.catchAll(e => {
      getLogger('SyncActions').error('Push failed', e);
      return Effect.sync(() => {
        progressModal.markFailed(t.actions.notices.pushFailed);
        new Notice(t.actions.notices.pushFailed);
      });
    })
  );
}

export function pullVault(app: App): Effect.Effect<void, never, never> {
  const { t } = getI18n();
  const progressModal = getSyncProgressModal();

  return Effect.gen(function* () {
    const syncService = getSyncService();
    const state = syncService.getState().state;
    if (state === 'pushing') {
      return yield* new SyncAlreadyInProgressError();
    }

    if (state === 'pulling') {
      getSyncProgressModal().open();
      return;
    }

    const confirmation = yield* confirmOperation(app, 'pull');
    if (!confirmation.confirmed) {
      return;
    }

    const operationController = beginSyncOperationCancellation();

    progressModal.open();

    const ready = yield* prepareSyncOperation(app, operationController.signal);
    if (!ready) {
      return;
    }

    new Notice(t.actions.notices.pullStarted);

    yield* syncService.pull(confirmation.prune, operationController.signal).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          progressModal.markCompleted();
          new Notice(t.actions.notices.pullCompleted);
        })
      )
    );
  }).pipe(
    Effect.tapBoth({ onSuccess: finalizeSync, onFailure: finalizeSync }),
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
    Effect.catchTag('SyncCancelledError', () =>
      Effect.sync(() => {
        getLogger('SyncActions').info('Pull cancelled by user.');
        progressModal.markCancelled();
        new Notice(t.actions.notices.syncCancelled);
      })
    ),
    Effect.catchAll(e => {
      getLogger('SyncActions').error('Pull failed', e);
      return Effect.sync(() => {
        progressModal.markFailed(t.actions.notices.pullFailed);
        new Notice(t.actions.notices.pullFailed);
      });
    })
  );
}

function confirmOperation(
  app: App,
  action: 'push' | 'pull'
): Effect.Effect<{ confirmed: boolean; prune: boolean }, never, never> {
  return Effect.gen(function* () {
    const { t } = getI18n();
    const title = action === 'push' ? t.actions.confirmation.pushTitle : t.actions.confirmation.pullTitle;
    const toggleLabel =
      action === 'push' ? t.actions.confirmation.pruneRemoteLabel : t.actions.confirmation.pruneLocalLabel;
    const toggleDescription =
      action === 'push' ? t.actions.confirmation.pruneRemoteDescription : t.actions.confirmation.pruneLocalDescription;
    const confirmButtonLabel = action === 'push' ? t.actions.confirmation.pushLabel : t.actions.confirmation.pullLabel;

    const confirmation = yield* promptFromModal(
      app,
      _ => new ProtonDriveConfirmModal(_, title, confirmButtonLabel, toggleLabel, toggleDescription)
    );

    if (Option.isNone(confirmation)) {
      return { confirmed: false, prune: false };
    }

    return { confirmed: confirmation.value.confirmed, prune: confirmation.value.toggleValue };
  });
}

function prepareSyncOperation(app: App, signal: AbortSignal) {
  const { t } = getI18n();
  return Effect.gen(function* () {
    getSyncService().setAuthenticationState();
    yield* ensureNotCancelled(signal);

    const settingsStore = getObsidianSettingsStore();
    const secretStore = getEncryptedSecretStore();

    const unlockedSessionData = secretStore.getUnlockedSessionData();

    if (Option.isNone(unlockedSessionData)) {
      if (!secretStore.hasPersistedSessionData()) {
        return yield* new PersistedSessionNotFoundError();
      }

      const masterPassword = yield* promptFromModal(app, _ => new ProtonDriveMasterPasswordModal(_, 'unlock'));

      if (Option.isNone(masterPassword)) {
        return yield* new MasterPasswordRequiredError();
      }

      yield* secretStore.loadSessionData(masterPassword.value);
    }

    const sessionService = getProtonSessionService();

    yield* ensureNotCancelled(signal);
    const currentSessionBeforeActivation = sessionService.getCurrentSession();

    if (Option.isNone(currentSessionBeforeActivation)) {
      yield* sessionService.activatePersistedSession(
        promptFromModal(app, _ => new ProtonDriveMasterPasswordModal(_, 'unlock'))
      );
    }

    yield* ensureNotCancelled(signal);

    const currentSession = sessionService.getCurrentSession();

    if (Option.isSome(currentSession)) {
      settingsStore.set('lastRefreshAt', currentSession.value.lastRefreshAt);
      settingsStore.set('sessionExpiresAt', currentSession.value.expiresAt);
    }

    initProtonAccount();
    initProtonHttpClient();
    initProtonDriveClient();
    initProtonDriveApi();

    yield* ensureNotCancelled(signal);
    const vaultRoot = yield* ensureVaultRootFolder(settingsStore.get('remoteVaultRootPath'), signal);
    settingsStore.set('vaultRootNodeUid', Option.some(vaultRoot.id));

    const observer = initProtonCloudObserver();
    observer.unsubscribeFromTreeChanges();
    observer.subscribeToTreeChanges(vaultRoot.treeEventScopeId);

    return true;
  }).pipe(
    Effect.catchAll(e =>
      Effect.sync(() => {
        switch (e._tag) {
          case 'SyncCancelledError':
            new Notice(t.actions.notices.syncCancelled);
            break;
          case 'PersistedSessionNotFoundError':
            new Notice(t.actions.notices.signInRequired);
            break;
          case 'PersistedSecretsInvalidFormatError':
            new Notice(t.actions.notices.sessionDataInvalid);
            break;
          case 'MasterPasswordRequiredError':
            new Notice(t.actions.notices.masterPasswordRequired);
            break;
          case 'SecretDecryptionFailedError':
            new Notice(t.actions.notices.masterPasswordInvalid);
            break;
          case 'InvalidName':
            new Notice(t.main.notices.invalidFolderName);
            break;
          case 'ItemAlreadyExists':
            new Notice(t.main.notices.folderAlreadyExists);
            break;
          case 'MyFilesRootFilesNotFound':
            new Notice(t.main.notices.myFilesRootNotFound);
            break;
          case 'GenericProtonDriveError':
            new Notice(t.main.notices.setupVaultRootFailed);
            break;
          case 'ProtonApiError':
            new Notice(t.main.notices.protonApiError);
            break;
          case 'AmbiguousSharedPathError':
            new Notice(t.main.notices.ambiguousSharedPath);
            break;
          case 'SharedFolderNotFoundError':
            new Notice(t.main.notices.sharedFolderNotFound);
            break;
          case 'InvalidSharedPathError':
            new Notice(t.main.notices.invalidSharedPath);
            break;
          default:
            new Notice(t.actions.notices.sessionActivationFailed);
            break;
        }

        getSyncProgressModal().close();
        getSyncService().setIdleState();

        return false;
      })
    )
  );
}

function finalizeSync() {
  return Effect.sync(() => {
    getEncryptedSecretStore().scheduleLock();
    clearSyncOperationCancellation();
  });
}

function ensureVaultRootFolder(remoteVaultRootPath: string, signal: AbortSignal) {
  return Effect.gen(function* () {
    yield* ensureNotCancelled(signal);

    const normalizedRemoteRootPath = normalizePath(remoteVaultRootPath);
    const pathSegments = normalizedRemoteRootPath.split('/').filter(segment => segment.trim() !== '');

    const protonApi = getProtonDriveApi();

    let remoteRoot: ProtonFolder;
    if (normalizedRemoteRootPath.startsWith('$shared$/')) {
      // target root is a folder shared with the user - we should not attempt to create it, only to find it
      if (pathSegments.length < 2) {
        // at least $shared$ and one folder name are required in the path
        return yield* new InvalidSharedPathError();
      }

      const shareName = pathSegments[1];
      const shares = yield* protonApi.getSharedFolders();
      yield* ensureNotCancelled(signal);
      const matchingShares = shares.filter(share => share.name === shareName);

      if (matchingShares.length === 0) {
        return yield* new SharedFolderNotFoundError();
      }

      if (matchingShares.length > 1) {
        return yield* new AmbiguousSharedPathError();
      }

      const targetShare = matchingShares[0];

      remoteRoot = yield* ensureRemotePath(targetShare, pathSegments.slice(2), signal);
    } else {
      // target root is the user's own folder
      const myFilesRoot = yield* protonApi.getRootFolder();
      yield* ensureNotCancelled(signal);
      remoteRoot = yield* ensureRemotePath(myFilesRoot, pathSegments, signal);
    }

    getLogger('SyncActions').info('Vault node root ID is: ', remoteRoot);

    return remoteRoot;
  });
}

function ensureRemotePath(parent: ProtonFolder, pathSegments: Array<string>, signal: AbortSignal) {
  const protonApi = getProtonDriveApi();
  let currentFolder = parent;

  return Effect.gen(function* () {
    for (const segment of pathSegments) {
      yield* ensureNotCancelled(signal);

      const maybeFolder = yield* protonApi.getFolderByName(segment, currentFolder.id, signal);
      if (Option.isSome(maybeFolder)) {
        currentFolder = maybeFolder.value;
      } else {
        const newFolder = yield* protonApi.createFolder(segment, currentFolder.id, signal);
        currentFolder = newFolder;
      }
    }

    return currentFolder;
  });
}

function ensureNotCancelled(signal: AbortSignal): Effect.Effect<void, SyncCancelledError> {
  if (signal.aborted) {
    return Effect.fail(new SyncCancelledError({ reason: signal.reason }));
  }

  return Effect.void;
}

class InvalidSharedPathError extends Data.TaggedError('InvalidSharedPathError') {}
class SharedFolderNotFoundError extends Data.TaggedError('SharedFolderNotFoundError') {}
class AmbiguousSharedPathError extends Data.TaggedError('AmbiguousSharedPathError') {}
