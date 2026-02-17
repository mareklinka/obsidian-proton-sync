import { TAbstractFile, TFile, TFolder, Vault } from "obsidian";
import {
  NodeType,
  UploadMetadata,
  type ProtonDriveClient,
} from "@protontech/drive-sdk";
import { sha1 } from "@noble/hashes/sha1";
import { bytesToHex } from "@noble/hashes/utils";

import type { PluginLogger } from "./logger";
import type { ProtonDriveSyncSettings, SyncMapEntry } from "./settings";

export type SyncEventType =
  | "file-create"
  | "file-modify"
  | "folder-create"
  | "rename";

export interface SyncEvent {
  type: SyncEventType;
  path: string;
  oldPath?: string;
  isFolder?: boolean;
}

export class SyncQueue {
  private readonly pending = new Map<string, SyncEvent>();
  private flushTimer: number | null = null;
  private readonly vault: Vault;

  constructor(
    vault: Vault,
    private readonly client: ProtonDriveClient,
    private readonly settings: ProtonDriveSyncSettings,
    private readonly logger: PluginLogger,
    private readonly persistSettings: () => Promise<void>,
    private readonly flushDelayMs: number = 1500,
  ) {
    this.vault = vault;
  }

  enqueue(event: SyncEvent): void {
    this.logger.debug("Enqueuing sync event", { event });

    const key =
      event.type === "rename" && event.oldPath
        ? `${event.type}:${event.oldPath}->${event.path}`
        : `${event.type}:${event.path}`;

    this.pending.set(key, event);
    this.scheduleFlush();
  }

  dispose(): void {
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pending.clear();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
    }

    this.flushTimer = window.setTimeout(
      () => void this.flush(),
      this.flushDelayMs,
    );
  }

  private async flush(): Promise<void> {
    this.logger;
    this.flushTimer = null;
    const events = Array.from(this.pending.values());
    this.pending.clear();

    if (!this.settings.vaultRootNodeUid) {
      this.logger.warn("Sync queue flush skipped: vault root not ready");
      return;
    }

    for (const event of events) {
      try {
        await this.processEvent(event);
      } catch (error) {
        this.logger.error("Sync event failed", { event }, error);
      }
    }

    await this.persistSettings();
  }

  private async processEvent(event: SyncEvent): Promise<void> {
    if (!this.settings.vaultRootNodeUid) {
      return;
    }

    switch (event.type) {
      case "folder-create":
        await this.ensureFolderPath(event.path);
        return;
      case "file-create":
      case "file-modify":
        await this.syncFile(event.path);
        return;
      case "rename":
        await this.renamePath(
          event.oldPath ?? "",
          event.path,
          event.isFolder ?? false,
        );
        return;
      default:
        return;
    }
  }

  private async syncFile(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return;
    }

    const parentPath = getParentPath(file.path);
    const parentUid = await this.ensureFolderPath(parentPath);
    const name = file.name;

    const entry = this.settings.pathMap[path];
    const payload = await buildFilePayload(file, this.vault);
    const metadata = payload.metadata;
    const fileObject = payload.fileObject;

    this.logger.debug("Syncing file", { name, metadata });

    if (entry?.nodeUid) {
      this.logger.debug("File previously synced, uploading new revision", {
        path,
        nodeUid: entry.nodeUid,
        metadata
      });

      const uploader = await this.client.getFileRevisionUploader(
        entry.nodeUid,
        metadata,
      );
      const controller = await uploader.uploadFromFile(fileObject, []);
      const result = await controller.completion();
      this.settings.pathMap[path] = {
        nodeUid: result.nodeUid,
        updatedAt: new Date().toISOString(),
      };
    } else {
      this.logger.debug("File not previously synced, creating new node", {
        path
      });

      const uploader = await this.client.getFileUploader(
        parentUid,
        name,
        metadata,
      );

      const controller = await uploader.uploadFromFile(fileObject, []);
      const result = await controller.completion();

      this.settings.pathMap[path] = {
        nodeUid: result.nodeUid,
        updatedAt: new Date().toISOString(),
      };

      this.logger.debug("File synced", { path, nodeUid: result.nodeUid });
    }
  }

  private async renamePath(
    oldPath: string,
    newPath: string,
    isFolder: boolean,
  ): Promise<void> {
    this.logger.debug("Renaming path", { oldPath, newPath, isFolder });

    if (!oldPath || !newPath || !this.settings.vaultRootNodeUid) {
      return;
    }

    const entry = isFolder
      ? this.settings.folderMap[oldPath]
      : this.settings.pathMap[oldPath];
    if (!entry?.nodeUid) {
      this.logger.warn("Rename skipped: file not previously synced", {
        oldPath,
      });
      return;
    }

    const oldParent = getParentPath(oldPath);
    const newParent = getParentPath(newPath);
    const newName = getBasename(newPath);

    if (oldParent !== newParent) {
      // don't care for now
      // const targetParentUid = await this.ensureFolderPath(newParent);
      // for await (const result of this.client.moveNodes(
      //   [entry.nodeUid],
      //   targetParentUid,
      // )) {
      //   if (!result.ok) {
      //     this.logger.warn("Move failed during rename", {
      //       nodeUid: entry.nodeUid,
      //       error: result.error,
      //     });
      //     return;
      //   }
      // }
    }

    if (newName) {
      await this.client.renameNode(entry.nodeUid, newName);
    }

    if (isFolder) {
      this.renameMapEntries(this.settings.folderMap, oldPath, newPath, true);
      this.renameMapEntries(this.settings.pathMap, oldPath, newPath, true);
    } else {
      delete this.settings.pathMap[oldPath];

      this.settings.pathMap[newPath] = {
        nodeUid: entry.nodeUid,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  private renameMapEntries(
    map: Record<string, SyncMapEntry>,
    oldPath: string,
    newPath: string,
    prefixMatch: boolean = false,
  ): void {
    const entries = Object.entries(map);
    for (const [path, entry] of entries) {
      if (prefixMatch) {
        if (!path.startsWith(oldPath)) {
          continue;
        }
        const suffix = path.slice(oldPath.length);
        const nextPath = `${newPath}${suffix}`;
        delete map[path];
        map[nextPath] = entry;
        continue;
      }

      if (path === oldPath) {
        delete map[path];
        map[newPath] = entry;
      }
    }
  }

  private async ensureFolderPath(path: string): Promise<string> {
    const normalized = normalizePath(path);
    if (!normalized || !this.settings.vaultRootNodeUid) {
      return this.settings.vaultRootNodeUid ?? "";
    }

    if (this.settings.folderMap[normalized]?.nodeUid) {
      return this.settings.folderMap[normalized].nodeUid;
    }

    const segments = normalized.split("/").filter(Boolean);
    let currentPath = "";
    let parentUid = this.settings.vaultRootNodeUid;

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = this.settings.folderMap[currentPath];
      if (existing?.nodeUid) {
        parentUid = existing.nodeUid;
        continue;
      }

      const childUid = await this.findOrCreateFolder(parentUid, segment);
      this.settings.folderMap[currentPath] = {
        nodeUid: childUid,
        updatedAt: new Date().toISOString(),
      };
      parentUid = childUid;
    }

    return parentUid;
  }

  private async findOrCreateFolder(
    parentUid: string,
    name: string,
  ): Promise<string> {
    for await (const child of this.client.iterateFolderChildren(parentUid, {
      type: NodeType.Folder,
    })) {
      if (!child.ok) {
        continue;
      }
      if (child.value.name === name) {
        return child.value.uid;
      }
    }

    const created = await this.client.createFolder(parentUid, name);
    if (!created.ok) {
      throw new Error("Failed to create folder.");
    }

    return created.value.uid;
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  if (index < 0) {
    return "";
  }
  return normalized.slice(0, index);
}

function getBasename(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}

function guessMediaType(file: TFile): string {
  if (file.extension === "md") {
    return "text/markdown";
  }
  if (file.extension === "txt") {
    return "text/plain";
  }
  return "application/octet-stream";
}

async function buildFilePayload(
  file: TFile,
  vault: Vault,
): Promise<{
  metadata: UploadMetadata;
  fileObject: File;
}> {
  const mediaType = guessMediaType(file);
  const mtime = file.stat?.mtime ? new Date(file.stat.mtime) : undefined;

  let bytes: Uint8Array;
  if (file.extension === "md" || file.extension === "txt") {
    const content = await vault.read(file);
    bytes = new TextEncoder().encode(content);
  } else {
    const buffer = await vault.readBinary(file);
    bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  }

  const metadata: UploadMetadata = {
    mediaType,
    expectedSize: bytes.byteLength,
    modificationTime: mtime,
    expectedSha1: bytesToHex(sha1(bytes)),
  };

  const blob = new Blob([Uint8Array.from(bytes)], { type: mediaType });
  const fileObject = new File([blob], file.name, {
    type: mediaType,
    lastModified: mtime?.getTime(),
  });

  return { metadata, fileObject };
}

export function buildSyncEvent(
  file: TAbstractFile,
  type: SyncEventType,
  oldPath?: string,
): SyncEvent | null {
  if (type === "rename") {
    return {
      type,
      path: file.path,
      oldPath,
      isFolder: file instanceof TFolder,
    };
  }

  if (file instanceof TFolder) {
    if (type === "folder-create") {
      return { type, path: file.path, isFolder: true };
    }
    return null;
  }

  if (file instanceof TFile) {
    return { type, path: file.path };
  }

  return null;
}
