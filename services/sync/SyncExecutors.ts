import { type UploadMetadata } from '@protontech/drive-sdk';
import { Effect } from 'effect';

import type { getLogger } from '../ConsoleLogger';
import type { getObsidianFileApi } from '../ObsidianFileApi';
import type {
  FileUploadError,
  GenericProtonDriveError,
  InvalidNameError,
  ItemAlreadyExistsError,
  PermissionError,
  ProtonApiError,
  ProtonRequestCancelledError
} from '../proton-drive-types';
import type { getProtonDriveApi } from '../ProtonDriveApi';
import {
  deleteRemoteFileStateSnapshotEntry,
  deleteRemoteFolderStateSnapshotEntries,
  type RemoteFileStateSnapshot,
  setRemoteFileStateSnapshotEntry
} from '../RemoteFileStateSnapshot';
import type { SyncCancelledError } from './SyncErrors';
import type { PullSyncOperation, PushSyncOperation, SyncProgressReporter } from './SyncTypes';
import { getParentPath, inferMediaType } from './SyncUtils';

export function applyPullOperations(
  pullOps: Array<PullSyncOperation>,
  logger: ReturnType<typeof getLogger>,
  driveApi: ReturnType<typeof getProtonDriveApi>,
  fileApi: ReturnType<typeof getObsidianFileApi>,
  signal: AbortSignal,
  ensureNotCancelled: (signal: AbortSignal) => Effect.Effect<void, SyncCancelledError, never>,
  reportProgress: SyncProgressReporter
): Effect.Effect<void, SyncCancelledError | GenericProtonDriveError | ProtonRequestCancelledError, never> {
  return Effect.gen(function* () {
    const totalOps = pullOps.length;
    let processedOps = 0;

    for (const op of pullOps) {
      yield* ensureNotCancelled(signal);
      reportProgress(processedOps, totalOps);

      switch (op.type) {
        case 'createLocalFolder':
          {
            logger.debug('Creating local folder', { path: op.details.rawPath });
            yield* fileApi.ensureFolder(op.details.rawPath);
          }
          break;
        case 'writeLocalFile':
          {
            logger.debug('Writing local file', {
              path: op.details.rawPath,
              remoteModifiedAt: op.details.remoteModifiedAt
            });
            const parentPath = getParentPath(op.details.rawPath);
            if (parentPath) {
              yield* fileApi.ensureFolder(parentPath);
            }

            const data = yield* driveApi.downloadFile(op.details.remoteId, signal);
            yield* fileApi.writeFileContent(op.details.rawPath, data, op.details.remoteModifiedAt);
          }
          break;
        case 'deleteLocalFile':
          {
            logger.debug('Deleting local file', { path: op.details.rawPath });
            yield* fileApi.deleteFile(op.details.rawPath);
          }
          break;
        case 'deleteLocalFolder':
          {
            logger.debug('Deleting local folder', { path: op.details.rawPath });
            yield* fileApi.deleteFolder(op.details.rawPath);
          }
          break;
      }

      processedOps += 1;
    }
  });
}

export function applyPushOperations(
  syncOps: Array<PushSyncOperation>,
  logger: ReturnType<typeof getLogger>,
  driveApi: ReturnType<typeof getProtonDriveApi>,
  fileApi: ReturnType<typeof getObsidianFileApi>,
  remoteFileStateSnapshot: RemoteFileStateSnapshot,
  signal: AbortSignal,
  ensureNotCancelled: (signal: AbortSignal) => Effect.Effect<void, SyncCancelledError, never>,
  reportProgress: SyncProgressReporter
): Effect.Effect<
  void,
  | SyncCancelledError
  | GenericProtonDriveError
  | InvalidNameError
  | ItemAlreadyExistsError
  | ProtonApiError
  | ProtonRequestCancelledError
  | PermissionError
  | FileUploadError,
  never
> {
  return Effect.gen(function* () {
    const totalOps = syncOps.length;
    let processedOps = 0;
    const deleteOps: Array<Extract<PushSyncOperation, { type: 'deleteFile' | 'deleteFolder' }>> = [];

    while (syncOps.length > 0) {
      yield* ensureNotCancelled(signal);

      const op = syncOps.shift();
      if (!op) {
        continue;
      }

      if ((op.type === 'deleteFile' || op.type === 'deleteFolder') && op.details.applyMode !== 'immediate') {
        deleteOps.push(op);
        continue;
      }

      reportProgress(processedOps++, totalOps);

      switch (op.type) {
        case 'deleteFile':
          {
            logger.debug('Deleting remote file', { path: op.details.rawPath });
            yield* driveApi.trashNodes([op.details.id], signal);
            deleteRemoteFileStateSnapshotEntry(remoteFileStateSnapshot, op.details.rawPath);
          }
          break;
        case 'deleteFolder':
          {
            logger.debug('Deleting remote folder', { path: op.details.rawPath });
            yield* driveApi.trashNodes([op.details.id], signal);
            deleteRemoteFolderStateSnapshotEntries(remoteFileStateSnapshot, op.details.rawPath);
          }
          break;
        case 'createFolder':
          {
            logger.debug('Creating folder', { name: op.details.name, parentId: op.details.parentId.uid });
            const newRemoteFolder = yield* driveApi.createFolder(op.details.name, op.details.parentId, signal);
            for (const item of syncOps) {
              if ('parentId' in item.details && item.details.parentId.equals(op.details.id)) {
                item.details.parentId = newRemoteFolder.id;
              }
            }
          }
          break;
        case 'uploadFile':
          {
            logger.debug('Uploading file', { path: op.details.rawPath, modifiedAt: op.details.modifiedAt });
            const data = yield* fileApi.readFileContent(op.details.rawPath);
            const metadata = buildUploadMetadata(
              op.details.rawPath,
              op.details.modifiedAt.getTime(),
              data.byteLength,
              op.details.sha1
            );

            yield* driveApi.uploadFile(op.details.name, data, metadata, op.details.parentId, signal);
            setRemoteFileStateSnapshotEntry(remoteFileStateSnapshot, op.details.rawPath, op.details.sha1);
          }
          break;
        case 'updateFile':
          {
            logger.debug('Updating file', { path: op.details.rawPath, modifiedAt: op.details.modifiedAt });
            const data = yield* fileApi.readFileContent(op.details.rawPath);
            const metadata = buildUploadMetadata(
              op.details.rawPath,
              op.details.modifiedAt.getTime(),
              data.byteLength,
              op.details.sha1
            );

            yield* driveApi.uploadRevision(op.details.id, data, metadata, signal);
            setRemoteFileStateSnapshotEntry(remoteFileStateSnapshot, op.details.rawPath, op.details.sha1);
          }
          break;
      }
    }

    if (deleteOps.length > 0) {
      yield* ensureNotCancelled(signal);
      reportProgress(processedOps, totalOps);

      yield* driveApi.trashNodes(
        deleteOps.map(op => op.details.id),
        signal
      );

      for (const op of deleteOps) {
        if (op.type === 'deleteFile') {
          deleteRemoteFileStateSnapshotEntry(remoteFileStateSnapshot, op.details.rawPath);
        } else {
          deleteRemoteFolderStateSnapshotEntries(remoteFileStateSnapshot, op.details.rawPath);
        }
      }
    }
  });
}

function buildUploadMetadata(
  relativePath: string,
  modifiedAt: number,
  expectedSize: number,
  expectedSha1: string
): UploadMetadata {
  return {
    mediaType: inferMediaType(relativePath),
    expectedSize,
    modificationTime: new Date(modifiedAt),
    expectedSha1,
    overrideExistingDraftByOtherClient: true
  };
}
