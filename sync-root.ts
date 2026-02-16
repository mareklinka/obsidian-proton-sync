import {
  NodeType,
  type ProtonDriveClient,
  type NodeEntity,
  type MaybeNode,
} from "@protontech/drive-sdk";

import type { PluginLogger } from "./logger";
import type { ProtonDriveSyncSettings } from "./settings";

const SYNC_CONTAINER_NAME = "obsidian-notes";

export interface SyncRootInfo {
  vaultName: string;
  containerNodeUid: string;
  vaultRootNodeUid: string;
}

export async function ensureSyncRoots(
  client: ProtonDriveClient,
  settings: ProtonDriveSyncSettings,
  vaultName: string,
  logger?: PluginLogger,
): Promise<SyncRootInfo> {
  logger?.debug("Ensuring sync root folders exist");

  const myFilesRoot = await requireFolderNode(
    client.getMyFilesRootFolder(),
    "My files root",
  );

  logger?.debug("Ensuring sync container folder exists");
  const containerNode = await ensureFolderByName(
    client,
    settings.containerNodeUid,
    myFilesRoot.uid,
    SYNC_CONTAINER_NAME,
    logger,
  );

  logger?.debug("Ensuring vault root folder exists");
  const vaultRootNode = await ensureFolderByName(
    client,
    settings.vaultRootNodeUid,
    containerNode.uid,
    vaultName,
    logger,
  );

  settings.containerNodeUid = containerNode.uid;
  settings.vaultRootNodeUid = vaultRootNode.uid;

  return {
    vaultName: vaultName,
    containerNodeUid: containerNode.uid,
    vaultRootNodeUid: vaultRootNode.uid,
  };
}

async function ensureFolderByName(
  client: ProtonDriveClient,
  cachedUid: string | null,
  parentUid: string,
  name: string,
  logger?: PluginLogger,
): Promise<NodeEntity> {
  const cached = await getFolderByUid(client, cachedUid, logger);
  if (cached && cached.parentUid === parentUid) {
    return cached;
  }

  if (cached) {
    logger?.warn("Cached sync root folder moved or re-parented", {
      uid: cached.uid,
      expectedParentUid: parentUid,
      actualParentUid: cached.parentUid,
    });
  }

  const existing = await findChildFolderByName(client, parentUid, name);
  if (existing) {
    return existing;
  }

  const created = await client.createFolder(parentUid, name);
  return requireFolderNode(Promise.resolve(created), `Folder ${name}`);
}

async function getFolderByUid(
  client: ProtonDriveClient,
  uid: string | null,
  logger?: PluginLogger,
): Promise<NodeEntity | null> {
  if (!uid) {
    return null;
  }

  const node = await client.getNode(uid);
  if (!node.ok) {
    logger?.warn("Sync root node lookup failed", { uid, error: node.error });
    return null;
  }

  if (node.value.type !== NodeType.Folder) {
    logger?.warn("Sync root node is not a folder", {
      uid,
      type: node.value.type,
    });
    return null;
  }

  return node.value;
}

async function findChildFolderByName(
  client: ProtonDriveClient,
  parentUid: string,
  name: string,
): Promise<NodeEntity | null> {
  for await (const child of client.iterateFolderChildren(parentUid, {
    type: NodeType.Folder,
  })) {
    if (!child.ok) {
      continue;
    }

    if (child.value.name === name) {
      return child.value;
    }
  }

  return null;
}

async function requireFolderNode(
  nodePromise: Promise<MaybeNode>,
  label: string,
): Promise<NodeEntity> {
  const node = await nodePromise;
  if (!node.ok) {
    throw new Error(`Failed to load ${label}.`);
  }

  if (node.value.type !== NodeType.Folder) {
    throw new Error(`${label} is not a folder.`);
  }

  return node.value;
}
