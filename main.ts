import { Notice, Plugin } from 'obsidian';

import { ProtonDriveLoginModal } from './login-modal';
import { DEFAULT_SETTINGS, ProtonDriveSyncSettings, ProtonDriveSyncSettingTab } from './settings';

export default class ProtonDriveSyncPlugin extends Plugin {
  settings: ProtonDriveSyncSettings;

  async onload(): Promise<void> {
    console.log('Loading Proton Drive Sync plugin');

    await this.loadSettings();

    this.addSettingTab(new ProtonDriveSyncSettingTab(this.app, this));

    this.addRibbonIcon('refresh-ccw', 'Proton Drive Sync', () => {
      new Notice('Proton Drive Sync: scaffold loaded');
    });
  }

  async onunload(): Promise<void> {
    console.log('Unloading Proton Drive Sync plugin');
  }

  openLoginModal(): void {
    new ProtonDriveLoginModal(this.app, this).open();
  }

  async signIn(credentials: {
    email: string;
    password: string;
    twoFactorCode: string;
  }): Promise<void> {
    if (!credentials.email || !credentials.password) {
      new Notice('Email and password are required to connect.');
      return;
    }

    this.settings.accountEmail = credentials.email.trim();
    this.settings.connectionStatus = 'pending';
    this.settings.lastLoginAt = new Date().toISOString();
    this.settings.lastLoginError = null;
    await this.saveSettings();

    new Notice('Login flow not yet implemented. Credentials were not stored.');

    this.settings.connectionStatus = 'disconnected';
    this.settings.lastLoginError = 'Login flow not implemented.';
    await this.saveSettings();
  }

  async disconnect(): Promise<void> {
    this.settings.connectionStatus = 'disconnected';
    this.settings.lastLoginError = null;
    await this.saveSettings();
    new Notice('Disconnected from Proton Drive.');
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
