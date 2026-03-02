import { PluginSettingTab, Setting } from 'obsidian';
import { combineLatest, Subject, take } from 'rxjs';

import { ProtonDriveLoginModal } from './modals/login-modal';
import { toLoginIcon, toLoginLabel } from './ui-helpers';
import { getObsidianSettingsStore } from '../services/ObsidianSettingsStore';

import type ProtonDriveSyncPlugin from '../main';
import type { ProtonAuthStatus } from '../proton/auth/ProtonSessionService';
import type { LogLevel, PluginSettings } from '../services/ObsidianSettingsStore';
import type { Observable, Subscription } from 'rxjs';

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
}
