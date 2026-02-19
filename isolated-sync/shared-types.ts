export type EntityType = 'file' | 'folder';

export type FileSystemChangeType =
  | 'file-created'
  | 'file-edited'
  | 'file-deleted'
  | 'file-moved'
  | 'folder-created'
  | 'folder-renamed'
  | 'folder-deleted'
  | 'folder-moved';

export interface FileDescriptor {
  name: string;
  path: string;
  modifiedAt: number;
  content: Blob | ArrayBuffer;
}

export interface FolderDescriptor {
  name: string;
  path: string;
}
