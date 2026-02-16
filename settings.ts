import { App, PluginSettingTab, Setting } from 'obsidian';

import type ProtonDriveSyncPlugin from './main';

export interface ProtonDriveSyncSettings {
  accountEmail: string;
  connectionStatus: 'disconnected' | 'pending' | 'connected' | 'error';
  lastLoginAt: string | null;
  lastLoginError: string | null;
  lastRefreshAt: string | null;
  sessionExpiresAt: string | null;
}

export const DEFAULT_SETTINGS: ProtonDriveSyncSettings = {
  accountEmail: '',
  connectionStatus: 'disconnected',
  lastLoginAt: null,
  lastLoginError: null,
  lastRefreshAt: null,
  sessionExpiresAt: null
};

export class ProtonDriveSyncSettingTab extends PluginSettingTab {
  private readonly plugin: ProtonDriveSyncPlugin;

  constructor(app: App, plugin: ProtonDriveSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h2', { text: 'Proton Drive Sync' });

    const disclosure = containerEl.createEl('div');
    disclosure.createEl('p', {
      text: 'This plugin is an unofficial, third-party integration with Proton Drive.'
    });
    disclosure.createEl('p', {
      text: 'You will be asked to enter your credentials into this plugin. Passwords are never stored.'
    });

    new Setting(containerEl)
      .setName('Account email')
      .setDesc('Used for login and identification. Stored locally in plugin settings.')
      .addText((text) =>
        text
          .setPlaceholder('you@example.com')
          .setValue(this.plugin.settings.accountEmail)
          .onChange(async (value) => {
            this.plugin.settings.accountEmail = value.trim();
            await this.plugin.saveSettings();
          })
      );

    const statusDescription = this.buildStatusDescription();

    new Setting(containerEl)
      .setName('Connection status')
      .setDesc(statusDescription)
      .addButton((button) =>
        button
          .setButtonText('Connect')
          .onClick(() => {
            this.plugin.openLoginModal();
          })
      )
      .addExtraButton((button) =>
        button
          .setIcon('trash')
          .setTooltip('Disconnect')
          .onClick(async () => {
            await this.plugin.disconnect();
            this.display();
          })
      );
  }

  private buildStatusDescription(): DocumentFragment {
    const fragment = document.createDocumentFragment();

    fragment.appendText(`Status: ${this.plugin.settings.connectionStatus}`);

    if (this.plugin.settings.lastLoginAt) {
      fragment.appendText(` • Last login: ${this.plugin.settings.lastLoginAt}`);
    }

    if (this.plugin.settings.lastRefreshAt) {
      fragment.appendText(` • Last refresh: ${this.plugin.settings.lastRefreshAt}`);
    }

    if (this.plugin.settings.sessionExpiresAt) {
      fragment.appendText(` • Expires: ${this.plugin.settings.sessionExpiresAt}`);
    }

    if (this.plugin.settings.lastLoginError) {
      fragment.appendText(` • Error: ${this.plugin.settings.lastLoginError}`);
    }

    return fragment;
  }
}
