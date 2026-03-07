import { PluginSettingTab, Setting } from 'obsidian';
import type { Observable, Subscription } from 'rxjs';
import { combineLatest, Subject, take } from 'rxjs';

import { getI18n } from '../i18n';
import type ProtonDriveSyncPlugin from '../main';
import { type ProtonAuthStatus } from '../proton/auth/ProtonSessionService';
import { getLogger } from '../services/ConsoleLogger';
import { getEncryptedSecretStore } from '../services/EncryptedSecretStore';
import type { PluginSettings } from '../services/ObsidianSettingsStore';
import { getObsidianSettingsStore, LogLevel } from '../services/ObsidianSettingsStore';
import { ProtonDriveLoginModal } from './modals/login-modal';
import { toLoginIcon, toLoginLabel } from './ui-helpers';

export class ProtonDriveSyncSettingTab extends PluginSettingTab {
  readonly #disconnectSubject = new Subject<void>();
  public readonly disconnect$ = this.#disconnectSubject.asObservable();

  readonly #loginSubject = new Subject<{
    email: string;
    password: string;
  }>();
  public readonly login$ = this.#loginSubject.asObservable();

  readonly #loggingChangedSubject = new Subject<{ isEnabled: boolean; minLevel: LogLevel }>();
  public readonly loggingChanged$ = this.#loggingChangedSubject.asObservable();

  #stateSub: Subscription | undefined = undefined;
  #remoteVaultRootPath = '';

  public constructor(
    plugin: ProtonDriveSyncPlugin,
    private readonly authState: Observable<ProtonAuthStatus>
  ) {
    super(plugin.app, plugin);
  }

  public async display(): Promise<void> {
    const settingsStore = getObsidianSettingsStore();
    const { containerEl } = this;

    this.#stateSub?.unsubscribe();
    this.#stateSub = combineLatest([this.authState, settingsStore.settings$]).subscribe(([authStatus, settings]) => {
      const { t } = getI18n();
      const hasPersistedSession = getEncryptedSecretStore().hasPersistedSessionData();

      containerEl.empty();

      containerEl.createEl('h2', { text: t.settings.title });

      const disclosure = containerEl.createEl('div', { cls: 'proton-sync-disclosure' });
      disclosure.createEl('p', {
        cls: 'proton-sync-disclosure__title',
        text: t.settings.disclaimerTitle
      });
      disclosure.createEl('p', {
        text: t.settings.disclaimerBody
      });
      disclosure.createEl('p', {
        text: t.settings.disclosureCredentials
      });

      const statusDescription = this.#buildStatusDescription(settings, hasPersistedSession);
      const connectionSetting = new Setting(containerEl)
        .setName(t.settings.connectionStatus.name)
        .setDesc(statusDescription);
      connectionSetting.clear();

      if (hasPersistedSession) {
        connectionSetting.addButton(button =>
          button
            .setButtonText(t.settings.connectionStatus.disconnectButton)
            .setCta()
            .onClick(() => {
              this.#disconnectSubject.next();
            })
        );
      } else {
        connectionSetting.addButton(button =>
          button
            .setButtonText(
              authStatus === 'connecting'
                ? t.settings.connectionStatus.connectingButton
                : t.settings.connectionStatus.connectButton
            )
            .setCta()
            .setDisabled(authStatus === 'connecting')
            .onClick(() => {
              const modal = new ProtonDriveLoginModal(this.app);
              modal.login$.pipe(take(1)).subscribe(credentials => {
                settingsStore.set('accountEmail', credentials.email);

                this.#loginSubject.next(credentials);

                connectionSetting.setDesc(this.#buildStatusDescription(settings, hasPersistedSession));
              });

              modal.open();
            })
        );
      }

      this.#remoteVaultRootPath = settings.remoteVaultRootPath ?? '';

      new Setting(containerEl)
        .setName(t.settings.remoteVaultRoot.name)
        .setDesc(this.#buildRootPathDescriptionFragment())
        .addText(text => {
          text.setPlaceholder(t.settings.remoteVaultRoot.placeholder);
          text.setValue(this.#remoteVaultRootPath);
          text.onChange(value => {
            this.#remoteVaultRootPath = value;
          });
          text.inputEl.classList.add('proton-sync-full-width');
        });

      new Setting(containerEl)
        .setName(t.settings.ignoredPaths.name)
        .setDesc(t.settings.ignoredPaths.description)
        .addTextArea(text => {
          const commit = (value: string) => {
            const newPatterns = parseIgnoredPathsInput(value);
            if (isSameStringArray(newPatterns, settingsStore.get('ignoredPaths'))) {
              return;
            }

            settingsStore.set('ignoredPaths', sanitizeIgnoredPaths(newPatterns));
          };

          text.setPlaceholder(t.settings.ignoredPaths.placeholder).setValue(settings.ignoredPaths.join('\n'));

          text.inputEl.rows = 5;
          text.inputEl.cols = 50;
          text.inputEl.addEventListener('blur', () => {
            getLogger('SettingsTab').debug('Ignored paths input blurred, committing changes');
            commit(text.inputEl.value);
          });
        });

      new Setting(containerEl)
        .setName(t.settings.logLevel.name)
        .setDesc(t.settings.logLevel.description)
        .addDropdown(dropdown => {
          dropdown
            .addOption(LogLevel.debug, t.settings.logLevel.options.debug)
            .addOption(LogLevel.info, t.settings.logLevel.options.info)
            .addOption(LogLevel.warn, t.settings.logLevel.options.warn)
            .addOption(LogLevel.error, t.settings.logLevel.options.error)
            .setValue(settings.logLevel)
            .onChange(value => {
              const logLevel = value as LogLevel;
              settingsStore.set('logLevel', logLevel);
              this.#loggingChangedSubject.next({ isEnabled: true, minLevel: logLevel });
            });
        });
    });
  }

  public hide() {
    // vault root is only updated on tab hide to avoid having to create the folders in Proton on every change
    getObsidianSettingsStore().set('remoteVaultRootPath', this.#remoteVaultRootPath);
    this.#stateSub?.unsubscribe();
    this.#stateSub = undefined;
    super.hide();
  }

  #buildStatusDescription(settings: PluginSettings, hasPersistedSession: boolean): DocumentFragment {
    const { t } = getI18n();
    const fragment = document.createDocumentFragment();
    const list = document.createElement('ul');
    list.className = 'proton-sync-status-list';

    const appendItem = (label: string, text: string): void => {
      const item = document.createElement('li');
      item.innerHTML = `<span class="proton-sync-status-label">${label}</span>: ${text}`;
      list.appendChild(item);
    };

    appendItem(
      t.settings.statusLabels.status,
      `${toLoginIcon(hasPersistedSession)} ${toLoginLabel(hasPersistedSession)}`
    );

    if (settings.accountEmail) {
      appendItem(t.settings.statusLabels.account, settings.accountEmail);
    }

    if (settings.lastLoginAt) {
      appendItem(t.settings.statusLabels.lastLogin, new Date(settings.lastLoginAt).toLocaleString());
    }

    if (settings.lastRefreshAt) {
      appendItem(t.settings.statusLabels.lastRefresh, new Date(settings.lastRefreshAt).toLocaleString());
    }

    if (settings.sessionExpiresAt) {
      appendItem(t.settings.statusLabels.expires, new Date(settings.sessionExpiresAt).toLocaleString());
    }

    if (settings.lastLoginError) {
      appendItem(t.settings.statusLabels.error, settings.lastLoginError);
    }

    fragment.appendChild(list);

    return fragment;
  }

  #buildRootPathDescriptionFragment(): DocumentFragment {
    const { t } = getI18n();
    const fragment = document.createDocumentFragment();

    const line1 = document.createElement('div');
    line1.innerHTML = `<span>${t.settings.remoteVaultRoot.description1}</span>`;

    const line2 = document.createElement('div');
    line2.innerHTML = `<span>${t.settings.remoteVaultRoot.description2}</span>`;

    const line3 = document.createElement('div');
    line3.innerHTML = `<span class="proton-sync-status-label">${t.settings.remoteVaultRoot.description3}</span>`;

    fragment.appendChild(line1);
    fragment.appendChild(line2);
    fragment.appendChild(line3);

    return fragment;
  }
}

function parseIgnoredPathsInput(value: string): Array<string> {
  const seen = new Set<string>();
  const result: Array<string> = [];

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

function isSameStringArray(a: Array<string>, b: Array<string>): boolean {
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

function sanitizeIgnoredPaths(patterns: Array<string>): Array<string> {
  const sanitized: Array<string> = [];
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
