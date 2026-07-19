import type { App } from 'obsidian';
import { Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

import { getI18n } from '../../i18n';

export class ProtonDriveTwoFactorModal extends Modal {
  readonly #submittedSubject = new Subject<string>();
  public readonly submitted$ = this.#submittedSubject.asObservable();

  readonly #canceledSubject = new Subject<void>();
  public readonly canceled$ = this.#canceledSubject.asObservable();

  #twoFactorCode = '';
  #didResolve = false;

  public constructor(app: App) {
    super(app);
  }

  public override onOpen(): void {
    const { t } = getI18n();
    const { contentEl } = this;

    contentEl.empty();

    contentEl.createEl('h2', { text: t.modals.twoFactor.title });
    const disclosure = contentEl.createEl('div', { cls: 'proton-sync-disclosure' });
    disclosure.createEl('p', {
      text: t.modals.shared.credentialsDisclosure
    });

    new Setting(contentEl)
      .setName(t.modals.twoFactor.codeName)
      .setDesc(t.modals.twoFactor.codeDescription)
      .addText(text =>
        text
          .setPlaceholder(t.modals.twoFactor.codePlaceholder)
          .onChange(value => {
            this.#twoFactorCode = value.trim();
          })
          .inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              this.#submit();
            }
          })
      );

    new Setting(contentEl).addButton(button =>
      button
        .setButtonText(t.modals.twoFactor.submit)
        .setCta()
        .onClick(() => this.#submit())
    );
  }

  public override onClose(): void {
    if (!this.#didResolve) {
      this.#canceledSubject.next();
    }

    this.#clearSensitiveInputs();
  }

  #submit(): void {
    this.#didResolve = true;
    this.#submittedSubject.next(this.#twoFactorCode);
    this.#clearSensitiveInputs();
    this.close();
  }

  #clearSensitiveInputs(): void {
    this.#twoFactorCode = '';
  }
}
