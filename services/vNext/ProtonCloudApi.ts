import { NodeType, ProtonDriveClient, ValidationError } from '@protontech/drive-sdk';
import { Effect, Option } from 'effect';
import { ProtonDriveError, ProtonFolderId, TreeEventScopeId } from './proton-drive-types';

export interface ProtonFolder {
  id: ProtonFolderId;
  parentId: Option.Option<ProtonFolderId>;
  treeEventScopeId: TreeEventScopeId;
  name: string;
}

export const { init: initProtonCloudApi, get: getProtonCloudApi } = (function () {
  let instance: ProtonCloudApi | null = null;

  return {
    init: function initProtonCloudApi(client: ProtonDriveClient): ProtonCloudApi {
      return (instance ??= new ProtonCloudApi(client));
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

  public getRootFolder(): Effect.Effect<ProtonFolder, ProtonDriveError> {
    return Effect.tryPromise({
      try: async () => {
        const node = await this.client.getMyFilesRootFolder();

        if (!node.ok) {
          throw new ProtonDriveError('Unknown');
        }

        return ProtonCloudApi.createFolderFromNode(node.value);
      },
      catch: error => {
        if (error instanceof ProtonDriveError) {
          throw error;
        }

        throw new ProtonDriveError('Unknown');
      }
    });
  }

  public getFolder(folderUid: ProtonFolderId): Effect.Effect<Option.Option<ProtonFolder>, ProtonDriveError> {
    return Effect.tryPromise({
      try: async () => {
        const node = await this.client.getNode(folderUid.uid);

        if (!node.ok) {
          return Option.none();
        }

        if (node.value.type !== 'folder') {
          throw new ProtonDriveError('NotAFolder');
        }

        return Option.some(ProtonCloudApi.createFolderFromNode(node.value));
      },
      catch: error => {
        if (error instanceof ProtonDriveError) {
          throw error;
        }

        throw new ProtonDriveError('Unknown');
      }
    });
  }

  public getFolderByName(
    name: string,
    parentId: ProtonFolderId
  ): Effect.Effect<Option.Option<ProtonFolder>, ProtonDriveError> {
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
      catch: error => {
        if (error instanceof ProtonDriveError) {
          throw error;
        }

        throw new ProtonDriveError('Unknown');
      }
    });
  }

  public createFolder(name: string, parentId: ProtonFolderId): Effect.Effect<ProtonFolder, ProtonDriveError> {
    return Effect.tryPromise({
      try: async () => {
        const result = await this.client.createFolder(name, parentId.uid);

        if (!result.ok) {
          throw new ProtonDriveError('Unknown');
        }

        return ProtonCloudApi.createFolderFromNode(result.value);
      },
      catch: error => {
        if (error instanceof ProtonDriveError) {
          throw error;
        }

        if (error instanceof ValidationError) {
          throw new ProtonDriveError('InvalidName');
        }

        if (error instanceof Error) {
          throw new ProtonDriveError('AlreadyExists');
        }

        throw new ProtonDriveError('Unknown');
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
