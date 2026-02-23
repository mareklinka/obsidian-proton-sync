import { MaybeNode, NodeType, type NodeEntity, type ProtonDriveClient } from '@protontech/drive-sdk';
import type { Vault } from 'obsidian';
import { BehaviorSubject, Subject, type Observable, type Subscription } from 'rxjs';

import { ReconciliationService } from './ReconciliationService';
import type { ObsidianVaultFileSystemReader } from './ObsidianVaultFileSystemReader';
import type { ObsidianSyncService, SyncIndexSnapshot } from './ObsidianSyncService';
import { SettingsService } from './SettingsService';
import { SyncIndexStateService } from './SyncIndexStateService';
import { LocalChangeSuppressionService } from './LocalChangeSuppressionService';
import { getLogger } from './vNext/ObsidianSyncLogger';

export type ReconcileState = 'idle' | 'reconciling';

const SYNC_CONTAINER_NAME = 'obsidian-notes';

export class CloudReconciliationService {
  private readonly logger = getLogger('CloudReconciliationService');
  private readonly stateSubject = new BehaviorSubject<ReconcileState>('idle');
  private readonly reconcileRequests = new Subject<void>();
  private readonly subscriptions: Subscription[] = [];
  private reconcileInProgress = false;
  private reconcileQueued = false;
  private cloudEventSubscription: { dispose(): void } | null = null;

  public readonly state$: Observable<ReconcileState> = this.stateSubject.asObservable();

  constructor(
    private readonly input: {
      getDriveClient: () => ProtonDriveClient | null;
      vault: Vault;
      settingsService: SettingsService;
      syncIndexStateService: SyncIndexStateService;
      getFileReader: () => ObsidianVaultFileSystemReader | null;
      getSyncService: () => ObsidianSyncService | null;
      localChangeSuppressionService: LocalChangeSuppressionService;
    }
  ) {
    this.subscriptions.push(
      this.reconcileRequests.subscribe(() => {
        if (this.reconcileInProgress) {
          this.reconcileQueued = true;
          return;
        }

        this.reconcileInProgress = true;
        void this.drainReconciliationRequests();
      })
    );
  }

  async setupCloudIntegration(): Promise<{ snapshot: SyncIndexSnapshot; vaultRootNodeUid: string }> {
    const rootInfo = await this.ensureCloudRootFolder();

    const reconciliationResult = await this.executeReconciliation(rootInfo.vaultRootNodeUid);

    this.logger.info('Initial reconciliation completed', {
      ...reconciliationResult.stats
    });

    await this.subscribeToCloudEvents();

    return { snapshot: reconciliationResult.snapshot, vaultRootNodeUid: rootInfo.vaultRootNodeUid };
  }

  private async runWithState<T>(operation: () => Promise<T>): Promise<T> {
    this.stateSubject.next('reconciling');

    try {
      const result = await operation();
      return result;
    } finally {
      this.stateSubject.next('idle');
    }
  }

  async subscribeToCloudEvents(): Promise<void> {
    if (this.cloudEventSubscription) {
      return;
    }

    const driveClient = this.input.getDriveClient();
    const { vaultRootNodeUid } = this.input.settingsService.getSyncRoots();

    if (!driveClient || !vaultRootNodeUid) {
      return;
    }

    const rootNode = await driveClient.getNode(vaultRootNodeUid);
    if (!rootNode.ok) {
      this.logger.warn('Cannot subscribe to cloud tree events: failed to load vault root node', {
        error: String(rootNode.error)
      });
      return;
    }

    const treeEventScopeId = rootNode.value.treeEventScopeId;
    this.cloudEventSubscription = await driveClient.subscribeToTreeEvents(treeEventScopeId, async event => {
      await this.input.settingsService.recordLatestEventId(event);
      this.logger.debug('Received Proton tree event', {
        type: (event as { type?: string }).type,
        eventId: (event as { eventId?: string }).eventId
      });

      this.requestReconciliationPass();
    });

    this.logger.info('Subscribed to Proton tree events', { treeEventScopeId });
  }

  private async ensureCloudRootFolder(): Promise<{
    containerNodeUid: string;
    vaultRootNodeUid: string;
  }> {
    const driveClient = this.input.getDriveClient();

    if (!driveClient) {
      throw new Error('Drive client unavailable for ensuring cloud sync roots');
    }

    const info = await this.getOrCreateSyncRootFolders(driveClient);

    await this.input.settingsService.setSyncRoots(info.containerNodeUid, info.vaultRootNodeUid);

    return info;
  }

  private async getOrCreateSyncRootFolders(client: ProtonDriveClient): Promise<{
    containerNodeUid: string;
    vaultRootNodeUid: string;
  }> {
    this.logger.debug('Ensuring sync root folders exist');

    const { containerNodeUid, vaultRootNodeUid } = this.input.settingsService.getSyncRoots();

    const myFilesRoot = await this.requireFolderNode(client.getMyFilesRootFolder(), 'My files root');

    this.logger.debug('Ensuring sync container folder exists');
    const containerNode = await this.ensureFolderByName(client, containerNodeUid, myFilesRoot.uid, SYNC_CONTAINER_NAME);

    this.logger.debug('Ensuring vault root folder exists');
    const vaultRootNode = await this.ensureFolderByName(
      client,
      vaultRootNodeUid,
      containerNode.uid,
      this.input.vault.getName()
    );

    await this.input.settingsService.setSyncRoots(containerNode.uid, vaultRootNode.uid);

    return {
      containerNodeUid: containerNode.uid,
      vaultRootNodeUid: vaultRootNode.uid
    };
  }

  private async ensureFolderByName(
    client: ProtonDriveClient,
    cachedUid: string | null,
    parentUid: string,
    name: string
  ): Promise<NodeEntity> {
    const cached = await this.getFolderByUid(client, cachedUid);
    if (cached && cached.parentUid === parentUid) {
      return cached;
    }

    if (cached) {
      this.logger.warn('Cached sync root folder moved or re-parented', {
        uid: cached.uid,
        expectedParentUid: parentUid,
        actualParentUid: cached.parentUid
      });
    }

    const existing = await this.findChildFolderByName(client, parentUid, name);
    if (existing) {
      return existing;
    }

    const created = await client.createFolder(parentUid, name);
    return this.requireFolderNode(Promise.resolve(created), `Folder ${name}`);
  }

  private async getFolderByUid(client: ProtonDriveClient, uid: string | null): Promise<NodeEntity | null> {
    if (!uid) {
      return null;
    }

    const node = await client.getNode(uid);
    if (!node.ok) {
      this.logger.warn('Sync root node lookup failed', { uid, error: node.error });
      return null;
    }

    if (node.value.type !== NodeType.Folder) {
      this.logger.warn('Sync root node is not a folder', {
        uid,
        type: node.value.type
      });
      return null;
    }

    return node.value;
  }

  private async findChildFolderByName(
    client: ProtonDriveClient,
    parentUid: string,
    name: string
  ): Promise<NodeEntity | null> {
    for await (const child of client.iterateFolderChildren(parentUid, {
      type: NodeType.Folder
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

  private async requireFolderNode(nodePromise: Promise<MaybeNode>, label: string): Promise<NodeEntity> {
    const node = await nodePromise;
    if (!node.ok) {
      throw new Error(`Failed to load ${label}.`);
    }

    if (node.value.type !== NodeType.Folder) {
      throw new Error(`${label} is not a folder.`);
    }

    return node.value;
  }

  private async runCloudReconciliationPass(): Promise<void> {
    const driveClient = this.input.getDriveClient();
    const { vaultRootNodeUid } = this.input.settingsService.getSyncRoots();
    const syncReader = this.input.getFileReader();
    const syncService = this.input.getSyncService();

    if (!driveClient || !vaultRootNodeUid || !syncReader || !syncService) {
      return;
    }

    try {
      const reconciliationResult = await this.executeReconciliation(vaultRootNodeUid);

      syncService.stop();
      syncService.initializeIndex(reconciliationResult.snapshot);
      syncService.start();

      this.logger.info('Applied cloud reconciliation pass', {
        ...reconciliationResult.stats
      });
    } catch (error) {
      this.logger.error('Cloud reconciliation pass failed', {}, error);
      throw error;
    }
  }

  private requestReconciliationPass(): void {
    if (this.reconcileInProgress) {
      this.reconcileQueued = true;
      return;
    }

    this.reconcileRequests.next();
  }

  private async drainReconciliationRequests(): Promise<void> {
    try {
      do {
        this.reconcileQueued = false;

        try {
          await this.runWithState(async () => {
            await this.runCloudReconciliationPass();
          });
        } catch {
          // Errors are already logged and reflected via reconcile state.
        }
      } while (this.reconcileQueued);
    } finally {
      this.reconcileInProgress = false;
    }
  }

  private async executeReconciliation(
    vaultRootNodeUid: string
  ): Promise<Awaited<ReturnType<ReconciliationService['run']>>> {
    const driveClient = this.input.getDriveClient();
    if (!driveClient) {
      throw new Error('Drive client unavailable for reconciliation');
    }

    const previousSnapshot = this.input.syncIndexStateService.snapshot();
    const tombstones = this.input.settingsService.getReconciliationTombstones();
    const reconciliation = new ReconciliationService(
      this.input.vault,
      driveClient,
      vaultRootNodeUid,
      this.input.localChangeSuppressionService,
      {
        previousSnapshot,
        tombstones
      }
    );

    const reconciliationResult = await reconciliation.run();

    await this.input.syncIndexStateService.applySnapshot(reconciliationResult.snapshot);
    await this.input.settingsService.setReconciliationTombstones(reconciliationResult.tombstones);

    return reconciliationResult;
  }

  reset(): void {
    this.cloudEventSubscription?.dispose();
    this.cloudEventSubscription = null;
    this.input.localChangeSuppressionService.reset();
    this.reconcileInProgress = false;
    this.reconcileQueued = false;
    this.stateSubject.next('idle');
  }

  dispose(): void {
    this.cloudEventSubscription?.dispose();
    this.cloudEventSubscription = null;
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
    this.subscriptions.length = 0;
    this.reconcileRequests.complete();
    this.stateSubject.complete();
  }
}
