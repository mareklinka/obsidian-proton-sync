import type { App } from 'obsidian';
import type { ButtonComponent } from 'obsidian';
import { Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

import { getI18n } from '../../i18n';

export type MasterPasswordModalMode = 'setup' | 'unlock' | 'session-refresh';

export class ProtonDriveMasterPasswordModal extends Modal {
  readonly #submittedSubject = new Subject<string>();
  public readonly submitted$ = this.#submittedSubject.asObservable();

  readonly #canceledSubject = new Subject<void>();
  public readonly canceled$ = this.#canceledSubject.asObservable();

  #masterPassword = '';
  #didResolve = false;
  #submitButton: ButtonComponent | null = null;

  public constructor(
    app: App,
    private readonly mode: MasterPasswordModalMode
  ) {
    super(app);
  }

  public override onOpen(): void {
    const { t } = getI18n();
    const { contentEl } = this;
    const title =
      this.mode === 'setup'
        ? t.modals.masterPassword.setupTitle
        : this.mode === 'session-refresh'
          ? t.modals.masterPassword.sessionRefreshTitle
          : t.modals.masterPassword.unlockTitle;
    const description =
      this.mode === 'session-refresh'
        ? t.modals.masterPassword.sessionRefreshDescription
        : t.modals.masterPassword.description;
    const passwordDescription =
      this.mode === 'setup'
        ? t.modals.masterPassword.passwordDescription
        : this.mode === 'session-refresh'
          ? t.modals.masterPassword.sessionRefreshPasswordDescription
          : '';
    const submitButtonText =
      this.mode === 'setup'
        ? t.modals.masterPassword.setupButton
        : this.mode === 'session-refresh'
          ? t.modals.masterPassword.sessionRefreshButton
          : t.modals.masterPassword.unlockButton;

    contentEl.empty();

    contentEl.createEl('h2', {
      text: title
    });
    const disclosure = contentEl.createEl('div', { cls: 'proton-sync-disclosure' });
    disclosure.createEl('p', {
      text: description
    });

    new Setting(contentEl)
      .setName(t.modals.masterPassword.passwordName)
      .setDesc(passwordDescription)
      .addText(text => {
        text.inputEl.type = 'password';
        text.onChange(value => {
          this.#masterPassword = value;
        });
        text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            this.#submit();
          }
        });
      });

    new Setting(contentEl).addButton(button => {
      this.#submitButton = button;
      button
        .setButtonText(submitButtonText)
        .setCta()
        .onClick(() => this.#submit());
    });
  }

  public override onClose(): void {
    if (!this.#didResolve) {
      this.#canceledSubject.next();
    }

    this.#clearSensitiveInputs();
  }

  #submit(): void {
    this.#didResolve = true;
    if (this.#submitButton) {
      const { t } = getI18n();
      this.#submitButton.setButtonText(t.modals.masterPassword.processingButton).setDisabled(true);
    }
    this.#submittedSubject.next(this.#masterPassword);
    this.#clearSensitiveInputs();
    this.close();
  }

  #clearSensitiveInputs(): void {
    this.#masterPassword = '';
  }
}
