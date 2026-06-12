import type { NodeEntity, NodeResult, ProtonDriveClient, UploadMetadata } from '@protontech/drive-sdk';
import { NodeType, ValidationError } from '@protontech/drive-sdk';
import { APICodeError } from '@protontech/drive-sdk/dist/internal/apiService';
import { Effect, Option } from 'effect';

import { getProtonDriveClient } from '../proton/drive/ProtonDriveClient';
import { NotAFolderError } from './proton-drive-types';
import {
  FileUploadError,
  GenericProtonDriveError,
  InvalidNameError,
  ItemAlreadyExistsError,
  MyFilesRootFilesNotFound,
  PermissionError,
  ProtonApiError,
  ProtonFileId,
  ProtonFolderId,
  ProtonRequestCancelledError,
  TreeEventScopeId
} from './proton-drive-types';

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
  sha1: Option.Option<string>;
}

export const { init: initProtonDriveApi, get: getProtonDriveApi } = (function (): {
  init: (this: void) => ProtonDriveApi;
  get: (this: void) => ProtonDriveApi;
} {
  let instance: ProtonDriveApi | null = null;

  return {
    init: function (this: void): ProtonDriveApi {
      return (instance ??= new ProtonDriveApi(getProtonDriveClient()));
    },
    get: function (this: void): ProtonDriveApi {
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
      const node = yield* Effect.tryPromise<NodeEntity, GenericProtonDriveError>({
        try: async () => await this.client.getMyFilesRootFolder(),
        catch: () => new GenericProtonDriveError()
      });

      if (!node.name.ok) {
        throw new MyFilesRootFilesNotFound();
      }

      return ProtonDriveApi.#createFolderFromNode({ ...node, name: node.name });
    });
  }

  public getSharedFolders(): Effect.Effect<Array<ProtonFolder>, MyFilesRootFilesNotFound | GenericProtonDriveError> {
    return Effect.tryPromise({
      try: async () => {
        const shares: Array<ProtonFolder> = [];
        for await (const shareUid of this.client.iterateSharedWithMeNodeUids()) {
          const share = await this.client.getNode(shareUid);
          if (!share.name.ok) {
            continue;
          }

          if (share.type !== NodeType.Folder) {
            continue;
          }

          shares.push(ProtonDriveApi.#createFolderFromNode({ ...share, name: share.name }));
        }

        return shares;
      },
      catch: () => new GenericProtonDriveError()
    });
  }

  public getChildren(
    folderId: ProtonFolderId,
    signal?: AbortSignal
  ): Effect.Effect<
    Array<ProtonFile | ProtonFolder>,
    NotAFolderError | GenericProtonDriveError | ProtonRequestCancelledError
  > {
    return Effect.tryPromise({
      try: async () => {
        this.#throwIfCancelled(signal);

        const children: Array<ProtonFile | ProtonFolder> = [];
        for await (const childUid of this.client.iterateFolderChildrenNodeUids(folderId.uid, undefined, signal)) {
          this.#throwIfCancelled(signal);

          const child = await this.client.getNode(childUid);

          if (!child.name.ok) {
            continue;
          }

          if (child.type === NodeType.Folder) {
            children.push(ProtonDriveApi.#createFolderFromNode({ ...child, name: child.name }));
          } else if (child.type === NodeType.File) {
            if (child.activeRevision !== undefined && !child.activeRevision.ok) {
              continue;
            }
            children.push(
              ProtonDriveApi.#createFileFromNode({ ...child, name: child.name, activeRevision: child.activeRevision })
            );
          }
        }

        return children;
      },
      catch: error => {
        if (error instanceof ProtonRequestCancelledError || this.#isAbortError(error)) {
          return this.#toCancelledError(error);
        }

        return new GenericProtonDriveError();
      }
    });
  }

  public getFolder(
    id: ProtonFolderId,
    signal?: AbortSignal
  ): Effect.Effect<
    Option.Option<ProtonFolder>,
    GenericProtonDriveError | ProtonRequestCancelledError | NotAFolderError
  > {
    return Effect.tryPromise({
      try: async () => {
        this.#throwIfCancelled(signal);

        const node = await this.client.getNode(id.uid);

        if (node.type !== NodeType.Folder) {
          throw new NotAFolderError();
        }

        if (!node.name.ok) {
          return Option.none();
        }

        return Option.some(ProtonDriveApi.#createFolderFromNode({ ...node, name: node.name }));
      },
      catch: error => {
        if (error instanceof ProtonRequestCancelledError || this.#isAbortError(error)) {
          return this.#toCancelledError(error);
        }

        if (error instanceof NotAFolderError) {
          return error;
        }

        return new GenericProtonDriveError();
      }
    });
  }

  public getFolderByName(
    name: string,
    parentId: ProtonFolderId,
    signal?: AbortSignal
  ): Effect.Effect<Option.Option<ProtonFolder>, GenericProtonDriveError | ProtonRequestCancelledError> {
    return Effect.tryPromise({
      try: async () => {
        this.#throwIfCancelled(signal);

        for await (const child of this.client.iterateFolderChildren(parentId.uid, { type: NodeType.Folder }, signal)) {
          this.#throwIfCancelled(signal);

          if (!child.name.ok) {
            continue;
          }

          if (child.name.value === name) {
            return Option.some(ProtonDriveApi.#createFolderFromNode({ ...child, name: child.name }));
          }
        }

        return Option.none();
      },
      catch: error => {
        if (error instanceof ProtonRequestCancelledError || this.#isAbortError(error)) {
          return this.#toCancelledError(error);
        }

        return new GenericProtonDriveError();
      }
    });
  }

  public createFolder(
    name: string,
    parentId: ProtonFolderId,
    signal?: AbortSignal
  ): Effect.Effect<
    ProtonFolder,
    GenericProtonDriveError | InvalidNameError | ItemAlreadyExistsError | ProtonApiError | ProtonRequestCancelledError
  > {
    return Effect.tryPromise({
      try: async () => {
        this.#throwIfCancelled(signal);

        const result = await this.client.createFolder(parentId.uid, name, new Date());

        if (!result.name.ok) {
          throw new GenericProtonDriveError();
        }

        return ProtonDriveApi.#createFolderFromNode({ ...result, name: result.name });
      },
      catch: error => {
        if (error instanceof ProtonRequestCancelledError || this.#isAbortError(error)) {
          return this.#toCancelledError(error);
        }

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

  public uploadFile(
    name: string,
    data: ArrayBuffer,
    metadata: UploadMetadata,
    parentId: ProtonFolderId,
    signal?: AbortSignal
  ): Effect.Effect<void, ProtonRequestCancelledError | PermissionError | FileUploadError, never> {
    return Effect.tryPromise({
      try: async () => {
        this.#throwIfCancelled(signal);

        const result = await this.client.getFileUploader(parentId.uid, name, metadata, signal);
        const stream = new ReadableStream<Uint8Array>({
          start: (c): void => {
            c.enqueue(new Uint8Array(data));
            c.close();
          }
        });

        const controller = await result.uploadFromStream(stream, []);
        await controller.completion();
      },
      catch: e => {
        if (e instanceof ProtonRequestCancelledError || this.#isAbortError(e)) {
          return this.#toCancelledError(e);
        }

        if (e instanceof ValidationError) {
          if (e.code === 2011) {
            return new PermissionError();
          }
        }

        return new FileUploadError();
      }
    });
  }

  public uploadRevision(
    id: ProtonFileId,
    data: ArrayBuffer,
    metadata: UploadMetadata,
    signal?: AbortSignal
  ): Effect.Effect<void, ProtonRequestCancelledError | PermissionError | FileUploadError, never> {
    return Effect.tryPromise({
      try: async () => {
        this.#throwIfCancelled(signal);

        const result = await this.client.getFileRevisionUploader(id.uid, metadata, signal);
        const stream = new ReadableStream<Uint8Array>({
          start: (c): void => {
            c.enqueue(new Uint8Array(data));
            c.close();
          }
        });

        const controller = await result.uploadFromStream(stream, []);
        await controller.completion();
      },
      catch: e => {
        if (e instanceof ProtonRequestCancelledError || this.#isAbortError(e)) {
          return this.#toCancelledError(e);
        }

        if (e instanceof ValidationError) {
          if (e.code === 2011) {
            return new PermissionError();
          }
        }

        return new FileUploadError();
      }
    });
  }

  public downloadFile(
    id: ProtonFileId,
    signal?: AbortSignal
  ): Effect.Effect<ArrayBuffer, GenericProtonDriveError | ProtonRequestCancelledError> {
    return Effect.tryPromise({
      try: async () => {
        this.#throwIfCancelled(signal);

        const downloader = await this.client.getFileDownloader(id.uid, signal);
        const chunks: Array<Uint8Array> = [];
        let total = 0;

        const writable = new WritableStream<Uint8Array>({
          write: async (chunk): Promise<void> => {
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
      catch: error => {
        if (error instanceof ProtonRequestCancelledError || this.#isAbortError(error)) {
          return this.#toCancelledError(error);
        }

        return new GenericProtonDriveError();
      }
    });
  }

  public deleteFile(
    id: ProtonFileId,
    signal?: AbortSignal
  ): Effect.Effect<void, GenericProtonDriveError | ProtonRequestCancelledError> {
    return this.trashNodes([id], signal);
  }

  public deleteFolder(
    id: ProtonFolderId,
    signal?: AbortSignal
  ): Effect.Effect<void, GenericProtonDriveError | ProtonRequestCancelledError> {
    return this.trashNodes([id], signal);
  }

  public trashNodes(
    nodeIds: ReadonlyArray<ProtonFileId | ProtonFolderId>,
    signal?: AbortSignal
  ): Effect.Effect<void, GenericProtonDriveError | ProtonRequestCancelledError> {
    return Effect.tryPromise({
      try: async () => {
        this.#throwIfCancelled(signal);

        if (nodeIds.length === 0) {
          return;
        }

        const uids = nodeIds.map(nodeId => nodeId.uid);
        const results = await this.#consumeAllResults(this.client.trashNodes(uids, signal), signal);

        const failed = results.find(result => !result.ok);
        if (failed) {
          throw new Error(`Failed to trash node ${failed.uid}: ${failed.error ?? 'unknown error'}`);
        }
      },
      catch: error => {
        if (error instanceof ProtonRequestCancelledError || this.#isAbortError(error)) {
          return this.#toCancelledError(error);
        }

        return new GenericProtonDriveError();
      }
    });
  }

  async #consumeAllResults(
    generator: AsyncGenerator<NodeResult>,
    signal?: AbortSignal
  ): Promise<Array<{ uid: string; ok: boolean; error?: string }>> {
    const results: Array<{ uid: string; ok: boolean; error?: string }> = [];

    while (true) {
      this.#throwIfCancelled(signal);

      const next = await generator.next();
      if (next.done) {
        break;
      }

      results.push({
        ok: next.value.ok,
        uid: next.value.uid,
        error: next.value.ok
          ? undefined
          : next.value.error instanceof Error
            ? next.value.error.message
            : String(next.value.error)
      });
    }

    await generator.return(undefined);
    return results;
  }

  #throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ProtonRequestCancelledError({ reason: signal.reason });
    }
  }

  #isAbortError(error: unknown): boolean {
    return error instanceof DOMException
      ? error.name === 'AbortError'
      : typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          (error as { name?: string }).name === 'AbortError';
  }

  #toCancelledError(error: unknown): ProtonRequestCancelledError {
    if (error instanceof ProtonRequestCancelledError) {
      return error;
    }

    return new ProtonRequestCancelledError({ reason: error });
  }

  static #createFolderFromNode(node: {
    name: { ok: true; value: string };
    uid: string;
    treeEventScopeId: string;
    parentUid?: string;
  }): ProtonFolder {
    return {
      _tag: 'folder',
      name: node.name.value,
      id: new ProtonFolderId(node.uid),
      treeEventScopeId: new TreeEventScopeId(node.treeEventScopeId),
      parentId: node.parentUid ? Option.some(new ProtonFolderId(node.parentUid)) : Option.none()
    };
  }

  static #createFileFromNode(node: {
    name: { ok: true; value: string };
    uid: string;
    treeEventScopeId: string;
    modificationTime: Date;
    parentUid?: string;
    activeRevision?: { ok: true; value: { claimedDigests?: { sha1?: string } } };
  }): ProtonFile {
    return {
      _tag: 'file',
      name: node.name.value,
      id: new ProtonFileId(node.uid),
      modifiedAt: node.modificationTime,
      parentId: node.parentUid ? Option.some(new ProtonFolderId(node.parentUid)) : Option.none(),
      sha1: Option.fromNullable(node.activeRevision?.value?.claimedDigests?.sha1)
    };
  }
}
