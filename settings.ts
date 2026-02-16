import { App, PluginSettingTab, Setting } from 'obsidian';

import type ProtonDriveSyncPlugin from './main';
import type { LogLevel } from './logger';

export interface ProtonDriveSyncSettings {
  accountEmail: string;
  connectionStatus: 'disconnected' | 'pending' | 'connected' | 'error';
  lastLoginAt: string | null;
  lastLoginError: string | null;
  lastRefreshAt: string | null;
  sessionExpiresAt: string | null;
  containerNodeUid: string | null;
  vaultRootNodeUid: string | null;
  pathMap: Record<string, SyncMapEntry>;
  folderMap: Record<string, SyncMapEntry>;
  enableFileLogging: boolean;
  logLevel: LogLevel;
  logMaxSizeKb: number;
}

export interface SyncMapEntry {
  nodeUid: string;
  updatedAt: string;
}

export const DEFAULT_SETTINGS: ProtonDriveSyncSettings = {
  accountEmail: '',
  connectionStatus: 'disconnected',
  lastLoginAt: null,
  lastLoginError: null,
  lastRefreshAt: null,
  sessionExpiresAt: null,
  containerNodeUid: null,
  vaultRootNodeUid: null,
  pathMap: {},
  folderMap: {},
  enableFileLogging: false,
  logLevel: 'info',
  logMaxSizeKb: 1024
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

    const connectionSetting = new Setting(containerEl)
      .setName('Connection status')
      .setDesc(statusDescription);

    if (this.plugin.settings.connectionStatus === 'connected') {
      connectionSetting.addButton((button) =>
        button
          .setButtonText('Disconnect')
          .setCta()
          .onClick(async () => {
            await this.plugin.disconnect();
            this.display();
          })
      );
    } else {
      connectionSetting.addButton((button) =>
        button
          .setButtonText('Connect')
          .setCta()
          .onClick(() => {
            this.plugin.openLoginModal();
          })
      );
    }

    new Setting(containerEl)
      .setName('Container node UID')
      .setDesc('UID of the shared Proton Drive container folder.')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.containerNodeUid ?? 'Not set')
          .setDisabled(true)
      );

    new Setting(containerEl)
      .setName('Vault root node UID')
      .setDesc('UID of this vault’s root folder on Proton Drive.')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.vaultRootNodeUid ?? 'Not set')
          .setDisabled(true)
      );

    containerEl.createEl('h3', { text: 'Debug logging' });

    new Setting(containerEl)
      .setName('Enable file logging')
      .setDesc('Write debug logs to a file inside the vault for troubleshooting.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableFileLogging)
          .onChange(async (value) => {
            this.plugin.settings.enableFileLogging = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Log level')
      .setDesc('Minimum severity to write to the log file.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            debug: 'Debug',
            info: 'Info',
            warn: 'Warn',
            error: 'Error'
          })
          .setValue(this.plugin.settings.logLevel)
          .onChange(async (value) => {
            this.plugin.settings.logLevel = value as LogLevel;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Max log size (KB)')
      .setDesc('When the log grows beyond this size it will be trimmed.')
      .addText((text) =>
        text
          .setPlaceholder('1024')
          .setValue(String(this.plugin.settings.logMaxSizeKb))
          .onChange(async (value) => {
            const parsed = Number(value);
            this.plugin.settings.logMaxSizeKb = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.logMaxSizeKb;
            await this.plugin.saveSettings();
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
