import { Notice, Plugin } from 'obsidian';

import { ProtonDriveLoginModal } from './login-modal';
import { ProtonAuthService } from './proton-auth';
import { clearSession, loadSession, saveSession } from './session-store';
import { DEFAULT_SETTINGS, ProtonDriveSyncSettings, ProtonDriveSyncSettingTab } from './settings';

export default class ProtonDriveSyncPlugin extends Plugin {
  settings!: ProtonDriveSyncSettings;
  private authService!: ProtonAuthService;

  async onload(): Promise<void> {
    console.log('Loading Proton Drive Sync plugin');

    await this.loadSettings();

    this.authService = new ProtonAuthService(this.manifest.version);

    const existingSession = await loadSession(this.app);
    if (existingSession) {
      this.settings.connectionStatus = 'connected';
      this.settings.lastLoginAt = existingSession.updatedAt;
    }

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

    try {
      this.settings.accountEmail = credentials.email.trim();
      this.settings.connectionStatus = 'pending';
      this.settings.lastLoginAt = new Date().toISOString();
      this.settings.lastLoginError = null;
      await this.saveSettings();

      const session = await this.authService.signIn(
        credentials.email.trim(),
        credentials.password,
        credentials.twoFactorCode
      );

      await saveSession(this.app, session);

      this.settings.connectionStatus = 'connected';
      this.settings.lastLoginAt = session.updatedAt;
      this.settings.lastLoginError = null;
      await this.saveSettings();

      new Notice('Connected to Proton Drive.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed.';
      this.settings.connectionStatus = 'error';
      this.settings.lastLoginError = message;
      await this.saveSettings();
      new Notice(message);
    }
  }

  async disconnect(): Promise<void> {
    this.settings.connectionStatus = 'disconnected';
    this.settings.lastLoginError = null;
    await this.saveSettings();
    await clearSession(this.app);
    new Notice('Disconnected from Proton Drive.');
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
