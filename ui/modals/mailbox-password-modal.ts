import type { App } from 'obsidian';
import { Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

import { getI18n } from '../../i18n';

export class ProtonDriveMailboxPasswordModal extends Modal {
  readonly #submittedSubject = new Subject<string>();
  public readonly submitted$ = this.#submittedSubject.asObservable();

  readonly #canceledSubject = new Subject<void>();
  public readonly canceled$ = this.#canceledSubject.asObservable();

  #mailboxPassword = '';
  #didResolve = false;

  public constructor(app: App) {
    super(app);
  }

  public onOpen(): void {
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
          this.#mailboxPassword = value;
        });
      });

    new Setting(contentEl).addButton(button =>
      button
        .setButtonText(t.modals.mailboxPassword.submit)
        .setCta()
        .onClick(() => {
          this.#didResolve = true;
          this.#submittedSubject.next(this.#mailboxPassword);
          this.#clearSensitiveInputs();
          this.close();
        })
    );
  }

  public onClose(): void {
    if (!this.#didResolve) {
      this.#canceledSubject.next();
    }

    this.#clearSensitiveInputs();
  }

  #clearSensitiveInputs(): void {
    this.#mailboxPassword = '';
  }
}
