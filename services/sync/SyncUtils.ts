import { Option } from 'effect';
import { normalizePath } from 'obsidian';

import type { VaultFolder } from '../ObsidianFileApi';
import { canonicalizePath } from '../ObsidianFileApi';
import type { RemoteFileStateSnapshot } from '../RemoteFileStateSnapshot';
import type { ProtonRecursiveFolder } from './SyncTypes';

export function hasGlobMeta(pattern: string): boolean {
  return /[*?[\]]/.test(pattern);
}

export function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) {
    return '';
  }

  return normalized.slice(0, idx);
}

export function pathDepth(path: string): number {
  const normalized = normalizePath(path);
  if (!normalized) {
    return 0;
  }

  return normalized.split('/').filter(Boolean).length;
}

export function getSnapshotSha(snapshot: RemoteFileStateSnapshot | null, rawPath: string): string | null | undefined {
  if (!snapshot) {
    return undefined;
  }

  return snapshot[canonicalizePath(rawPath).path];
}

export function findConflictingRemotePruneFilePath(
  remoteFolder: ProtonRecursiveFolder,
  remoteFolderPath: string,
  snapshot: RemoteFileStateSnapshot | null
): string | null {
  const queue: Array<{ folder: ProtonRecursiveFolder; relativePath: string }> = [
    { folder: remoteFolder, relativePath: remoteFolderPath }
  ];

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) {
      continue;
    }

    for (const child of item.folder.children) {
      const childPath = normalizePath(item.relativePath ? `${item.relativePath}/${child.name}` : child.name);
      if (!childPath) {
        continue;
      }

      if (child._tag === 'folder') {
        queue.push({ folder: child, relativePath: childPath });
        continue;
      }

      const remoteSha = Option.isSome(child.sha1) ? child.sha1.value : null;
      const snapshotSha = getSnapshotSha(snapshot, childPath);
      if (remoteSha === null || snapshotSha === null || snapshotSha === undefined || remoteSha !== snapshotSha) {
        return childPath;
      }
    }
  }

  return null;
}

export function findConflictingLocalPruneFilePath(
  localFolder: VaultFolder,
  snapshot: RemoteFileStateSnapshot | null
): string | null {
  const queue: Array<VaultFolder> = [localFolder];

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) {
      continue;
    }

    for (const child of item.children) {
      if (child._type === 'folder') {
        queue.push(child);
        continue;
      }

      const snapshotSha = getSnapshotSha(snapshot, child.rawPath);
      if (snapshotSha === null || snapshotSha === undefined || child.sha1 !== snapshotSha) {
        return child.rawPath;
      }
    }
  }

  return null;
}

export function inferMediaType(path: string): string {
  const normalized = canonicalizePath(normalizePath(path));

  const index = normalized.path.lastIndexOf('/');
  if (index >= 0) {
    const extension = normalized.path.slice(index + 1);

    if (extension.endsWith('.md')) {
      return 'text/markdown';
    }

    if (extension.endsWith('.json')) {
      return 'application/json';
    }
  }

  return 'application/octet-stream';
}
