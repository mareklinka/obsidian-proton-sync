import type { App } from 'obsidian';
import { Modal, Setting } from 'obsidian';
import { type Subscription } from 'rxjs';

import { getI18n } from '../../i18n';
import { cancelSyncOperationCancellation } from '../../services/SyncOperationCancellation';
import { getSyncService } from '../../services/SyncService';
import { toConfigSyncProgressViewState } from '../config-sync-progress-state';

export const { init: initSyncProgressModal, get: getSyncProgressModal } = (function () {
  let instance: SyncProgressModal | null = null;

  return {
    init: function init(this: void, app: App): SyncProgressModal {
      return (instance ??= new SyncProgressModal(app));
    },
    get: function get(this: void): SyncProgressModal {
      if (!instance) {
        throw new Error('SyncProgressModal has not been initialized. Please call initSyncProgressModalApi first.');
      }
      return instance;
    }
  };
})();

class SyncProgressModal extends Modal {
  #stateSubscription: Subscription | null = null;
  #messageEl: HTMLElement | null = null;
  #detailsEl: HTMLElement | null = null;
  #progressBarEl: HTMLElement | null = null;
  #progressFillEl: HTMLElement | null = null;
  #autoCloseIntervalId: number | null = null;
  #autoCloseTimeoutId: number | null = null;
  #cancelButtonSetting: Setting | null = null;
  #cancelButtonEl: HTMLButtonElement | null = null;

  #terminalState: 'running' | 'completed' | 'failed' | 'cancelled' = 'running';

  public constructor(app: App) {
    super(app);
  }

  public onOpen(): void {
    const { t } = getI18n();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('proton-sync-config-progress');
    contentEl.removeClass('proton-sync-progress--failed');
    contentEl.removeClass('proton-sync-progress--completed');

    contentEl.createEl('h2', { text: t.modals.syncProgress.title });

    this.#messageEl = contentEl.createEl('p', {
      cls: 'proton-sync-progress__message',
      text: t.modals.syncProgress.initialMessage
    });

    this.#detailsEl = contentEl.createEl('p', {
      cls: 'proton-sync-progress__details',
      text: t.modals.syncProgress.initialDetails
    });

    this.#progressBarEl = contentEl.createDiv({
      cls: 'proton-sync-progress__bar proton-sync-progress__bar--determinate'
    });
    this.#progressBarEl.setAttr('role', 'progressbar');
    this.#progressBarEl.setAttr('aria-valuemin', '0');
    this.#progressBarEl.setAttr('aria-valuemax', '100');
    this.#progressBarEl.setAttr('aria-valuenow', '0');
    this.#progressBarEl.style.setProperty('--proton-sync-progress-scale', '0');

    this.#progressFillEl = this.#progressBarEl.createDiv({
      cls: 'proton-sync-progress__bar-fill'
    });

    this.#cancelButtonSetting = new Setting(contentEl);
    this.#cancelButtonSetting.addButton(button => {
      button
        .setButtonText(t.common.cancel)
        .setWarning()
        .onClick(() => {
          const wasCancelled = cancelSyncOperationCancellation();
          if (!wasCancelled) {
            return;
          }

          if (this.#cancelButtonEl) {
            this.#cancelButtonEl.disabled = true;
          }

          this.#render(t.modals.syncProgress.cancellingMessage, t.modals.syncProgress.cancellingDetails, null);
        });

      this.#cancelButtonEl = button.buttonEl;
    });

    const setting = new Setting(contentEl).setDesc(t.modals.syncProgress.closeHint);
    this.#cancelButtonSetting.settingEl.hide();

    this.#stateSubscription = getSyncService().state$.subscribe(state => {
      if (state.state === 'idle') {
        setting.descEl.hide();
        this.#progressBarEl?.hide();
        this.#cancelButtonSetting?.settingEl.hide();
      } else {
        setting.descEl.show();
        this.#progressBarEl?.show();
        this.#cancelButtonSetting?.settingEl.show();
      }

      if (this.#terminalState !== 'running') {
        return;
      }

      const viewState = toConfigSyncProgressViewState(state);
      this.#render(viewState.message, viewState.details, viewState.progressPercent);
    });
  }

  public onClose(): void {
    this.#stateSubscription?.unsubscribe();
    this.#stateSubscription = null;
    this.#clearAutoCloseTimers();
    this.#messageEl = null;
    this.#detailsEl = null;
    this.#progressBarEl = null;
    this.#progressFillEl = null;
    this.#cancelButtonSetting = null;
    this.#cancelButtonEl = null;
    this.#terminalState = 'running';
  }

  public markCompleted(): void {
    const { t } = getI18n();
    this.#clearAutoCloseTimers();
    this.#terminalState = 'completed';
    this.contentEl.removeClass('proton-sync-progress--failed');
    this.contentEl.addClass('proton-sync-progress--completed');

    let secondsRemaining = 5;
    this.#render(t.modals.syncProgress.completedMessage, this.#toAutoCloseMessage(secondsRemaining), 100);

    this.#autoCloseIntervalId = window.setInterval(() => {
      secondsRemaining -= 1;
      if (secondsRemaining > 0) {
        this.#render(t.modals.syncProgress.completedMessage, this.#toAutoCloseMessage(secondsRemaining), 100);
      }
    }, 1000);

    this.#autoCloseTimeoutId = window.setTimeout(() => {
      this.#clearAutoCloseTimers();
      this.close();
    }, 5000);
  }

  public markFailed(message: string): void {
    const { t } = getI18n();
    this.#terminalState = 'failed';
    this.contentEl.removeClass('proton-sync-progress--completed');
    this.contentEl.addClass('proton-sync-progress--failed');

    this.#progressBarEl?.hide();
    this.#cancelButtonSetting?.settingEl.hide();
    this.#render(t.modals.syncProgress.failedMessage, message, null);
  }

  public markCancelled(): void {
    this.close();
  }

  #render(message: string, details: string, progressPercent: number | null): void {
    if (!this.#messageEl || !this.#detailsEl || !this.#progressBarEl || !this.#progressFillEl) {
      return;
    }

    this.#messageEl.setText(message);
    this.#detailsEl.setText(details);

    if (progressPercent === null) {
      this.#progressBarEl.removeClass('proton-sync-progress__bar--determinate');
      this.#progressBarEl.addClass('proton-sync-progress__bar--indeterminate');
      this.#progressBarEl.removeAttribute('aria-valuenow');
    } else {
      const clampedProgress = Math.max(0, Math.min(100, progressPercent));
      this.#progressBarEl.removeClass('proton-sync-progress__bar--indeterminate');
      this.#progressBarEl.addClass('proton-sync-progress__bar--determinate');
      this.#progressBarEl.setAttr('aria-valuenow', String(clampedProgress));
      this.#progressBarEl.style.setProperty('--proton-sync-progress-scale', String(clampedProgress / 100));
    }
  }

  #toAutoCloseMessage(secondsRemaining: number): string {
    const { t } = getI18n();
    return t.modals.syncProgress.autoCloseMessage(secondsRemaining);
  }

  #clearAutoCloseTimers(): void {
    if (this.#autoCloseIntervalId !== null) {
      window.clearInterval(this.#autoCloseIntervalId);
      this.#autoCloseIntervalId = null;
    }

    if (this.#autoCloseTimeoutId !== null) {
      window.clearTimeout(this.#autoCloseTimeoutId);
      this.#autoCloseTimeoutId = null;
    }
  }
}
