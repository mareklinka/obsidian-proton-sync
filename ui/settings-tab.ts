import { PluginSettingTab, Setting } from 'obsidian';
import { combineLatest, Observable, Subject, Subscription, take } from 'rxjs';

import { ProtonDriveLoginModal } from './modals/login-modal';
import ProtonDriveSyncPlugin from '../main';
import { toLoginIcon, toLoginLabel } from './ui-helpers';
import { ProtonAuthStatus } from '../proton/auth/ProtonSessionService';
import { getObsidianSettingsStore, LogLevel, PluginSettings } from '../services/vNext/ObsidianSettingsStore';

export class ProtonDriveSyncSettingTab extends PluginSettingTab {
  private readonly disconnectSubject = new Subject<void>();
  public readonly disconnect$ = this.disconnectSubject.asObservable();

  private readonly loginSubject = new Subject<{
    email: string;
    password: string;
  }>();
  public readonly login$ = this.loginSubject.asObservable();

  private readonly loggingChangedSubject = new Subject<{ isEnabled: boolean; minLevel: LogLevel }>();
  public readonly loggingChanged$ = this.loggingChangedSubject.asObservable();

  private stateSub: Subscription | undefined = undefined;

  constructor(
    plugin: ProtonDriveSyncPlugin,
    private readonly authState: Observable<ProtonAuthStatus>
  ) {
    super(plugin.app, plugin);
  }

  async display(): Promise<void> {
    const settingsStore = getObsidianSettingsStore();
    const { containerEl } = this;

    combineLatest([this.authState, settingsStore.settings$]).subscribe(([authStatus, settings]) => {
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
      connectionSetting.clear();

      if (authStatus === 'connected') {
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
            .setButtonText(authStatus === 'connecting' ? 'Connecting...' : 'Connect')
            .setCta()
            .setDisabled(authStatus === 'connecting')
            .onClick(() => {
              const modal = new ProtonDriveLoginModal(this.app);
              modal.login$.pipe(take(1)).subscribe(credentials => {
                settingsStore.setAccountEmail(credentials.email);

                this.loginSubject.next(credentials);

                connectionSetting.setDesc(this.buildStatusDescription(settings));
              });

              modal.open();
            })
        );
      }
    });

    // containerEl.createEl('h3', { text: 'Debug logging' });

    // new Setting(containerEl)
    //   .setName('Enable file logging')
    //   .setDesc('Write debug logs to a file inside the vault for troubleshooting.')
    //   .addToggle(toggle =>
    //     toggle.setValue(settingsStore.enableFileLogging).onChange(async value => {
    //       await this.settingsService.setLogging({ enableFileLogging: value });
    //       settingsStore = this.settingsService.snapshot();
    //       this.emitLogSettingsChange(settingsStore);
    //     })
    //   );

    // new Setting(containerEl)
    //   .setName('Log level')
    //   .setDesc('Minimum severity to write to the log file.')
    //   .addDropdown(dropdown =>
    //     dropdown
    //       .addOptions({
    //         debug: 'Debug',
    //         info: 'Info',
    //         warn: 'Warn',
    //         error: 'Error'
    //       })
    //       .setValue(settingsStore.logLevel)
    //       .onChange(async value => {
    //         await this.settingsService.setLogging({ logLevel: value as LogLevel });
    //         settingsStore = this.settingsService.snapshot();
    //         this.emitLogSettingsChange(settingsStore);
    //       })
    //   );

    // new Setting(containerEl)
    //   .setName('Max log size (KB)')
    //   .setDesc('When the log grows beyond this size it will be trimmed.')
    //   .addText(text =>
    //     text
    //       .setPlaceholder('1024')
    //       .setValue(String(settingsStore.logMaxSizeKb))
    //       .onChange(async value => {
    //         const parsed = Number(value);
    //         await this.settingsService.setLogging({
    //           logMaxSizeKb: Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.logMaxSizeKb
    //         });
    //         settingsStore = this.settingsService.snapshot();
    //         this.emitLogSettingsChange(settingsStore);
    //       })
    //   );
  }

  public hide() {
    this.stateSub?.unsubscribe();
    this.stateSub = undefined;
    super.hide();
  }

  private buildStatusDescription(settings: PluginSettings): DocumentFragment {
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

  // private emitLogSettingsChange(settings: PluginSettings): void {
  //   this.loggingChangedSubject.next({
  //     isEnabled: settings.enableFileLogging,
  //     maxSize: settings.logMaxSizeKb,
  //     minLevel: settings.logLevel
  //   });
  // }
}
