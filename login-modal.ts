import { App, Modal, Setting } from 'obsidian';

import { Subject } from 'rxjs';

export class ProtonDriveLoginModal extends Modal {
  private readonly loginSubject = new Subject<{
    email: string;
    password: string;
    mailboxPassword: string;
    twoFactorCode: string;
  }>();
  public readonly login$ = this.loginSubject.asObservable();

  private email = '';
  private password = '';
  private mailboxPassword = '';
  private twoFactorCode = '';

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.empty();

    contentEl.createEl('h2', { text: 'Connect to Proton Drive' });
    contentEl.createEl('p', {
      text: 'This is an unofficial integration. Your password and 2FA code are never stored.'
    });

    new Setting(contentEl).setName('Email').addText(text =>
      text
        .setPlaceholder('you@example.com')
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

    new Setting(contentEl)
      .setName('Mailbox password (if enabled)')
      .setDesc('Only required if your Proton account uses a separate mailbox password.')
      .addText(text => {
        text.inputEl.type = 'password';
        text.onChange(value => {
          this.mailboxPassword = value;
        });
      });

    new Setting(contentEl)
      .setName('2FA code')
      .setDesc('If your account has 2FA enabled, enter the current code.')
      .addText(text =>
        text.setPlaceholder('123456').onChange(value => {
          this.twoFactorCode = value.trim();
        })
      );

    new Setting(contentEl)
      .addButton(button =>
        button
          .setButtonText('Connect')
          .setCta()
          .onClick(async () => {
            this.loginSubject.next({
              email: this.email,
              password: this.password,
              mailboxPassword: this.mailboxPassword,
              twoFactorCode: this.twoFactorCode
            });
            this.clearSensitiveInputs();
            this.close();
          })
      )
      .addExtraButton(button =>
        button
          .setIcon('cross')
          .setTooltip('Cancel')
          .onClick(() => {
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
    this.mailboxPassword = '';
    this.twoFactorCode = '';
  }
}
