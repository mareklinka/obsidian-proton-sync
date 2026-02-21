import { Observable, Subject } from 'rxjs';
import type { EventRef, TAbstractFile, TFile, TFolder, Vault } from 'obsidian';
import type { EntityType, FileDescriptor, FileSystemChangeType, FolderDescriptor } from './shared-types';
import { getParentPath, normalizePath, toCanonicalPathKey } from './path-utils';

export type { EntityType, FileDescriptor, FileSystemChangeType, FolderDescriptor } from './shared-types';

export type ReaderChangeType = FileSystemChangeType;

export interface ReaderChangeEvent {
  type: ReaderChangeType;
  entityType: EntityType;
  path: string;
  oldPath?: string;
  occurredAt: number;
}

export interface FileMetadataDescriptor {
  name: string;
  path: string;
  modifiedAt: number;
}

type VaultEventName = 'create' | 'modify' | 'rename' | 'delete';

interface VaultAdapter {
  getAbstractFileByPath(path: string): TAbstractFile | null;
  getAllLoadedFiles(): TAbstractFile[];
  readBinary(file: TFile): Promise<ArrayBuffer>;
  on(name: VaultEventName, callback: (...args: unknown[]) => void): EventRef;
  offref(ref: EventRef): void;
}

export interface FileSystemReaderOptions {
  ignoredPathPrefixes?: string[];
  ignorePredicate?: (path: string, entityType: EntityType) => boolean;
  now?: () => number;
  binaryAsBlob?: boolean;
  // Test seam; when omitted, real Vault is used.
  vaultAdapter?: VaultAdapter;
  isFile?: (entry: unknown) => entry is TFile;
  isFolder?: (entry: unknown) => entry is TFolder;
  folderRenameBatchWindowMs?: number;
}

export interface IFileSystemReaderService {
  start(): void;
  stop(): void;
  dispose(): void;

  readFile(path: string): Promise<FileDescriptor | null>;
  readFolder(path: string): Promise<FolderDescriptor | null>;
  exists(path: string, entityType: EntityType): Promise<boolean>;

  listFilesMetadata(): Promise<FileMetadataDescriptor[]>;
  listFolders(): Promise<FolderDescriptor[]>;

  readonly changes$: Observable<ReaderChangeEvent>;
}

export class ObsidianVaultFileSystemReader implements IFileSystemReaderService {
  public readonly changes$: Observable<ReaderChangeEvent>;

  private readonly changesSubject = new Subject<ReaderChangeEvent>();
  private readonly adapter: VaultAdapter;
  private readonly now: () => number;
  private readonly binaryAsBlob: boolean;
  private readonly ignoredPrefixes: string[];
  private readonly ignorePredicate?: (path: string, entityType: EntityType) => boolean;
  private readonly isFileGuard: (entry: unknown) => entry is TFile;
  private readonly isFolderGuard: (entry: unknown) => entry is TFolder;
  private readonly folderRenameBatchWindowMs: number;
  private readonly pendingFolderRenames = new Map<string, PendingFolderRename>();

  private refs: EventRef[] = [];
  private started = false;
  private disposed = false;

  constructor(vault: Vault, options: FileSystemReaderOptions = {}) {
    this.adapter = options.vaultAdapter ?? (vault as unknown as VaultAdapter);
    this.now = options.now ?? (() => Date.now());
    this.binaryAsBlob = options.binaryAsBlob ?? false;
    this.ignoredPrefixes = (options.ignoredPathPrefixes ?? [])
      .map(path => normalizePath(path))
      .filter(path => path.length > 0);
    this.ignorePredicate = options.ignorePredicate;
    this.isFileGuard = options.isFile ?? ((entry: unknown): entry is TFile => isLikelyFile(entry));
    this.isFolderGuard = options.isFolder ?? ((entry: unknown): entry is TFolder => isLikelyFolder(entry));
    this.folderRenameBatchWindowMs = Math.max(0, options.folderRenameBatchWindowMs ?? 250);

    this.changes$ = this.changesSubject.asObservable();
  }

  start(): void {
    if (this.disposed || this.started) {
      return;
    }

    this.refs.push(this.adapter.on('create', (...args) => this.handleCreate(args[0])));
    this.refs.push(this.adapter.on('modify', (...args) => this.handleModify(args[0])));
    this.refs.push(this.adapter.on('rename', (...args) => this.handleRename(args[0], args[1])));
    this.refs.push(this.adapter.on('delete', (...args) => this.handleDelete(args[0])));

    this.started = true;
  }

  stop(): void {
    if (!this.started) {
      return;
    }

    this.flushAllPendingFolderRenames();

    for (const ref of this.refs) {
      this.adapter.offref(ref);
    }

    this.refs = [];
    this.started = false;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.stop();
    this.disposed = true;
    this.changesSubject.complete();
  }

  async readFile(path: string): Promise<FileDescriptor | null> {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
      return null;
    }

    const entry = this.adapter.getAbstractFileByPath(normalizedPath);
    if (!entry || !this.isFileGuard(entry)) {
      return null;
    }

    const bytes = await this.adapter.readBinary(entry);
    const content: Blob | ArrayBuffer = this.binaryAsBlob
      ? new Blob([bytes], { type: 'application/octet-stream' })
      : bytes;

    return {
      name: entry.name,
      path: normalizePath(entry.path),
      modifiedAt: entry.stat?.mtime ?? this.now(),
      content
    };
  }

  async readFolder(path: string): Promise<FolderDescriptor | null> {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
      return null;
    }

    const entry = this.adapter.getAbstractFileByPath(normalizedPath);
    if (!entry || !this.isFolderGuard(entry)) {
      return null;
    }

    return {
      name: entry.name,
      path: normalizePath(entry.path)
    };
  }

  async exists(path: string, entityType: EntityType): Promise<boolean> {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
      return false;
    }

    const entry = this.adapter.getAbstractFileByPath(normalizedPath);
    if (!entry) {
      return false;
    }

    if (entityType === 'file') {
      return this.isFileGuard(entry);
    }

    return this.isFolderGuard(entry);
  }

  async listFilesMetadata(): Promise<FileMetadataDescriptor[]> {
    const entries = this.adapter.getAllLoadedFiles();
    const files: FileMetadataDescriptor[] = [];

    for (const entry of entries) {
      if (!this.isFileGuard(entry)) {
        continue;
      }

      const path = normalizePath(entry.path);
      if (!path || this.isIgnored(path, 'file')) {
        continue;
      }

      files.push({
        name: entry.name,
        path,
        modifiedAt: entry.stat?.mtime ?? this.now()
      });
    }

    return files;
  }

  async listFolders(): Promise<FolderDescriptor[]> {
    const entries = this.adapter.getAllLoadedFiles();
    const folders: FolderDescriptor[] = [];

    for (const entry of entries) {
      if (!this.isFolderGuard(entry)) {
        continue;
      }

      const path = normalizePath(entry.path);
      if (!path || this.isIgnored(path, 'folder')) {
        continue;
      }

      folders.push({
        name: entry.name,
        path
      });
    }

    return folders;
  }

  private handleCreate(rawEntry: unknown): void {
    const event = this.mapCreateEvent(rawEntry);
    if (event) {
      this.changesSubject.next(event);
    }
  }

  private handleModify(rawEntry: unknown): void {
    const event = this.mapModifyEvent(rawEntry);
    if (event) {
      this.changesSubject.next(event);
    }
  }

  private handleRename(rawEntry: unknown, oldPathRaw: unknown): void {
    const event = this.mapRenameEvent(rawEntry, oldPathRaw);
    if (event) {
      if (event.entityType === 'folder' && (event.type === 'folder-renamed' || event.type === 'folder-moved')) {
        this.queuePendingFolderRename(event);
        return;
      }

      this.changesSubject.next(event);
    }
  }

  private handleDelete(rawEntry: unknown): void {
    const event = this.mapDeleteEvent(rawEntry);
    if (event) {
      this.changesSubject.next(event);
    }
  }

  private mapCreateEvent(rawEntry: unknown): ReaderChangeEvent | null {
    if (this.isFileGuard(rawEntry)) {
      return this.createEvent('file-created', 'file', rawEntry.path);
    }

    if (this.isFolderGuard(rawEntry)) {
      return this.createEvent('folder-created', 'folder', rawEntry.path);
    }

    return null;
  }

  private mapModifyEvent(rawEntry: unknown): ReaderChangeEvent | null {
    if (this.isFileGuard(rawEntry)) {
      return this.createEvent('file-edited', 'file', rawEntry.path);
    }

    return null;
  }

  private mapRenameEvent(rawEntry: unknown, oldPathRaw: unknown): ReaderChangeEvent | null {
    if (typeof oldPathRaw !== 'string' || oldPathRaw.trim().length === 0) {
      return null;
    }

    const oldPath = normalizePath(oldPathRaw);
    if (!oldPath) {
      return null;
    }

    if (this.isFileGuard(rawEntry)) {
      const event = this.createEvent('file-moved', 'file', rawEntry.path, oldPath);
      if (!event) {
        return null;
      }

      if (this.shouldSuppressDescendantRename(event.path, event.oldPath)) {
        return null;
      }

      return event;
    }

    if (this.isFolderGuard(rawEntry)) {
      const newPath = normalizePath(rawEntry.path);
      if (!newPath || this.isIgnored(newPath, 'folder')) {
        return null;
      }

      const type = getParentPath(newPath) === getParentPath(oldPath) ? 'folder-renamed' : 'folder-moved';

      const event: ReaderChangeEvent = {
        type,
        entityType: 'folder',
        path: newPath,
        oldPath,
        occurredAt: this.now()
      };

      if (this.shouldSuppressDescendantRename(event.path, event.oldPath)) {
        return null;
      }

      return event;
    }

    return null;
  }

  private mapDeleteEvent(rawEntry: unknown): ReaderChangeEvent | null {
    if (this.isFileGuard(rawEntry)) {
      return this.createEvent('file-deleted', 'file', rawEntry.path);
    }

    if (this.isFolderGuard(rawEntry)) {
      return this.createEvent('folder-deleted', 'folder', rawEntry.path);
    }

    return null;
  }

  private createEvent(
    type: ReaderChangeType,
    entityType: EntityType,
    pathRaw: string,
    oldPathRaw?: string
  ): ReaderChangeEvent | null {
    const path = normalizePath(pathRaw);
    const oldPath = oldPathRaw ? normalizePath(oldPathRaw) : undefined;

    if (!path || this.isIgnored(path, entityType)) {
      return null;
    }

    return {
      type,
      entityType,
      path,
      oldPath,
      occurredAt: this.now()
    };
  }

  private isIgnored(path: string, entityType: EntityType): boolean {
    const normalized = normalizePath(path);
    if (!normalized) {
      return false;
    }

    const canonical = toCanonicalPathKey(normalized);

    for (const prefix of this.ignoredPrefixes) {
      const canonicalPrefix = toCanonicalPathKey(prefix);
      if (canonical === canonicalPrefix || canonical.startsWith(`${canonicalPrefix}/`)) {
        return true;
      }
    }

    return this.ignorePredicate?.(normalized, entityType) ?? false;
  }

  private queuePendingFolderRename(event: ReaderChangeEvent): void {
    if (!event.oldPath) {
      return;
    }

    const key = toCanonicalPathKey(event.oldPath);
    const existing = this.pendingFolderRenames.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.flushPendingFolderRename(key);
    }, this.folderRenameBatchWindowMs);

    this.pendingFolderRenames.set(key, {
      event,
      timer
    });
  }

  private flushPendingFolderRename(key: string): void {
    const pending = this.pendingFolderRenames.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingFolderRenames.delete(key);
    this.changesSubject.next(pending.event);
  }

  private flushAllPendingFolderRenames(): void {
    const keys = Array.from(this.pendingFolderRenames.keys());
    for (const key of keys) {
      this.flushPendingFolderRename(key);
    }
  }

  private shouldSuppressDescendantRename(newPath: string, oldPath?: string): boolean {
    if (!oldPath) {
      return false;
    }

    const canonicalOldPath = toCanonicalPathKey(oldPath);
    const canonicalNewPath = toCanonicalPathKey(newPath);

    for (const pending of this.pendingFolderRenames.values()) {
      const parentOldPath = pending.event.oldPath;
      const parentNewPath = pending.event.path;
      if (!parentOldPath) {
        continue;
      }

      const canonicalParentOld = toCanonicalPathKey(parentOldPath);
      const canonicalParentNew = toCanonicalPathKey(parentNewPath);
      const parentOldPrefix = `${canonicalParentOld}/`;

      if (!canonicalOldPath.startsWith(parentOldPrefix)) {
        continue;
      }

      const rawSuffix = oldPath.slice(parentOldPath.length);
      const suffix = rawSuffix.startsWith('/') ? rawSuffix : `/${rawSuffix}`;
      const expectedNewPath = normalizePath(`${parentNewPath}${suffix}`);
      if (!expectedNewPath) {
        continue;
      }

      const canonicalExpectedNew = toCanonicalPathKey(expectedNewPath);
      if (canonicalExpectedNew !== canonicalNewPath) {
        continue;
      }

      if (!canonicalNewPath.startsWith(`${canonicalParentNew}/`)) {
        continue;
      }

      return true;
    }

    return false;
  }
}

type PendingFolderRename = {
  event: ReaderChangeEvent;
  timer: ReturnType<typeof setTimeout>;
};

function isLikelyFile(entry: unknown): entry is TFile {
  if (!entry || typeof entry !== 'object') {
    return false;
  }

  const value = entry as {
    path?: unknown;
    name?: unknown;
    stat?: unknown;
    extension?: unknown;
    children?: unknown;
  };

  return (
    typeof value.path === 'string' &&
    typeof value.name === 'string' &&
    typeof value.extension === 'string' &&
    value.children === undefined
  );
}

function isLikelyFolder(entry: unknown): entry is TFolder {
  if (!entry || typeof entry !== 'object') {
    return false;
  }

  const value = entry as {
    path?: unknown;
    name?: unknown;
    children?: unknown;
  };

  return typeof value.path === 'string' && typeof value.name === 'string' && Array.isArray(value.children);
}
