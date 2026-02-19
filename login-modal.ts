import { App, Modal, Notice, Setting } from 'obsidian';

import type ProtonDriveSyncPlugin from './main';

export class ProtonDriveLoginModal extends Modal {
  private readonly plugin: ProtonDriveSyncPlugin;
  private email = '';
  private password = '';
  private mailboxPassword = '';
  private twoFactorCode = '';

  constructor(app: App, plugin: ProtonDriveSyncPlugin) {
    super(app);
    this.plugin = plugin;
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
        .setValue(this.plugin.settings.accountEmail)
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
            await this.plugin.signIn({
              email: this.email || this.plugin.settings.accountEmail,
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

    if (!this.plugin.settings.accountEmail) {
      new Notice('Tip: set your account email in settings for faster login.');
    }
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
