import { DriveEventType } from '@protontech/drive-sdk';
import { Option } from 'effect';

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

export class ProtonDriveError extends Error {
  constructor(type: ProtonCloudApiErrorType) {
    super(type);
    this.name = type;
  }
}

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
