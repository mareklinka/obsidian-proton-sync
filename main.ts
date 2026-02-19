import { Notice, Plugin, TFolder } from "obsidian";

import { ProtonDriveLoginModal } from "./login-modal";
import { createProtonDriveClient } from "./proton-drive-client";
import { ProtonAuthService } from "./proton-auth";
import {
  clearSession,
  loadSession,
  saveSession,
  type ProtonSession,
} from "./session-store";
import {
  DEFAULT_SETTINGS,
  ProtonDriveSyncSettings,
  ProtonDriveSyncSettingTab,
} from "./settings";
import {
  createFileLogger,
  getDefaultLogFilePath,
  type PluginLogger,
} from "./logger";
import { ensureSyncRoots } from "./sync-root";
import { buildSyncEvent, SyncQueue } from "./sync-queue";
import {
  createProtonIntegration,
  type SecretStore,
  type SessionStore,
  type ProtonIntegrationHandle,
} from "./proton-integration/public";

const PROTON_SALTED_PASSPHRASES_SECRET_KEY =
  "proton-drive-sync-salted-passphrases";

export default class ProtonDriveSyncPlugin extends Plugin {
  settings!: ProtonDriveSyncSettings;
  private proton!: ProtonIntegrationHandle;
  private secretStore!: SecretStore;
  private refreshIntervalId: number | null = null;
  private driveClient: ReturnType<typeof createProtonDriveClient> | null = null;
  private logger!: PluginLogger;
  private settingTab: ProtonDriveSyncSettingTab | null = null;
  private layoutReady = false;
  private pendingSyncRootDiscovery = false;
  private syncQueue: SyncQueue | null = null;

  private static readonly REFRESH_INTERVAL_MS = 15 * 60 * 1000;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.logger = createFileLogger(this.app, {
      enabled: this.settings.enableFileLogging,
      level: this.settings.logLevel,
      filePath: getDefaultLogFilePath(),
      maxFileSizeBytes: this.settings.logMaxSizeKb * 1024,
    });

    this.logger.info("Loading Proton Drive Sync plugin", {
      version: this.manifest.version,
    });

    this.secretStore = this.createSecretStore();
    const authService = new ProtonAuthService(
      this.manifest.version,
      this.logger,
    );

    const sessionStore: SessionStore = {
      load: () => loadSession(this.app),
      save: (session: ProtonSession) => saveSession(this.app, session),
      clear: () => clearSession(this.app),
    };

    this.proton = createProtonIntegration({
      appVersion: this.manifest.version,
      logger: this.logger,
      sessionStore,
      secretStore: this.secretStore,
      authGateway: {
        signIn: (credentials) =>
          authService.signIn(
            credentials.email,
            credentials.password,
            credentials.twoFactorCode ?? "",
          ),
        refresh: (session) => authService.refreshSession(session),
      },
    });

    const restored = await this.proton.restoreFromStorage({
      forceRefreshOnRestore: true,
    });
    await this.syncSettingsWithIntegration();

    if (restored && this.proton.getSession()) {
      this.initializeDriveClient();
      this.startRefreshLoop();
      this.scheduleSyncRootDiscovery("startup");
    }

    this.settingTab = new ProtonDriveSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.app.workspace.onLayoutReady(() => {
      this.layoutReady = true;
      if (this.pendingSyncRootDiscovery) {
        this.pendingSyncRootDiscovery = false;
        void this.initializeSyncRoots("layout");
      }
    });

    this.addRibbonIcon("refresh-ccw", "Proton Drive Sync", () => {
      new Notice("Proton Drive Sync: scaffold loaded");
    });
  }

  async onunload(): Promise<void> {
    this.logger.info("Unloading Proton Drive Sync plugin");
    this.stopRefreshLoop();
    this.syncQueue?.dispose();
  }

  openLoginModal(): void {
    new ProtonDriveLoginModal(this.app, this).open();
  }

  async signIn(credentials: {
    email: string;
    password: string;
    mailboxPassword?: string;
    twoFactorCode?: string;
  }): Promise<void> {
    if (!credentials.email || !credentials.password) {
      new Notice("Email and password are required to connect.");
      return;
    }

    try {
      this.logger.info("Starting sign-in flow", {
        email: maskEmail(credentials.email),
      });
      await this.proton.signIn({
        email: credentials.email.trim(),
        password: credentials.password,
        mailboxPassword: credentials.mailboxPassword,
        twoFactorCode: credentials.twoFactorCode,
      });

      await this.syncSettingsWithIntegration();
      this.initializeDriveClient();

      this.scheduleSyncRootDiscovery("sign-in");

      this.startRefreshLoop();

      this.logger.info("Sign-in successful", {
        expiresAt: this.proton.getSession()?.expiresAt,
      });

      new Notice("Connected to Proton Drive.");
    } catch (error) {
      await this.syncSettingsWithIntegration();
      const integrationError = this.proton.getStatus().lastError;
      const message =
        integrationError ||
        (error instanceof Error ? error.message : "Login failed.");
      this.logger.error(
        "Sign-in failed",
        { email: maskEmail(credentials.email) },
        error,
      );
      new Notice(message);
    }
  }

  async disconnect(): Promise<void> {
    this.logger.info("Disconnecting from Proton Drive");
    await this.proton.disconnect();
    await this.syncSettingsWithIntegration();
    this.driveClient = null;
    this.stopRefreshLoop();
    new Notice("Disconnected from Proton Drive.");
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
    const refreshed = await this.proton.refreshIfNeeded(false);
    await this.syncSettingsWithIntegration();

    if (!refreshed) {
      const status = this.proton.getStatus();
      if (status.state === "error") {
        this.driveClient = null;
        this.stopRefreshLoop();
        if (status.lastError) {
          new Notice(status.lastError);
        }
      }
      return;
    }

    if (!this.driveClient) {
      this.initializeDriveClient();
    }

    this.scheduleSyncRootDiscovery("refresh");
  }

  private initializeDriveClient(): void {
    const sessionProvider = () => this.proton.getSession();
    this.driveClient = createProtonDriveClient(
      sessionProvider,
      this.loadSaltedPassphrases(),
      this.manifest.version,
      this.logger,
    );
  }

  private scheduleSyncRootDiscovery(
    reason: "startup" | "sign-in" | "refresh",
  ): void {
    if (this.settings.connectionStatus !== "connected" || !this.driveClient) {
      return;
    }

    if (!this.layoutReady) {
      this.pendingSyncRootDiscovery = true;
      this.logger.debug("Deferring sync root discovery until layout ready", {
        reason,
      });
      return;
    }

    void this.initializeSyncRoots(reason);
  }

  private async initializeSyncRoots(
    reason: "startup" | "sign-in" | "refresh" | "layout",
  ): Promise<void> {
    if (!this.driveClient || this.settings.connectionStatus !== "connected") {
      return;
    }

    try {
      const vaultName = this.app.vault.getName();
      const info = await ensureSyncRoots(
        this.driveClient,
        this.settings,
        vaultName,
        this.logger,
      );
      await this.saveSettings();
      this.logger.info("Sync roots ready", { reason, ...info });
      this.initializeSyncQueue();
    } catch (error) {
      this.logger.error("Failed to ensure sync roots", { reason }, error);
      new Notice("Failed to initialize Proton Drive sync roots.");
    }
  }

  private initializeSyncQueue(): void {
    if (!this.driveClient || !this.settings.vaultRootNodeUid) {
      return;
    }

    if (!this.syncQueue) {
      this.syncQueue = new SyncQueue(
        this.app.vault,
        this.driveClient,
        this.settings,
        this.logger,
        () => this.saveSettings(),
      );

      this.registerEvent(
        this.app.vault.on("create", (file) => {
          const event = buildSyncEvent(
            file,
            file instanceof TFolder ? "folder-create" : "file-create",
          );
          if (event) {
            this.syncQueue?.enqueue(event);
          }
        }),
      );

      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          const event = buildSyncEvent(file, "file-modify");
          if (event) {
            this.syncQueue?.enqueue(event);
          }
        }),
      );

      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          const event = buildSyncEvent(file, "rename", oldPath);
          if (event) {
            this.syncQueue?.enqueue(event);
          }
        }),
      );
    }
  }

  private loadSaltedPassphrases(): Record<string, string> {
    try {
      const raw = this.secretStore.get(PROTON_SALTED_PASSPHRASES_SECRET_KEY);
      if (!raw) {
        return {};
      }

      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private createSecretStore(): SecretStore {
    const cache = new Map<string, string>();

    const getSecret = this.app.secretStorage.getSecret.bind(
      this.app.secretStorage,
    ) as (key: string) => string | Promise<string>;
    const setSecret = this.app.secretStorage.setSecret.bind(
      this.app.secretStorage,
    ) as (key: string, value: string) => void | Promise<void>;

    return {
      get: (key: string): string | null => {
        if (cache.has(key)) {
          return cache.get(key) ?? null;
        }

        const value = getSecret(key);
        if (typeof value === "string") {
          cache.set(key, value);
          return value || null;
        }

        void value.then((resolved) => {
          cache.set(key, resolved ?? "");
        });
        return null;
      },
      set: (key: string, value: string): void => {
        cache.set(key, value);
        void setSecret(key, value);
      },
      clear: (key: string): void => {
        cache.delete(key);
        void setSecret(key, "");
      },
    };
  }

  private async syncSettingsWithIntegration(): Promise<void> {
    const status = this.proton.getStatus();
    const session = this.proton.getSession();

    this.settings.accountEmail =
      status.accountEmail ?? this.settings.accountEmail;
    this.settings.connectionStatus = status.state;
    this.settings.lastLoginError = status.lastError ?? null;
    this.settings.lastLoginAt = session?.updatedAt ?? this.settings.lastLoginAt;
    this.settings.lastRefreshAt = session?.lastRefreshAt ?? null;
    this.settings.sessionExpiresAt =
      status.expiresAt ?? session?.expiresAt ?? null;

    await this.saveSettings();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.logger?.updateSettings({
      enabled: this.settings.enableFileLogging,
      level: this.settings.logLevel,
      filePath: getDefaultLogFilePath(),
      maxFileSizeBytes: this.settings.logMaxSizeKb * 1024,
    });
    this.settingTab?.display();
  }
}

function maskEmail(email: string): string {
  const trimmed = email.trim();
  const [user, domain] = trimmed.split("@");
  if (!user || !domain) {
    return trimmed;
  }

  const visible =
    user.length <= 2
      ? user[0] + "***"
      : `${user[0]}***${user[user.length - 1]}`;
  return `${visible}@${domain}`;
}
