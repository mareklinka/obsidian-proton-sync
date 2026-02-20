import type { CloudUpsertResult, ICloudStorageApi } from './RxSyncService';
import type { FileDescriptor, FolderDescriptor } from './shared-types';
import type { PluginLogger } from '../logger';

export class LoggingCloudStorageApi implements ICloudStorageApi {
  private nextId = 1;

  constructor(private readonly logger: PluginLogger) {}

  async createFile(input: FileDescriptor, parentPath?: string): Promise<CloudUpsertResult> {
    const result: CloudUpsertResult = {
      cloudId: this.generateId('file'),
      path: input.path,
      entityType: 'file'
    };

    this.logger.info('Mock sync createFile', {
      cloudId: result.cloudId,
      path: input.path,
      parentPath,
      modifiedAt: input.modifiedAt
    });

    return result;
  }

  async updateFile(cloudId: string, input: FileDescriptor): Promise<CloudUpsertResult> {
    this.logger.info('Mock sync updateFile', {
      cloudId,
      path: input.path,
      modifiedAt: input.modifiedAt
    });

    return {
      cloudId,
      path: input.path,
      entityType: 'file'
    };
  }

  async deleteFile(cloudId: string): Promise<void> {
    this.logger.info('Mock sync deleteFile', { cloudId });
  }

  async moveFile(cloudId: string, newPath: string, oldPath?: string): Promise<CloudUpsertResult> {
    this.logger.info('Mock sync moveFile', {
      cloudId,
      newPath,
      oldPath
    });

    return {
      cloudId,
      path: newPath,
      entityType: 'file'
    };
  }

  async createFolder(input: FolderDescriptor, parentPath?: string): Promise<CloudUpsertResult> {
    const result: CloudUpsertResult = {
      cloudId: this.generateId('folder'),
      path: input.path,
      entityType: 'folder'
    };

    this.logger.info('Mock sync createFolder', {
      cloudId: result.cloudId,
      path: input.path,
      parentPath
    });

    return result;
  }

  async renameFolder(cloudId: string, newName: string, newPath: string): Promise<CloudUpsertResult> {
    this.logger.info('Mock sync renameFolder', {
      cloudId,
      newName,
      newPath
    });

    return {
      cloudId,
      path: newPath,
      entityType: 'folder'
    };
  }

  async deleteFolder(cloudId: string): Promise<void> {
    this.logger.info('Mock sync deleteFolder', { cloudId });
  }

  async moveFolder(cloudId: string, newPath: string, oldPath?: string): Promise<CloudUpsertResult> {
    this.logger.info('Mock sync moveFolder', {
      cloudId,
      newPath,
      oldPath
    });

    return {
      cloudId,
      path: newPath,
      entityType: 'folder'
    };
  }

  private generateId(prefix: 'file' | 'folder'): string {
    const id = this.nextId;
    this.nextId += 1;
    return `mock-${prefix}-${id}`;
  }
}
