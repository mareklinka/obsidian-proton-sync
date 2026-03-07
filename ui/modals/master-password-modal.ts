import type { App } from 'obsidian';
import { Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

import { getI18n } from '../../i18n';

export class ProtonDriveMasterPasswordModal extends Modal {
  readonly #submittedSubject = new Subject<string>();
  public readonly submitted$ = this.#submittedSubject.asObservable();

  readonly #canceledSubject = new Subject<void>();
  public readonly canceled$ = this.#canceledSubject.asObservable();

  #masterPassword = '';
  #didResolve = false;

  public constructor(
    app: App,
    private readonly mode: 'setup' | 'unlock'
  ) {
    super(app);
  }

  public onOpen(): void {
    const { t } = getI18n();
    const { contentEl } = this;

    contentEl.empty();

    contentEl.createEl('h2', {
      text: this.mode === 'setup' ? t.modals.masterPassword.setupTitle : t.modals.masterPassword.unlockTitle
    });
    const disclosure = contentEl.createEl('div', { cls: 'proton-sync-disclosure' });
    disclosure.createEl('p', {
      text: t.modals.masterPassword.description
    });

    new Setting(contentEl)
      .setName(t.modals.masterPassword.passwordName)
      .setDesc(this.mode === 'setup' ? t.modals.masterPassword.passwordDescription : '')
      .addText(text => {
        text.inputEl.type = 'password';
        text.onChange(value => {
          this.#masterPassword = value;
        });
      });

    new Setting(contentEl).addButton(button =>
      button
        .setButtonText(
          this.mode === 'setup' ? t.modals.masterPassword.setupButton : t.modals.masterPassword.unlockButton
        )
        .setCta()
        .onClick(() => {
          this.#didResolve = true;
          this.#submittedSubject.next(this.#masterPassword);
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
    this.#masterPassword = '';
  }
}
