import { App, Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

export type ConfigSyncAction = 'push' | 'pull';

export class ProtonDriveConfigSyncActionModal extends Modal {
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

    contentEl.createEl('h2', { text: 'Vault configuration sync' });
    contentEl.createEl('p', {
      text: 'Choose whether to push your local vault configuration to Proton Drive, or pull remote configuration to local.'
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
          .setWarning()
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
