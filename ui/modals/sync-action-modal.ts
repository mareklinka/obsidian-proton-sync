import { Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

import type { App } from 'obsidian';

export type ConfigSyncAction = 'push' | 'pull';

export class ProtonDriveSyncActionModal extends Modal {
  private readonly submittedSubject = new Subject<ConfigSyncAction>();
  public readonly submitted$ = this.submittedSubject.asObservable();

  private readonly canceledSubject = new Subject<void>();
  public readonly canceled$ = this.canceledSubject.asObservable();

  private didResolve = false;

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Proton Drive Sync' });
    contentEl.createEl('p', {
      text: 'Choose whether to push your local vault data to Proton Drive, or pull remote data to local. This operation synchronizes both notes and vault configuration.'
    });

    new Setting(contentEl)
      .addButton(button =>
        button
          .setIcon('cloud-upload')
          .setClass('proton-sync-config-push-button')
          .onClick(() => {
            this.didResolve = true;
            this.submittedSubject.next('push');
            this.close();
          })
      )
      .addButton(button =>
        button
          .setIcon('cloud-download')
          .setClass('proton-sync-config-pull-button')
          .onClick(() => {
            this.didResolve = true;
            this.submittedSubject.next('pull');
            this.close();
          })
      );
  }

  onClose(): void {
    if (!this.didResolve) {
      this.canceledSubject.next();
    }
  }
}
