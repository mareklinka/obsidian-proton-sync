import type { App } from 'obsidian';
import type { ButtonComponent } from 'obsidian';
import { Modal, Notice, Setting } from 'obsidian';
import { Subject } from 'rxjs';

import { getI18n } from '../../i18n';

export interface ChangeMasterPasswordPayload {
  currentPassword: string;
  newPassword: string;
}

export class ProtonDriveChangeMasterPasswordModal extends Modal {
  readonly #submittedSubject = new Subject<ChangeMasterPasswordPayload>();
  public readonly submitted$ = this.#submittedSubject.asObservable();

  #currentPassword = '';
  #newPassword = '';
  #confirmPassword = '';
  #submitButton: ButtonComponent | null = null;

  public constructor(app: App) {
    super(app);
  }

  public override onOpen(): void {
    const { t } = getI18n();
    const { contentEl } = this;

    contentEl.empty();

    contentEl.createEl('h2', { text: t.modals.changeMasterPassword.title });

    const disclosure = contentEl.createEl('div', { cls: 'proton-sync-disclosure' });
    disclosure.createEl('p', {
      text: t.modals.changeMasterPassword.description
    });

    new Setting(contentEl).setName(t.modals.changeMasterPassword.currentPasswordName).addText(text => {
      text.inputEl.type = 'password';
      text.onChange(value => {
        this.#currentPassword = value;
      });
      text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          this.#submit();
        }
      });
    });

    new Setting(contentEl)
      .setName(t.modals.changeMasterPassword.newPasswordName)
      .setDesc(t.modals.changeMasterPassword.newPasswordDescription)
      .addText(text => {
        text.inputEl.type = 'password';
        text.onChange(value => {
          this.#newPassword = value;
        });
        text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            this.#submit();
          }
        });
      });

    new Setting(contentEl).setName(t.modals.changeMasterPassword.confirmPasswordName).addText(text => {
      text.inputEl.type = 'password';
      text.onChange(value => {
        this.#confirmPassword = value;
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
        .setButtonText(t.modals.changeMasterPassword.submitButton)
        .setCta()
        .onClick(() => this.#submit());
    });
  }

  public override onClose(): void {
    this.#clearSensitiveInputs();
  }

  #submit(): void {
    const { t } = getI18n();

    if (!this.#currentPassword.trim() || !this.#newPassword.trim() || !this.#confirmPassword.trim()) {
      new Notice(t.modals.changeMasterPassword.validationRequired);
      return;
    }

    if (this.#newPassword !== this.#confirmPassword) {
      new Notice(t.modals.changeMasterPassword.validationMismatch);
      return;
    }

    if (this.#currentPassword === this.#newPassword) {
      new Notice(t.modals.changeMasterPassword.validationSamePassword);
      return;
    }

    if (this.#submitButton) {
      this.#submitButton.setButtonText(t.modals.changeMasterPassword.processingButton).setDisabled(true);
    }
    this.#submittedSubject.next({
      currentPassword: this.#currentPassword,
      newPassword: this.#newPassword
    });
    this.#clearSensitiveInputs();
    this.close();
  }

  #clearSensitiveInputs(): void {
    this.#currentPassword = '';
    this.#newPassword = '';
    this.#confirmPassword = '';
  }
}
