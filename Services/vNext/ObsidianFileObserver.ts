import { TFile, TFolder, Vault } from 'obsidian';
import { Subject } from 'rxjs';
import { canonicalizePath, CanonicalPath, toVaultFile, toVaultFolder, VaultFile, VaultFolder } from './ObsidianFileApi';
import { getLogger } from './ObsidianSyncLogger';

export const { init: initObsidianFileObserver, get: getObsidianFileObserver } = (function () {
  let instance: ObsidianFileObserver | null = null;

  return {
    init: function initObsidianFileObserver(vault: Vault): ObsidianFileObserver {
      return (instance ??= new ObsidianFileObserver(vault));
    },
    get: function getObsidianFileObserver(): ObsidianFileObserver {
      if (!instance) {
        throw new Error('ObsidianFileObserver has not been initialized. Please call initObsidianFileObserver first.');
      }
      return instance;
    }
  };
})();

class ObsidianFileObserver {
  private readonly changeStream = new Subject<VaultChangeEvent>();
  public readonly changes$ = this.changeStream.asObservable();

  public constructor(private readonly vault: Vault) {}

  public start() {
    getLogger('ObsidianFileObserver').info('Starting to observe vault changes');

    this.vault.on('create', item => {
      this.changeStream.next(
        item instanceof TFile
          ? {
              _type: 'file_created',
              file: toVaultFile(item)
            }
          : {
              _type: 'folder_created',
              folder: toVaultFolder(item as TFolder)
            }
      );
    });
    this.vault.on('modify', item => {
      this.changeStream.next(
        item instanceof TFile
          ? {
              _type: 'file_modified',
              file: toVaultFile(item)
            }
          : {
              _type: 'folder_modified',
              folder: toVaultFolder(item as TFolder)
            }
      );
    });
    this.vault.on('delete', item => {
      this.changeStream.next(
        item instanceof TFile
          ? {
              _type: 'file_deleted',
              file: toVaultFile(item)
            }
          : {
              _type: 'folder_deleted',
              folder: toVaultFolder(item as TFolder)
            }
      );
    });
    this.vault.on('rename', (item, oldPath) => {
      this.changeStream.next(
        item instanceof TFile
          ? {
              _type: 'file_renamed',
              newFile: toVaultFile(item),
              oldPath: canonicalizePath(oldPath)
            }
          : {
              _type: 'folder_renamed',
              newFolder: toVaultFolder(item as TFolder),
              oldPath: canonicalizePath(oldPath)
            }
      );
    });
  }
}

type TargetType = 'file' | 'folder';
type ChangeType = 'created' | 'modified' | 'deleted' | 'renamed';
export type EventType = `${ChangeType}_${TargetType}`;

export type VaultChangeEvent =
  | FileCreatedEvent
  | FileModifiedEvent
  | FileDeletedEvent
  | FileRenamedEvent
  | FolderCreatedEvent
  | FolderModifiedEvent
  | FolderDeletedEvent
  | FolderRenamedEvent;

export interface FileCreatedEvent {
  _type: 'file_created';
  file: VaultFile;
}

export interface FileModifiedEvent {
  _type: 'file_modified';
  file: VaultFile;
}

export interface FileDeletedEvent {
  _type: 'file_deleted';
  file: VaultFile;
}

export interface FileRenamedEvent {
  _type: 'file_renamed';
  newFile: VaultFile;
  oldPath: CanonicalPath;
}

export interface FolderCreatedEvent {
  _type: 'folder_created';
  folder: VaultFolder;
}

export interface FolderModifiedEvent {
  _type: 'folder_modified';
  folder: VaultFolder;
}

export interface FolderDeletedEvent {
  _type: 'folder_deleted';
  folder: VaultFolder;
}

export interface FolderRenamedEvent {
  _type: 'folder_renamed';
  newFolder: VaultFolder;
  oldPath: CanonicalPath;
}
