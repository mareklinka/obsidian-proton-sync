import type { App } from 'obsidian';
import { Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

import { getI18n } from '../../i18n';

export class ProtonDriveLoginModal extends Modal {
  readonly #loginSubject = new Subject<{
    email: string;
    password: string;
  }>();
  public readonly login$ = this.#loginSubject.asObservable();

  #email = '';
  #password = '';

  public constructor(app: App) {
    super(app);
  }

  public override onOpen(): void {
    const { t } = getI18n();
    const { contentEl } = this;

    contentEl.empty();

    contentEl.createEl('h2', { text: t.modals.login.title });

    const disclosure = contentEl.createEl('div', { cls: 'proton-sync-disclosure' });
    disclosure.createEl('p', {
      text: t.modals.shared.credentialsDisclosure
    });

    new Setting(contentEl)
      .setName(t.modals.login.emailName)
      .setDesc(t.modals.login.emailDescription)
      .addText(text =>
        text
          .setPlaceholder(t.modals.login.emailPlaceholder)
          .setValue('')
          .onChange(value => {
            this.#email = value.trim();
          })
      );

    new Setting(contentEl)
      .setName(t.modals.login.passwordName)
      .setDesc(t.modals.login.passwordDescription)
      .addText(text => {
        text.inputEl.type = 'password';
        text.onChange(value => {
          this.#password = value;
        });
      });

    new Setting(contentEl).addButton(button =>
      button
        .setButtonText(t.modals.login.submit)
        .setCta()
        .onClick(async () => {
          this.#loginSubject.next({
            email: this.#email,
            password: this.#password
          });
          this.#clearSensitiveInputs();
          this.close();
        })
    );
  }

  public override onClose(): void {
    this.#clearSensitiveInputs();
  }

  #clearSensitiveInputs(): void {
    this.#password = '';
  }
}
