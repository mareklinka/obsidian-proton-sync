import { DriveEventType } from '@protontech/drive-sdk';
import { Data } from 'effect';

import type { Option } from 'effect';

export abstract class ProtonId {
  protected constructor(public readonly uid: string) {}
}

export class ProtonFolderId extends ProtonId {
  public constructor(uid: string) {
    super(uid);
  }

  public get folderId(): string {
    return this.uid;
  }

  public equals(other: ProtonFolderId): boolean {
    return this.uid === other.uid;
  }

  public static parse(uid: string): ProtonFolderId {
    return new ProtonFolderId(uid);
  }
}

export class ProtonFileId extends ProtonId {
  public constructor(uid: string) {
    super(uid);
  }

  public get fileId(): string {
    return this.uid;
  }

  public equals(other: ProtonFileId): boolean {
    return this.uid === other.uid;
  }

  public static parse(uid: string): ProtonFileId {
    return new ProtonFileId(uid);
  }
}

export type ProtonDriveError = MyFilesRootFilesNotFound | NotAFolderError | GenericProtonDriveError;
export class MyFilesRootFilesNotFound extends Data.TaggedError('MyFilesRootFilesNotFound') {}
export class NotAFolderError extends Data.TaggedError('NotAFolder') {}
export class GenericProtonDriveError extends Data.TaggedError('GenericProtonDriveError') {}
export class InvalidNameError extends Data.TaggedError('InvalidName') {}
export class ItemAlreadyExistsError extends Data.TaggedError('ItemAlreadyExists') {}
export class TreeEventSubscriptionFailed extends Data.TaggedError('TreeEventSubscriptionFailed') {}
export class FileUploadError extends Data.TaggedError('FileUploadError') {}
export class FileRevisionUploadError extends Data.TaggedError('FileRevisionUploadError') {}

export class TreeEventScopeId {
  public constructor(public readonly treeEventScopeId: string) {}
}

export type ProtonCloudApiErrorType =
  | 'NotAFolder'
  | 'InvalidName'
  | 'AlreadyExists'
  | 'TreeSubscriptionFailed'
  | 'Unknown';

export enum CloudEventType {
  NodeCreated = DriveEventType.NodeCreated,
  NodeUpdated = DriveEventType.NodeUpdated,
  NodeDeleted = DriveEventType.NodeDeleted
}

export interface NodeCreatedEvent {
  _type: CloudEventType;
  nodeId: ProtonId;
  parentNodeId: Option.Option<ProtonId>;
  eventId: ProtonEventId;
}

export class ProtonEventId {
  public constructor(public readonly eventId: string) {}
}
