import { Notice, Plugin, TFolder } from "obsidian";

import { ProtonDriveLoginModal } from "./login-modal";
import { ProtonAuthService } from "./proton-auth";
import { createProtonDriveClient } from "./proton-drive-client";
import {
  clearKeyPassphrase,
  loadKeyPassphrase,
  saveKeyPassphrase,
} from "./key-passphrase-store";
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
import { ObsidianHttpClient } from "./ObsidianHttpClient";
import { ProtonApiClient } from "./proton-api";
import { computeKeyPasswordFromSalt } from "./proton-srp";

export default class ProtonDriveSyncPlugin extends Plugin {
  settings!: ProtonDriveSyncSettings;
  private authService!: ProtonAuthService;
  private refreshIntervalId: number | null = null;
  private currentSession: ProtonSession | null = null;
  private driveClient: ReturnType<typeof createProtonDriveClient> | null = null;
  private logger!: PluginLogger;
  private settingTab: ProtonDriveSyncSettingTab | null = null;
  private layoutReady = false;
  private pendingSyncRootDiscovery = false;
  private syncQueue: SyncQueue | null = null;

  private static readonly REFRESH_INTERVAL_MS = 15 * 60 * 1000;
  private static readonly REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

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
    this.authService = new ProtonAuthService(
      this.manifest.version,
      this.logger,
    );

    const existingSession = await loadSession(this.app);
    if (existingSession) {
      this.logger.info("Loaded existing session", {
        expiresAt: existingSession.expiresAt,
      });
      this.settings.connectionStatus = "connected";
      this.settings.lastLoginAt = existingSession.updatedAt;
      this.settings.lastRefreshAt = existingSession.lastRefreshAt;
      this.settings.sessionExpiresAt = existingSession.expiresAt;
      await this.saveSettings();

      this.initializeDriveClient();
      await this.refreshSessionIfNeeded(existingSession, true);
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
    twoFactorCode: string;
  }): Promise<void> {
    if (!credentials.email || !credentials.password) {
      new Notice("Email and password are required to connect.");
      return;
    }

    try {
      this.logger.info("Starting sign-in flow", {
        email: maskEmail(credentials.email),
      });
      this.settings.accountEmail = credentials.email.trim();
      this.settings.connectionStatus = "pending";
      this.settings.lastLoginAt = new Date().toISOString();
      this.settings.lastLoginError = null;
      await this.saveSettings();

      const authResult = await this.authService.signIn(
        credentials.email.trim(),
        credentials.password,
        credentials.twoFactorCode,
      );

      if (authResult.passwordMode === 2 && !credentials.mailboxPassword) {
        throw new Error("Mailbox password required for this Proton account.");
      }

      const session = authResult.session;

      await saveSession(this.app, session);
      this.currentSession = session;

      this.settings.connectionStatus = "connected";
      this.settings.lastLoginAt = session.updatedAt;
      this.settings.lastRefreshAt = session.lastRefreshAt;
      this.settings.sessionExpiresAt = session.expiresAt;
      this.settings.lastLoginError = null;
      await this.saveSettings();

      this.app.secretStorage.setSecret(
        "proton-drive-sync-salted-passphrases",
        JSON.stringify(await this.deriveSaltedPassphrases(this.getBasePassword(credentials))),
      );
      this.initializeDriveClient();

      this.scheduleSyncRootDiscovery("sign-in");

      this.startRefreshLoop();

      this.logger.info("Sign-in successful", { expiresAt: session.expiresAt });

      new Notice("Connected to Proton Drive.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Login failed.";
      this.logger.error(
        "Sign-in failed",
        { email: maskEmail(credentials.email) },
        error,
      );
      this.settings.connectionStatus = "error";
      this.settings.lastLoginError = message;
      await this.saveSettings();
      new Notice(message);
    }
  }

  async disconnect(): Promise<void> {
    this.logger.info("Disconnecting from Proton Drive");
    this.settings.connectionStatus = "disconnected";
    this.settings.lastLoginError = null;
    this.settings.lastRefreshAt = null;
    this.settings.sessionExpiresAt = null;
    await this.saveSettings();
    await clearSession(this.app);
    await clearKeyPassphrase(this.app);
    this.currentSession = null;
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
    const session = await loadSession(this.app);
    if (!session) {
      return;
    }

    await this.refreshSessionIfNeeded(session, false);
  }

  private async refreshSessionIfNeeded(
    session: Awaited<ReturnType<typeof loadSession>>,
    force: boolean,
  ): Promise<void> {
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
      this.logger.debug("Refreshing session", {
        force,
        timeToExpiryMs: timeToExpiry,
      });

      const refreshed = await this.authService.refreshSession(session);
      await saveSession(this.app, refreshed);
      this.settings.connectionStatus = "connected";
      this.settings.lastRefreshAt = refreshed.lastRefreshAt;
      this.settings.sessionExpiresAt = refreshed.expiresAt;
      this.settings.lastLoginError = null;
      await this.saveSettings();

      this.currentSession = refreshed;
      if (!this.driveClient) {
        this.initializeDriveClient();
      }

      this.scheduleSyncRootDiscovery("refresh");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Session refresh failed.";
      this.logger.error("Session refresh failed", { force }, error);
      this.settings.connectionStatus = "error";
      this.settings.lastLoginError = message;
      await this.saveSettings();
      await clearSession(this.app);
      this.currentSession = null;
      this.driveClient = null;
      this.stopRefreshLoop();
      new Notice(message);
    }
  }

  private async deriveSaltedPassphrases(
    password: string,
  ): Promise<Record<string, string>> {
    const apiClient = new ProtonApiClient(
      () => this.currentSession,
      this.manifest.version,
      "https://mail.proton.me/api",
      this.logger,
    );

    const salts = await getKeySalts(apiClient, this.logger);
    var saltedPasshphrases = deriveKeyPassphrasesFromSalts(password, salts);

    return saltedPasshphrases;
  }

  private async initializeDriveClient(): Promise<void> {
    this.driveClient = createProtonDriveClient(
      () => this.currentSession,
      JSON.parse(
        this.app.secretStorage.getSecret(
          "proton-drive-sync-salted-passphrases",
        ) || "{}",
      ) as Record<string, string>,
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

  private getBasePassword(credentials: {
    password: string;
    mailboxPassword?: string;
  }): string {
    return credentials.mailboxPassword?.trim() || credentials.password;
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

type ProtonKeySaltEntry = {
  ID?: string;
  KeySalt?: string;
};

type ProtonKeySaltsResponse = {
  KeySalts?: ProtonKeySaltEntry[];
};

async function getKeySalts(
  apiClient: ProtonApiClient,
  logger?: PluginLogger,
): Promise<Map<string, string>> {
  try {
    const response = await apiClient.getJson<ProtonKeySaltsResponse>(
      "/core/v4/keys/salts",
    );

    const entries = response.KeySalts ?? [];
    const map = new Map<string, string>();

    for (const entry of entries) {
      if (!entry.ID || !entry.KeySalt) {
        continue;
      }

      map.set(entry.ID, entry.KeySalt);
    }

    return map;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("scope")) {
      logger?.warn(
        "Key salts unavailable due to missing scope; falling back to address key salts if present.",
      );

      return new Map<string, string>();
    }

    throw error;
  }
}

function deriveKeyPassphrasesFromSalts(
  passphrase: string,
  keySalts: Map<string, string>,
) {
  const result: Record<string, string> = {};
  for (const [keyId, keySalt] of keySalts.entries()) {
    result[keyId] = computeKeyPasswordFromSalt(passphrase, keySalt);
  }

  return result;
}
