import { Effect, Option } from 'effect';
import { normalizePath } from 'obsidian';

import type {
  GenericProtonDriveError,
  NotAFolderError,
  ProtonFolderId,
  ProtonRequestCancelledError
} from '../proton-drive-types';
import type { ProtonFolder } from '../ProtonDriveApi';
import { getProtonDriveApi } from '../ProtonDriveApi';
import type { SyncCancelledError } from './SyncErrors';
import type { ProtonRecursiveFolder } from './SyncTypes';

export function buildRemoteTree(
  remoteConfigRoot: ProtonFolder,
  signal: AbortSignal,
  isExcluded: (relativePath: string) => boolean,
  ensureNotCancelled: (signal: AbortSignal) => Effect.Effect<void, SyncCancelledError, never>
): Effect.Effect<
  ProtonRecursiveFolder,
  SyncCancelledError | GenericProtonDriveError | NotAFolderError | ProtonRequestCancelledError,
  never
> {
  return Effect.gen(function* () {
    const driveApi = getProtonDriveApi();

    const root: ProtonRecursiveFolder = {
      ...remoteConfigRoot,
      children: []
    };

    const queue: Array<{ folder: ProtonRecursiveFolder; relativePath: string }> = [{ folder: root, relativePath: '' }];

    while (queue.length > 0) {
      yield* ensureNotCancelled(signal);

      const current = queue.shift();
      if (!current) {
        continue;
      }

      for (const child of yield* driveApi.getChildren(current.folder.id, signal)) {
        const relativePath = normalizePath(current.relativePath ? `${current.relativePath}/${child.name}` : child.name);
        if (!relativePath || isExcluded(relativePath)) {
          continue;
        }

        if (child._tag === 'folder') {
          const folderNode: ProtonRecursiveFolder = {
            ...child,
            children: []
          };
          current.folder.children.push(folderNode);
          queue.push({ folder: folderNode, relativePath });
        } else if (child._tag === 'file') {
          current.folder.children.push(child);
        }
      }
    }

    return root;
  });
}

export function getRemoteRoot(
  vaultRootId: ProtonFolderId,
  signal?: AbortSignal
): Effect.Effect<Option.Option<ProtonFolder>> {
  return Effect.gen(function* () {
    const driveApi = getProtonDriveApi();
    return yield* driveApi.getFolder(vaultRootId, signal).pipe(Effect.catchAll(() => Effect.succeed(Option.none())));
  });
}
