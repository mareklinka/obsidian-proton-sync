import type { App } from 'obsidian';
import { Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

import { getI18n } from '../../i18n';

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
    const { t } = getI18n();
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: t.modals.syncAction.title });
    contentEl.createEl('p', {
      text: t.modals.syncAction.description
    });

    new Setting(contentEl)
      .addButton(button =>
        button
          .setButtonText(t.modals.syncAction.pushButton)
          .setClass('proton-sync-config-push-button')
          .onClick(() => {
            this.didResolve = true;
            this.submittedSubject.next('push');
            this.close();
          })
      )
      .addButton(button =>
        button
          .setButtonText(t.modals.syncAction.pullButton)
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
