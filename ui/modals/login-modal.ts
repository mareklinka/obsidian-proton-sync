import { Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

import type { App } from 'obsidian';

export class ProtonDriveLoginModal extends Modal {
  private readonly loginSubject = new Subject<{
    email: string;
    password: string;
  }>();
  public readonly login$ = this.loginSubject.asObservable();

  private email = '';
  private password = '';

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.empty();

    contentEl.createEl('h2', { text: 'Connect to Proton Drive' });

    const disclosure = contentEl.createEl('div', { cls: 'proton-sync-disclosure' });
    disclosure.createEl('p', {
      text: '⚠️ Your credentials are never stored or logged.'
    });

    new Setting(contentEl)
      .setName('Email')
      .setDesc('Your Proton account email address.')
      .addText(text =>
        text
          .setPlaceholder('john.shepard@proton.me')
          .setValue('')
          .onChange(value => {
            this.email = value.trim();
          })
      );

    new Setting(contentEl)
      .setName('Password')
      .setDesc('Never stored. Used only for this login attempt.')
      .addText(text => {
        text.inputEl.type = 'password';
        text.onChange(value => {
          this.password = value;
        });
      });

    new Setting(contentEl).addButton(button =>
      button
        .setButtonText('Connect')
        .setCta()
        .onClick(async () => {
          this.loginSubject.next({
            email: this.email,
            password: this.password
          });
          this.clearSensitiveInputs();
          this.close();
        })
    );
  }

  onClose(): void {
    this.clearSensitiveInputs();
  }

  private clearSensitiveInputs(): void {
    this.password = '';
  }
}
