import { App, Modal, Setting } from 'obsidian';

import { Subject } from 'rxjs';

export class ProtonDriveTwoFactorModal extends Modal {
  private readonly submittedSubject = new Subject<string>();
  public readonly submitted$ = this.submittedSubject.asObservable();

  private readonly canceledSubject = new Subject<void>();
  public readonly canceled$ = this.canceledSubject.asObservable();

  private twoFactorCode = '';
  private didResolve = false;

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.empty();

    contentEl.createEl('h2', { text: 'Two-factor authentication required' });
    const disclosure = contentEl.createEl('div', { cls: 'proton-sync-disclosure' });
    disclosure.createEl('p', {
      text: '⚠️ Your credentials are never stored or logged.'
    });

    new Setting(contentEl)
      .setName('2FA code')
      .setDesc('Enter the current code from your authenticator app.')
      .addText(text =>
        text.setPlaceholder('123456').onChange(value => {
          this.twoFactorCode = value.trim();
        })
      );

    new Setting(contentEl).addButton(button =>
      button
        .setButtonText('Submit')
        .setCta()
        .onClick(() => {
          this.didResolve = true;
          this.submittedSubject.next(this.twoFactorCode);
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
    this.twoFactorCode = '';
  }
}
