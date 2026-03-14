import { Option } from 'effect';
import { normalizePath } from 'obsidian';

import { canonicalizePath } from './ObsidianFileApi';

export type RemoteFileStateSnapshot = Record<string, string | null>;

interface RemoteSnapshotFile {
  _tag: 'file';
  name: string;
  sha1: Option.Option<string>;
}

interface RemoteSnapshotFolder {
  _tag: 'folder';
  name: string;
  children: Array<RemoteSnapshotNode>;
}

type RemoteSnapshotNode = RemoteSnapshotFolder | RemoteSnapshotFile;

export function createRemoteFileStateSnapshot(remoteRoot: RemoteSnapshotFolder): RemoteFileStateSnapshot {
  const snapshot: RemoteFileStateSnapshot = {};
  const queue: Array<{ folder: RemoteSnapshotFolder; relativePath: string }> = [
    { folder: remoteRoot, relativePath: '' }
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    for (const child of current.folder.children) {
      const relativePath = normalizePath(current.relativePath ? `${current.relativePath}/${child.name}` : child.name);
      if (!relativePath) {
        continue;
      }

      if (child._tag === 'folder') {
        queue.push({ folder: child, relativePath });
        continue;
      }

      setRemoteFileStateSnapshotEntry(snapshot, relativePath, Option.isSome(child.sha1) ? child.sha1.value : null);
    }
  }

  return snapshot;
}

export function setRemoteFileStateSnapshotEntry(
  snapshot: RemoteFileStateSnapshot,
  rawPath: string,
  sha1: string | null
): void {
  snapshot[canonicalizePath(rawPath).path] = sha1;
}

export function deleteRemoteFileStateSnapshotEntry(snapshot: RemoteFileStateSnapshot, rawPath: string): void {
  delete snapshot[canonicalizePath(rawPath).path];
}

export function deleteRemoteFolderStateSnapshotEntries(snapshot: RemoteFileStateSnapshot, rawPath: string): void {
  const canonicalFolderPath = canonicalizePath(rawPath).path;
  const prefix = `${canonicalFolderPath}/`;

  for (const key of Object.keys(snapshot)) {
    if (key === canonicalFolderPath || key.startsWith(prefix)) {
      delete snapshot[key];
    }
  }
}
