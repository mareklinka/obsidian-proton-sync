import { NodeType, ValidationError } from '@protontech/drive-sdk';
import { APICodeError } from '@protontech/drive-sdk/dist/internal/apiService';
import { Effect, Option } from 'effect';

import {
  FileUploadError,
  GenericProtonDriveError,
  InvalidNameError,
  ItemAlreadyExistsError,
  MyFilesRootFilesNotFound,
  NotAFolderError,
  ProtonApiError,
  ProtonFileId,
  ProtonFolderId,
  TreeEventScopeId
} from './proton-drive-types';
import { getProtonDriveClient } from '../proton/drive/ProtonDriveClient';

import type { MaybeNode, ProtonDriveClient, UploadMetadata } from '@protontech/drive-sdk';

export interface ProtonFolder {
  _tag: 'folder';
  id: ProtonFolderId;
  parentId: Option.Option<ProtonFolderId>;
  treeEventScopeId: TreeEventScopeId;
  name: string;
}

export interface ProtonFile {
  _tag: 'file';
  id: ProtonFileId;
  parentId: Option.Option<ProtonFolderId>;
  modifiedAt: Date;
  name: string;
}

export const { init: initProtonDriveApi, get: getProtonDriveApi } = (function () {
  let instance: ProtonDriveApi | null = null;

  return {
    init: function initProtonDriveApi(): ProtonDriveApi {
      return (instance ??= new ProtonDriveApi(getProtonDriveClient()));
    },
    get: function getProtonDriveApi(): ProtonDriveApi {
      if (!instance) {
        throw new Error('ProtonCloudApi has not been initialized. Please call initProtonDriveApi first.');
      }
      return instance;
    }
  };
})();

class ProtonDriveApi {
  public constructor(private readonly client: ProtonDriveClient) {}

  public getRootFolder(): Effect.Effect<ProtonFolder, MyFilesRootFilesNotFound | GenericProtonDriveError> {
    return Effect.gen(this, function* () {
      const node = yield* Effect.tryPromise<MaybeNode, GenericProtonDriveError>({
        try: async () => {
          return await this.client.getMyFilesRootFolder();
        },
        catch: () => {
          return new GenericProtonDriveError();
        }
      });

      if (!node.ok) {
        throw new MyFilesRootFilesNotFound();
      }

      return ProtonDriveApi.createFolderFromNode(node.value);
    });
  }

  public getFolder(
    folderUid: ProtonFolderId
  ): Effect.Effect<Option.Option<ProtonFolder>, NotAFolderError | GenericProtonDriveError> {
    return Effect.tryPromise({
      try: async () => {
        const node = await this.client.getNode(folderUid.uid);

        if (!node.ok) {
          return Option.none();
        }

        if (node.value.type !== 'folder') {
          throw new NotAFolderError();
        }

        return Option.some(ProtonDriveApi.createFolderFromNode(node.value));
      },
      catch: error => {
        if (error instanceof NotAFolderError) {
          return error;
        }

        return new GenericProtonDriveError();
      }
    });
  }

  public getChildren(
    folderId: ProtonFolderId
  ): Effect.Effect<(ProtonFile | ProtonFolder)[], NotAFolderError | GenericProtonDriveError> {
    return Effect.tryPromise({
      try: async () => {
        const children: (ProtonFile | ProtonFolder)[] = [];
        for await (const child of this.client.iterateFolderChildren(folderId.uid)) {
          if (!child.ok) {
            continue;
          }

          if (child.value.type === NodeType.Folder) {
            children.push(ProtonDriveApi.createFolderFromNode(child.value));
          } else if (child.value.type === NodeType.File) {
            children.push(ProtonDriveApi.createFileFromNode(child.value));
          }
        }

        return children;
      },
      catch: () => {
        return new GenericProtonDriveError();
      }
    });
  }

  public getFolderByName(
    name: string,
    parentId: ProtonFolderId
  ): Effect.Effect<Option.Option<ProtonFolder>, GenericProtonDriveError> {
    return Effect.tryPromise({
      try: async () => {
        for await (const child of this.client.iterateFolderChildren(parentId.uid, {
          type: NodeType.Folder
        })) {
          if (!child.ok) {
            continue;
          }

          if (child.value.name === name) {
            return Option.some(ProtonDriveApi.createFolderFromNode(child.value));
          }
        }

        return Option.none();
      },
      catch: () => {
        return new GenericProtonDriveError();
      }
    });
  }

  public createFolder(
    name: string,
    parentId: ProtonFolderId
  ): Effect.Effect<ProtonFolder, GenericProtonDriveError | InvalidNameError | ItemAlreadyExistsError | ProtonApiError> {
    return Effect.tryPromise({
      try: async () => {
        const result = await this.client.createFolder(parentId.uid, name, new Date());

        if (!result.ok) {
          throw new GenericProtonDriveError();
        }

        return ProtonDriveApi.createFolderFromNode(result.value);
      },
      catch: error => {
        if (error instanceof APICodeError) {
          return new ProtonApiError({ code: error.code, message: error.message });
        }

        if (error instanceof GenericProtonDriveError) {
          return error;
        }

        if (error instanceof ValidationError) {
          return new InvalidNameError();
        }

        if (error instanceof Error) {
          return new ItemAlreadyExistsError();
        }

        return new GenericProtonDriveError();
      }
    });
  }

  public uploadFile(name: string, data: ArrayBuffer, metadata: UploadMetadata, parentId: ProtonFolderId) {
    return Effect.tryPromise({
      try: async () => {
        const result = await this.client.getFileUploader(parentId.uid, name, metadata);
        const stream = new ReadableStream<Uint8Array>({
          start: controller => {
            controller.enqueue(new Uint8Array(data));
            controller.close();
          }
        });

        const controller = await result.uploadFromStream(stream, []);
        await controller.completion();
      },
      catch: () => {
        return new FileUploadError();
      }
    });
  }

  public uploadRevision(id: ProtonFileId, data: ArrayBuffer, metadata: UploadMetadata) {
    return Effect.tryPromise({
      try: async () => {
        const result = await this.client.getFileRevisionUploader(id.uid, metadata);
        const stream = new ReadableStream<Uint8Array>({
          start: controller => {
            controller.enqueue(new Uint8Array(data));
            controller.close();
          }
        });

        const controller = await result.uploadFromStream(stream, []);
        await controller.completion();
      },
      catch: () => {
        return new FileUploadError();
      }
    });
  }

  public downloadFile(id: ProtonFileId): Effect.Effect<ArrayBuffer, GenericProtonDriveError> {
    return Effect.tryPromise({
      try: async () => {
        const downloader = await this.client.getFileDownloader(id.uid);
        const chunks: Uint8Array[] = [];
        let total = 0;

        const writable = new WritableStream<Uint8Array>({
          write: async chunk => {
            chunks.push(chunk);
            total += chunk.byteLength;
          }
        });

        const controller = downloader.downloadToStream(writable);
        await controller.completion();

        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }

        return merged.buffer;
      },
      catch: () => {
        return new GenericProtonDriveError();
      }
    });
  }

  public deleteFile(id: ProtonFileId): Effect.Effect<void, GenericProtonDriveError> {
    return this.trashNodes([id]);
  }

  public deleteFolder(id: ProtonFolderId): Effect.Effect<void, GenericProtonDriveError> {
    return this.trashNodes([id]);
  }

  public trashNodes(
    nodeIds: ReadonlyArray<ProtonFileId | ProtonFolderId>
  ): Effect.Effect<void, GenericProtonDriveError> {
    return Effect.tryPromise({
      try: async () => {
        if (nodeIds.length === 0) {
          return;
        }

        const uids = nodeIds.map(nodeId => nodeId.uid);
        const results = await this.consumeAllResults(this.client.trashNodes(uids));

        const failed = results.find(result => !result.ok);
        if (failed) {
          throw new Error(`Failed to trash node ${failed.uid}: ${failed.error ?? 'unknown error'}`);
        }
      },
      catch: () => {
        return new GenericProtonDriveError();
      }
    });
  }

  private async consumeAllResults(
    generator: AsyncGenerator<{ uid: string; ok: boolean; error?: string }>
  ): Promise<Array<{ uid: string; ok: boolean; error?: string }>> {
    const results: Array<{ uid: string; ok: boolean; error?: string }> = [];

    while (true) {
      const next = await generator.next();
      if (next.done) {
        break;
      }

      if (next.value) {
        results.push(next.value);
      }
    }

    await generator.return(undefined);
    return results;
  }

  private static createFolderFromNode(node: {
    name: string;
    uid: string;
    treeEventScopeId: string;
    parentUid?: string;
  }): ProtonFolder {
    return {
      _tag: 'folder',
      name: node.name,
      id: new ProtonFolderId(node.uid),
      treeEventScopeId: new TreeEventScopeId(node.treeEventScopeId),
      parentId: node.parentUid ? Option.some(new ProtonFolderId(node.parentUid)) : Option.none()
    };
  }

  private static createFileFromNode(node: {
    name: string;
    uid: string;
    treeEventScopeId: string;
    modificationTime: Date;
    parentUid?: string;
  }): ProtonFile {
    return {
      _tag: 'file',
      name: node.name,
      id: new ProtonFileId(node.uid),
      modifiedAt: node.modificationTime,
      parentId: node.parentUid ? Option.some(new ProtonFolderId(node.parentUid)) : Option.none()
    };
  }
}
