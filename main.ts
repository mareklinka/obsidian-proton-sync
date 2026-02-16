import { Notice, Plugin } from 'obsidian';

import { ProtonDriveLoginModal } from './login-modal';
import { ProtonAuthService } from './proton-auth';
import { createProtonDriveClient } from './proton-drive-client';
import { clearKeyPassphrase, loadKeyPassphrase, saveKeyPassphrase } from './key-passphrase-store';
import { clearSession, loadSession, saveSession, type ProtonSession } from './session-store';
import { DEFAULT_SETTINGS, ProtonDriveSyncSettings, ProtonDriveSyncSettingTab } from './settings';

export default class ProtonDriveSyncPlugin extends Plugin {
  settings!: ProtonDriveSyncSettings;
  private authService!: ProtonAuthService;
  private refreshIntervalId: number | null = null;
  private currentSession: ProtonSession | null = null;
  private driveClient: ReturnType<typeof createProtonDriveClient> | null = null;

  private static readonly REFRESH_INTERVAL_MS = 15 * 60 * 1000;
  private static readonly REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

  async onload(): Promise<void> {
    console.log('Loading Proton Drive Sync plugin');

    await this.loadSettings();

    this.authService = new ProtonAuthService(this.manifest.version);

    const existingSession = await loadSession(this.app);
    if (existingSession) {
      this.settings.connectionStatus = 'connected';
      this.settings.lastLoginAt = existingSession.updatedAt;
      this.settings.lastRefreshAt = existingSession.lastRefreshAt;
      this.settings.sessionExpiresAt = existingSession.expiresAt;
      await this.saveSettings();

      this.initializeDriveClient(existingSession);
      await this.refreshSessionIfNeeded(existingSession, true);
      this.startRefreshLoop();
    }

    this.addSettingTab(new ProtonDriveSyncSettingTab(this.app, this));

    this.addRibbonIcon('refresh-ccw', 'Proton Drive Sync', () => {
      new Notice('Proton Drive Sync: scaffold loaded');
    });
  }

  async onunload(): Promise<void> {
    console.log('Unloading Proton Drive Sync plugin');
    this.stopRefreshLoop();
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
      this.settings.lastRefreshAt = session.lastRefreshAt;
      this.settings.sessionExpiresAt = session.expiresAt;
      this.settings.lastLoginError = null;
      await this.saveSettings();

      const keyPassphrase = this.deriveKeyPassphrase(credentials.password);
      await saveKeyPassphrase(this.app, keyPassphrase);

      this.initializeDriveClient(session);

      this.startRefreshLoop();

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
    this.settings.lastRefreshAt = null;
    this.settings.sessionExpiresAt = null;
    await this.saveSettings();
    await clearSession(this.app);
    await clearKeyPassphrase(this.app);
    this.currentSession = null;
    this.driveClient = null;
    this.stopRefreshLoop();
    new Notice('Disconnected from Proton Drive.');
  }

  private startRefreshLoop(): void {
    if (this.refreshIntervalId !== null) {
      return;
    }

    this.refreshIntervalId = window.setInterval(() => {
      void this.refreshSessionOnInterval();
    }, ProtonDriveSyncPlugin.REFRESH_INTERVAL_MS);
  }

  private stopRefreshLoop(): void {
    if (this.refreshIntervalId === null) {
      return;
    }

    window.clearInterval(this.refreshIntervalId);
    this.refreshIntervalId = null;
  }

  private async refreshSessionOnInterval(): Promise<void> {
    const session = await loadSession(this.app);
    if (!session) {
      return;
    }

    await this.refreshSessionIfNeeded(session, false);
  }

  private async refreshSessionIfNeeded(session: Awaited<ReturnType<typeof loadSession>>, force: boolean): Promise<void> {
    if (!session) {
      return;
    }

    const expiresAt = new Date(session.expiresAt).getTime();
    const now = Date.now();
    const timeToExpiry = expiresAt - now;

    if (!force && timeToExpiry > ProtonDriveSyncPlugin.REFRESH_THRESHOLD_MS) {
      return;
    }

    try {
      const refreshed = await this.authService.refreshSession(session);
      await saveSession(this.app, refreshed);
      this.settings.connectionStatus = 'connected';
      this.settings.lastRefreshAt = refreshed.lastRefreshAt;
      this.settings.sessionExpiresAt = refreshed.expiresAt;
      this.settings.lastLoginError = null;
      await this.saveSettings();

      this.currentSession = refreshed;
      if (!this.driveClient) {
        this.initializeDriveClient(refreshed);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Session refresh failed.';
      this.settings.connectionStatus = 'error';
      this.settings.lastLoginError = message;
      await this.saveSettings();
      await clearSession(this.app);
      this.currentSession = null;
      this.driveClient = null;
      this.stopRefreshLoop();
      new Notice(message);
    }
  }

  private initializeDriveClient(session: ProtonSession): void {
    this.currentSession = session;
    this.driveClient = createProtonDriveClient(
      () => this.currentSession,
      () => loadKeyPassphrase(this.app),
      this.manifest.version
    );
  }

  private deriveKeyPassphrase(password: string): string {
    return password;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
