import type { App } from 'obsidian';
import { Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

import { getI18n } from '../../i18n';
import type { SyncConflict, SyncConflictDecision } from '../../services/SyncService';

export class ProtonDriveConflictResolutionModal extends Modal {
  readonly #submittedSubject = new Subject<SyncConflictDecision>();
  public readonly submitted$ = this.#submittedSubject.asObservable();

  readonly #canceledSubject = new Subject<void>();
  public readonly canceled$ = this.#canceledSubject.asObservable();

  #didResolve = false;
  #applyToAll = false;

  public constructor(
    app: App,
    private readonly conflict: SyncConflict
  ) {
    super(app);
  }

  public override onOpen(): void {
    const { t } = getI18n();
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: t.modals.conflictResolution.title });
    contentEl.createEl('p', {
      text: describeConflict(this.conflict)
    });

    new Setting(contentEl).setName(t.modals.conflictResolution.affectedPathLabel).setDesc(this.conflict.path);

    if (this.conflict.conflictingPath) {
      new Setting(contentEl)
        .setName(t.modals.conflictResolution.conflictingPathLabel)
        .setDesc(this.conflict.conflictingPath);
    }

    new Setting(contentEl)
      .setName(t.modals.conflictResolution.applyToAllLabel)
      .setDesc(t.modals.conflictResolution.applyToAllDescription)
      .addToggle(toggle => {
        toggle.setValue(this.#applyToAll).onChange(value => {
          this.#applyToAll = value;
        });
      });

    new Setting(contentEl)
      .addButton(button =>
        button.setButtonText(t.modals.conflictResolution.skipButton).onClick(() => {
          this.#didResolve = true;
          this.#submittedSubject.next({ action: 'skip', applyToAll: this.#applyToAll });
          this.close();
        })
      )
      .addButton(button =>
        button
          .setButtonText(
            this.conflict.direction === 'push'
              ? t.modals.conflictResolution.overwriteRemoteButton
              : t.modals.conflictResolution.overwriteLocalButton
          )
          .setWarning()
          .onClick(() => {
            this.#didResolve = true;
            this.#submittedSubject.next({ action: 'overwrite', applyToAll: this.#applyToAll });
            this.close();
          })
      );
  }

  public override onClose(): void {
    if (!this.#didResolve) {
      this.#canceledSubject.next();
    }
  }
}

function describeConflict(conflict: SyncConflict): string {
  const { t } = getI18n();

  switch (conflict.reason) {
    case 'contentChanged':
      return conflict.direction === 'push'
        ? t.modals.conflictResolution.contentChangedPush
        : t.modals.conflictResolution.contentChangedPull;
    case 'missingSnapshotBaseline':
      return conflict.direction === 'push'
        ? t.modals.conflictResolution.missingSnapshotBaselinePush
        : t.modals.conflictResolution.missingSnapshotBaselinePull;
    case 'localFolderRemoteFileTypeMismatch':
      return t.modals.conflictResolution.localFolderRemoteFileTypeMismatch;
    case 'localFileRemoteFolderTypeMismatch':
      return t.modals.conflictResolution.localFileRemoteFolderTypeMismatch;
    case 'remoteFolderLocalFileTypeMismatch':
      return t.modals.conflictResolution.remoteFolderLocalFileTypeMismatch;
    case 'remoteFileLocalFolderTypeMismatch':
      return t.modals.conflictResolution.remoteFileLocalFolderTypeMismatch;
    case 'pruneFileChanged':
      return conflict.direction === 'push'
        ? t.modals.conflictResolution.pruneFileChangedPush
        : t.modals.conflictResolution.pruneFileChangedPull;
    case 'pruneFileMissingSnapshotBaseline':
      return conflict.direction === 'push'
        ? t.modals.conflictResolution.pruneFileMissingSnapshotBaselinePush
        : t.modals.conflictResolution.pruneFileMissingSnapshotBaselinePull;
    case 'pruneFolderChanged':
      return conflict.direction === 'push'
        ? t.modals.conflictResolution.pruneFolderChangedPush
        : t.modals.conflictResolution.pruneFolderChangedPull;
    case 'pruneRemoteFolderLocalFileTypeMismatch':
      return t.modals.conflictResolution.pruneRemoteFolderLocalFileTypeMismatch;
    case 'pruneRemoteFileLocalFolderTypeMismatch':
      return t.modals.conflictResolution.pruneRemoteFileLocalFolderTypeMismatch;
  }
}
