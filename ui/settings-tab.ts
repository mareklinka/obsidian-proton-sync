import { PluginSettingTab, Setting } from 'obsidian';
import { Subject, take } from 'rxjs';

import { type LogLevel } from '../logger';
import { DEFAULT_SETTINGS, type ProtonDriveSyncSettings } from '../model/settings';
import { ProtonDriveLoginModal } from './modals/login-modal';
import ProtonDriveSyncPlugin from '../main';
import { toLoginIcon, toLoginLabel } from './ui-helpers';
import { SettingsService } from '../services/SettingsService';

export class ProtonDriveSyncSettingTab extends PluginSettingTab {
  private readonly disconnectSubject = new Subject<void>();
  public readonly disconnect$ = this.disconnectSubject.asObservable();

  private readonly loginSubject = new Subject<{
    email: string;
    password: string;
  }>();
  public readonly login$ = this.loginSubject.asObservable();

  private readonly loggingChangedSubject = new Subject<{ isEnabled: boolean; maxSize: number; minLevel: LogLevel }>();
  public readonly loggingChanged$ = this.loggingChangedSubject.asObservable();

  constructor(
    plugin: ProtonDriveSyncPlugin,
    private readonly settingsService: SettingsService
  ) {
    super(plugin.app, plugin);
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    let settings = this.settingsService.snapshot();

    containerEl.empty();

    containerEl.createEl('h2', { text: 'Proton Drive Sync' });

    const disclosure = containerEl.createEl('div', { cls: 'proton-sync-disclosure' });
    disclosure.createEl('p', {
      cls: 'proton-sync-disclosure__title',
      text: '⚠️ Disclaimer'
    });
    disclosure.createEl('p', {
      text: 'This plugin is an unofficial, third-party integration with Proton Drive.'
    });
    disclosure.createEl('p', {
      text: 'You will be asked to enter your credentials into this plugin. Passwords or other sensitive information are never stored or logged.'
    });

    const statusDescription = this.buildStatusDescription(settings);
    const connectionSetting = new Setting(containerEl).setName('Connection status').setDesc(statusDescription);

    if (settings.connectionStatus === 'connected') {
      connectionSetting.addButton(button =>
        button
          .setButtonText('Disconnect')
          .setCta()
          .onClick(() => {
            this.disconnectSubject.next();
          })
      );
    } else {
      connectionSetting.addButton(button =>
        button
          .setButtonText('Connect')
          .setCta()
          .onClick(() => {
            const modal = new ProtonDriveLoginModal(this.app);
            modal.login$.pipe(take(1)).subscribe(async credentials => {
              await this.settingsService.setAccountEmail(credentials.email);

              this.loginSubject.next(credentials);

              settings = this.settingsService.snapshot();
              connectionSetting.setDesc(this.buildStatusDescription(settings));
            });
            modal.open();
          })
      );
    }

    containerEl.createEl('h3', { text: 'Debug logging' });

    new Setting(containerEl)
      .setName('Enable file logging')
      .setDesc('Write debug logs to a file inside the vault for troubleshooting.')
      .addToggle(toggle =>
        toggle.setValue(settings.enableFileLogging).onChange(async value => {
          await this.settingsService.setLogging({ enableFileLogging: value });
          settings = this.settingsService.snapshot();
          this.emitLogSettingsChange(settings);
        })
      );

    new Setting(containerEl)
      .setName('Log level')
      .setDesc('Minimum severity to write to the log file.')
      .addDropdown(dropdown =>
        dropdown
          .addOptions({
            debug: 'Debug',
            info: 'Info',
            warn: 'Warn',
            error: 'Error'
          })
          .setValue(settings.logLevel)
          .onChange(async value => {
            await this.settingsService.setLogging({ logLevel: value as LogLevel });
            settings = this.settingsService.snapshot();
            this.emitLogSettingsChange(settings);
          })
      );

    new Setting(containerEl)
      .setName('Max log size (KB)')
      .setDesc('When the log grows beyond this size it will be trimmed.')
      .addText(text =>
        text
          .setPlaceholder('1024')
          .setValue(String(settings.logMaxSizeKb))
          .onChange(async value => {
            const parsed = Number(value);
            await this.settingsService.setLogging({
              logMaxSizeKb: Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.logMaxSizeKb
            });
            settings = this.settingsService.snapshot();
            this.emitLogSettingsChange(settings);
          })
      );
  }

  private buildStatusDescription(settings: ProtonDriveSyncSettings): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const list = document.createElement('ul');
    list.className = 'proton-sync-status-list';

    const appendLine = (text: string): void => {
      const item = document.createElement('li');
      item.textContent = text;
      list.appendChild(item);
    };

    appendLine(`Status: ${toLoginIcon(settings.connectionStatus)} ${toLoginLabel(settings.connectionStatus)}`);

    if (settings.lastLoginAt) {
      appendLine(`Last login: ${new Date(settings.lastLoginAt).toLocaleString()}`);
    }

    if (settings.lastRefreshAt) {
      appendLine(`Last refresh: ${new Date(settings.lastRefreshAt).toLocaleString()}`);
    }

    if (settings.sessionExpiresAt) {
      appendLine(`Expires: ${new Date(settings.sessionExpiresAt).toLocaleString()}`);
    }

    if (settings.lastLoginError) {
      appendLine(`Error: ${settings.lastLoginError}`);
    }

    fragment.appendChild(list);

    return fragment;
  }
  private emitLogSettingsChange(settints: ProtonDriveSyncSettings): void {
    this.loggingChangedSubject.next({
      isEnabled: settints.enableFileLogging,
      maxSize: settints.logMaxSizeKb,
      minLevel: settints.logLevel
    });
  }
}
