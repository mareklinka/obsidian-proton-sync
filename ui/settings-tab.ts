import { PluginSettingTab, Setting } from 'obsidian';
import { combineLatest, Subject, take } from 'rxjs';

import { ProtonDriveLoginModal } from './modals/login-modal';
import { toLoginIcon, toLoginLabel } from './ui-helpers';
import { getObsidianSettingsStore, LogLevel } from '../services/ObsidianSettingsStore';
import { getLogger } from '../services/ObsidianSyncLogger';

import type ProtonDriveSyncPlugin from '../main';
import type { ProtonAuthStatus } from '../proton/auth/ProtonSessionService';
import type { PluginSettings } from '../services/ObsidianSettingsStore';
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
  private remoteVaultRootPath: string = '';

  constructor(
    plugin: ProtonDriveSyncPlugin,
    private readonly authState: Observable<ProtonAuthStatus>
  ) {
    super(plugin.app, plugin);
  }

  async display(): Promise<void> {
    const settingsStore = getObsidianSettingsStore();
    const { containerEl } = this;

    this.stateSub?.unsubscribe();
    this.stateSub = combineLatest([this.authState, settingsStore.settings$]).subscribe(([authStatus, settings]) => {
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
                settingsStore.set('accountEmail', credentials.email);

                this.loginSubject.next(credentials);

                connectionSetting.setDesc(this.buildStatusDescription(settings));
              });

              modal.open();
            })
        );
      }

      new Setting(containerEl)
        .setName('Remote vault root')
        .setDesc('The root folder in Proton Drive where your vault will be synced.')
        .addText(text => {
          text.setPlaceholder('e.g. obsidian-notes/my-vault');
          text.setValue(settings.remoteVaultRootPath ?? '');
          text.onChange(value => {
            this.remoteVaultRootPath = value;
          });
        });

      new Setting(containerEl)
        .setName('Ignored paths')
        .setDesc('One glob pattern per line. Paths are relative to vault root and ignored by both push and pull.')
        .addTextArea(text => {
          const commit = (value: string) => {
            const newPatterns = parseIgnoredPathsInput(value);
            if (isSameStringArray(newPatterns, settingsStore.get('ignoredPaths'))) {
              return;
            }

            settingsStore.set('ignoredPaths', sanitizeIgnoredPaths(newPatterns));
          };

          text
            .setPlaceholder('.obsidian/workspace*\ntemplates/**\n**/*.tmp')
            .setValue(settings.ignoredPaths.join('\n'));

          text.inputEl.rows = 5;
          text.inputEl.cols = 50;
          text.inputEl.addEventListener('blur', () => {
            getLogger('SettingsTab').debug('Ignored paths input blurred, committing changes');
            commit(text.inputEl.value);
          });
        });

      new Setting(containerEl)
        .setName('Log level')
        .setDesc('Minimum log severity to write to the developer console.')
        .addDropdown(dropdown => {
          dropdown
            .addOption(LogLevel.debug, 'Debug')
            .addOption(LogLevel.info, 'Info')
            .addOption(LogLevel.warn, 'Warn')
            .addOption(LogLevel.error, 'Error')
            .setValue(settings.logLevel)
            .onChange(value => {
              const logLevel = value as LogLevel;
              settingsStore.set('logLevel', logLevel);
              this.loggingChangedSubject.next({ isEnabled: true, minLevel: logLevel });
            });
        });
    });
  }

  public hide() {
    // vault root is only updated on tab hide to avoid having to create the folders in Proton on every change
    getObsidianSettingsStore().set('remoteVaultRootPath', this.remoteVaultRootPath);
    this.stateSub?.unsubscribe();
    this.stateSub = undefined;
    super.hide();
  }

  private buildStatusDescription(settings: PluginSettings): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const list = document.createElement('ul');
    list.className = 'proton-sync-status-list';

    const appendItem = (label: string, text: string): void => {
      const item = document.createElement('li');
      item.innerHTML = `<span class="proton-sync-status-label">${label}</span>: ${text}`;
      list.appendChild(item);
    };

    appendItem('Status', `${toLoginIcon(settings.connectionStatus)} ${toLoginLabel(settings.connectionStatus)}`);

    if (settings.accountEmail) {
      appendItem('Account', settings.accountEmail);
    }

    if (settings.lastLoginAt) {
      appendItem('Last login', new Date(settings.lastLoginAt).toLocaleString());
    }

    if (settings.lastRefreshAt) {
      appendItem('Last refresh', new Date(settings.lastRefreshAt).toLocaleString());
    }

    if (settings.sessionExpiresAt) {
      appendItem('Expires', new Date(settings.sessionExpiresAt).toLocaleString());
    }

    if (settings.lastLoginError) {
      appendItem('Error', settings.lastLoginError);
    }

    fragment.appendChild(list);

    return fragment;
  }
}

function parseIgnoredPathsInput(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function isSameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

function sanitizeIgnoredPaths(patterns: string[]): string[] {
  const sanitized: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed) {
      continue;
    }

    if (seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    sanitized.push(trimmed);
  }

  return sanitized;
}
