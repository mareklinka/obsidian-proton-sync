import { Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

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
    const { contentEl } = this;

    contentEl.empty();

    contentEl.createEl('h2', { text: 'Mailbox password required' });
    const disclosure = contentEl.createEl('div', { cls: 'proton-sync-disclosure' });
    disclosure.createEl('p', {
      text: '⚠️ Your credentials are never stored or logged.'
    });

    new Setting(contentEl)
      .setName('Mailbox password')
      .setDesc('Required for Proton accounts that use a separate mailbox password.')
      .addText(text => {
        text.inputEl.type = 'password';
        text.onChange(value => {
          this.mailboxPassword = value;
        });
      });

    new Setting(contentEl).addButton(button =>
      button
        .setButtonText('Submit')
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
