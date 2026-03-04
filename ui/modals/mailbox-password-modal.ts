import { Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

import { getI18n } from '../../i18n';

import type { App } from 'obsidian';

export class ProtonDriveMailboxPasswordModal extends Modal {
  private readonly submittedSubject = new Subject<string>();
  public readonly submitted$ = this.submittedSubject.asObservable();

  private readonly canceledSubject = new Subject<void>();
  public readonly canceled$ = this.canceledSubject.asObservable();

  private mailboxPassword = '';
  private didResolve = false;

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { t } = getI18n();
    const { contentEl } = this;

    contentEl.empty();

    contentEl.createEl('h2', { text: t.modals.mailboxPassword.title });
    const disclosure = contentEl.createEl('div', { cls: 'proton-sync-disclosure' });
    disclosure.createEl('p', {
      text: t.modals.shared.credentialsDisclosure
    });

    new Setting(contentEl)
      .setName(t.modals.mailboxPassword.passwordName)
      .setDesc(t.modals.mailboxPassword.passwordDescription)
      .addText(text => {
        text.inputEl.type = 'password';
        text.onChange(value => {
          this.mailboxPassword = value;
        });
      });

    new Setting(contentEl).addButton(button =>
      button
        .setButtonText(t.modals.mailboxPassword.submit)
        .setCta()
        .onClick(() => {
          this.didResolve = true;
          this.submittedSubject.next(this.mailboxPassword);
          this.clearSensitiveInputs();
          this.close();
        })
    );
  }

  onClose(): void {
    if (!this.didResolve) {
      this.canceledSubject.next();
    }

    this.clearSensitiveInputs();
  }

  private clearSensitiveInputs(): void {
    this.mailboxPassword = '';
  }
}
