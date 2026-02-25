import { MaybeNode, NodeType, ProtonDriveClient, ValidationError } from '@protontech/drive-sdk';
import { Effect, Option } from 'effect';
import {
  GenericProtonDriveError,
  InvalidNameError,
  ItemAlreadyExistsError,
  MyFilesRootFilesNotFound,
  NotAFolderError,
  ProtonDriveError,
  ProtonFolderId,
  TreeEventScopeId
} from './proton-drive-types';
import { getProtonDriveClient } from '../../proton/drive/ProtonDriveClient';

export interface ProtonFolder {
  id: ProtonFolderId;
  parentId: Option.Option<ProtonFolderId>;
  treeEventScopeId: TreeEventScopeId;
  name: string;
}

export const { init: initProtonCloudApi, get: getProtonCloudApi } = (function () {
  let instance: ProtonCloudApi | null = null;

  return {
    init: function initProtonCloudApi(): ProtonCloudApi {
      return (instance ??= new ProtonCloudApi(getProtonDriveClient()));
    },
    get: function getProtonCloudApi(): ProtonCloudApi {
      if (!instance) {
        throw new Error('ProtonCloudApi has not been initialized. Please call initProtonCloudApi first.');
      }
      return instance;
    }
  };
})();

class ProtonCloudApi {
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

      return ProtonCloudApi.createFolderFromNode(node.value);
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

        return Option.some(ProtonCloudApi.createFolderFromNode(node.value));
      },
      catch: error => {
        if (error instanceof NotAFolderError) {
          return error;
        }

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
            return Option.some(ProtonCloudApi.createFolderFromNode(child.value));
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
  ): Effect.Effect<ProtonFolder, GenericProtonDriveError | InvalidNameError | ItemAlreadyExistsError> {
    return Effect.tryPromise({
      try: async () => {
        const result = await this.client.createFolder(name, parentId.uid);

        if (!result.ok) {
          throw new GenericProtonDriveError();
        }

        return ProtonCloudApi.createFolderFromNode(result.value);
      },
      catch: error => {
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

  private static createFolderFromNode(node: {
    name: string;
    uid: string;
    treeEventScopeId: string;
    parentUid?: string;
  }): ProtonFolder {
    return {
      name: node.name,
      id: new ProtonFolderId(node.uid),
      treeEventScopeId: new TreeEventScopeId(node.treeEventScopeId),
      parentId: node.parentUid ? Option.some(new ProtonFolderId(node.parentUid)) : Option.none()
    };
  }
}
