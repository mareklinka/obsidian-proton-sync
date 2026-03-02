import { App, Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

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

    const warningEl = contentEl.createDiv({ cls: 'proton-sync-disclosure' });
    warningEl.createEl('p', {
      cls: 'proton-sync-disclosure__title',
      text: '⚠️ Potentially destructive operation'
    });
    warningEl.createEl('p', {
      text: 'Sync may overwrite existing content when conflicts are detected. Please ensure your vault is backed up before proceeding.'
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
