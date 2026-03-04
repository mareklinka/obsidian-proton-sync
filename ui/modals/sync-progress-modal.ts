import { Modal, Setting } from 'obsidian';
import { type Subscription } from 'rxjs';

import { getI18n } from '../../i18n';
import { getSyncService } from '../../services/SyncService';
import { toConfigSyncProgressViewState } from '../config-sync-progress-state';

import type { App } from 'obsidian';

export const { init: initSyncProgressModal, get: getSyncProgressModal } = (function () {
  let instance: SyncProgressModal | null = null;

  return {
    init: function initSyncProgressModal(app: App): SyncProgressModal {
      return (instance ??= new SyncProgressModal(app));
    },
    get: function getSyncProgressModal(): SyncProgressModal {
      if (!instance) {
        throw new Error('SyncProgressModal has not been initialized. Please call initSyncProgressModalApi first.');
      }
      return instance;
    }
  };
})();

class SyncProgressModal extends Modal {
  private stateSubscription: Subscription | null = null;
  private messageEl: HTMLElement | null = null;
  private detailsEl: HTMLElement | null = null;
  private progressBarEl: HTMLElement | null = null;
  private progressFillEl: HTMLElement | null = null;
  private autoCloseIntervalId: number | null = null;
  private autoCloseTimeoutId: number | null = null;

  private terminalState: 'running' | 'completed' | 'failed' = 'running';

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { t } = getI18n();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('proton-sync-config-progress');
    contentEl.removeClass('proton-sync-progress--failed');
    contentEl.removeClass('proton-sync-progress--completed');

    contentEl.createEl('h2', { text: t.modals.syncProgress.title });

    this.messageEl = contentEl.createEl('p', {
      cls: 'proton-sync-progress__message',
      text: t.modals.syncProgress.initialMessage
    });

    this.detailsEl = contentEl.createEl('p', {
      cls: 'proton-sync-progress__details',
      text: t.modals.syncProgress.initialDetails
    });

    this.progressBarEl = contentEl.createDiv({
      cls: 'proton-sync-progress__bar proton-sync-progress__bar--determinate'
    });
    this.progressBarEl.setAttr('role', 'progressbar');
    this.progressBarEl.setAttr('aria-valuemin', '0');
    this.progressBarEl.setAttr('aria-valuemax', '100');
    this.progressBarEl.setAttr('aria-valuenow', '0');
    this.progressBarEl.style.setProperty('--proton-sync-progress-scale', '0');

    this.progressFillEl = this.progressBarEl.createDiv({
      cls: 'proton-sync-progress__bar-fill'
    });

    const setting = new Setting(contentEl).setDesc(t.modals.syncProgress.closeHint);

    this.stateSubscription = getSyncService().state$.subscribe(state => {
      if (state.state === 'idle') {
        setting.descEl.hide();
        this.progressBarEl?.hide();
      } else {
        setting.descEl.show();
        this.progressBarEl?.show();
      }

      if (this.terminalState !== 'running') {
        return;
      }

      const viewState = toConfigSyncProgressViewState(state);
      this.render(viewState.message, viewState.details, viewState.progressPercent);
    });
  }

  onClose(): void {
    this.stateSubscription?.unsubscribe();
    this.stateSubscription = null;
    this.clearAutoCloseTimers();
    this.messageEl = null;
    this.detailsEl = null;
    this.progressBarEl = null;
    this.progressFillEl = null;
    this.terminalState = 'running';
  }

  markCompleted(): void {
    const { t } = getI18n();
    this.clearAutoCloseTimers();
    this.terminalState = 'completed';
    this.contentEl.removeClass('proton-sync-progress--failed');
    this.contentEl.addClass('proton-sync-progress--completed');

    let secondsRemaining = 5;
    this.render(t.modals.syncProgress.completedMessage, this.toAutoCloseMessage(secondsRemaining), 100);

    this.autoCloseIntervalId = window.setInterval(() => {
      secondsRemaining -= 1;
      if (secondsRemaining > 0) {
        this.render(t.modals.syncProgress.completedMessage, this.toAutoCloseMessage(secondsRemaining), 100);
      }
    }, 1000);

    this.autoCloseTimeoutId = window.setTimeout(() => {
      this.clearAutoCloseTimers();
      this.close();
    }, 5000);
  }

  markFailed(message: string): void {
    const { t } = getI18n();
    this.terminalState = 'failed';
    this.contentEl.removeClass('proton-sync-progress--completed');
    this.contentEl.addClass('proton-sync-progress--failed');

    this.progressBarEl?.hide();
    this.render(t.modals.syncProgress.failedMessage, message, null);
  }

  private render(message: string, details: string, progressPercent: number | null): void {
    if (!this.messageEl || !this.detailsEl || !this.progressBarEl || !this.progressFillEl) {
      return;
    }

    this.messageEl.setText(message);
    this.detailsEl.setText(details);

    if (progressPercent === null) {
      this.progressBarEl.removeClass('proton-sync-progress__bar--determinate');
      this.progressBarEl.addClass('proton-sync-progress__bar--indeterminate');
      this.progressBarEl.removeAttribute('aria-valuenow');
    } else {
      const clampedProgress = Math.max(0, Math.min(100, progressPercent));
      this.progressBarEl.removeClass('proton-sync-progress__bar--indeterminate');
      this.progressBarEl.addClass('proton-sync-progress__bar--determinate');
      this.progressBarEl.setAttr('aria-valuenow', String(clampedProgress));
      this.progressBarEl.style.setProperty('--proton-sync-progress-scale', String(clampedProgress / 100));
    }
  }

  private toAutoCloseMessage(secondsRemaining: number): string {
    const { t } = getI18n();
    return t.modals.syncProgress.autoCloseMessage(secondsRemaining);
  }

  private clearAutoCloseTimers(): void {
    if (this.autoCloseIntervalId !== null) {
      window.clearInterval(this.autoCloseIntervalId);
      this.autoCloseIntervalId = null;
    }

    if (this.autoCloseTimeoutId !== null) {
      window.clearTimeout(this.autoCloseTimeoutId);
      this.autoCloseTimeoutId = null;
    }
  }
}
