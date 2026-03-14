import type { Effect } from 'effect';

import type { ProtonFileId, ProtonFolderId, TreeEventScopeId } from '../proton-drive-types';
import type { ProtonFile, ProtonFolder } from '../ProtonDriveApi';

export type ProtonRecursiveFolder = ProtonFolder & {
  children: Array<ProtonRecursiveFolder | ProtonFile>;
};

export type SyncSubstate = 'localTreeBuild' | 'remoteTreeBuild' | 'diffComputation' | 'applyingChanges';

export type SyncState =
  | { state: 'idle' }
  | { state: 'auth' }
  | {
      state: 'pushing';
      subState: SyncSubstate;
      totalItems: number;
      processedItems: number;
    }
  | {
      state: 'pulling';
      subState: SyncSubstate;
      totalItems: number;
      processedItems: number;
    };

export interface FolderCreate {
  id: ProtonFolderId;
  name: string;
  parentId: ProtonFolderId;
}

export interface FileUpload {
  name: string;
  parentId: ProtonFolderId;
  rawPath: string;
  modifiedAt: Date;
  sha1: string;
}

export interface FileUpdate {
  id: ProtonFileId;
  rawPath: string;
  modifiedAt: Date;
  sha1: string;
}

export interface FileDelete {
  id: ProtonFileId;
  rawPath: string;
  applyMode?: 'immediate' | 'deferred';
}

export interface FolderDelete {
  id: ProtonFolderId;
  rawPath: string;
  applyMode?: 'immediate' | 'deferred';
}

export interface LocalFolderCreate {
  rawPath: string;
}

export interface LocalFileWrite {
  rawPath: string;
  remoteId: ProtonFileId;
  remoteModifiedAt: Date;
}

export interface LocalFileDelete {
  rawPath: string;
}

export interface LocalFolderDelete {
  rawPath: string;
}

export interface PullCreationPlan {
  localFolderCreatePaths: Set<string>;
  localFileWrites: Map<string, LocalFileWrite>;
  replacementFileDeletePaths: Set<string>;
  replacementFolderDeletePaths: Set<string>;
}

export type PushSyncOperation =
  | { type: 'createFolder'; details: FolderCreate }
  | { type: 'uploadFile'; details: FileUpload }
  | { type: 'updateFile'; details: FileUpdate }
  | { type: 'deleteFile'; details: FileDelete }
  | { type: 'deleteFolder'; details: FolderDelete };

export type PullSyncOperation =
  | { type: 'createLocalFolder'; details: LocalFolderCreate }
  | { type: 'writeLocalFile'; details: LocalFileWrite }
  | { type: 'deleteLocalFile'; details: LocalFileDelete }
  | { type: 'deleteLocalFolder'; details: LocalFolderDelete };

export type SyncConflictAction = 'overwrite' | 'skip';

export type SyncConflictReason =
  | 'contentChanged'
  | 'missingSnapshotBaseline'
  | 'localFolderRemoteFileTypeMismatch'
  | 'localFileRemoteFolderTypeMismatch'
  | 'remoteFolderLocalFileTypeMismatch'
  | 'remoteFileLocalFolderTypeMismatch'
  | 'pruneFileChanged'
  | 'pruneFileMissingSnapshotBaseline'
  | 'pruneFolderChanged'
  | 'pruneRemoteFolderLocalFileTypeMismatch'
  | 'pruneRemoteFileLocalFolderTypeMismatch';

export interface SyncConflict {
  direction: 'push' | 'pull';
  reason: SyncConflictReason;
  path: string;
  conflictingPath?: string;
}

export interface SyncConflictDecision {
  action: SyncConflictAction;
  applyToAll: boolean;
}

export type SyncConflictResolver = (conflict: SyncConflict) => Effect.Effect<SyncConflictDecision, never, never>;

export type ConflictActionResolver = (
  conflict: Omit<SyncConflict, 'direction'>
) => Effect.Effect<SyncConflictAction, never, never>;

export interface TemporaryRemoteFolder extends ProtonRecursiveFolder {
  treeEventScopeId: TreeEventScopeId;
}

export type SyncProgressReporter = (processedItems: number, totalItems: number) => void;
