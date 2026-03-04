import { Modal, Setting } from 'obsidian';
import { type Observable, type Subscription } from 'rxjs';

import { toConfigSyncProgressViewState } from '../config-sync-progress-state';

import type { SyncState } from '../../services/SyncService';
import type { App } from 'obsidian';

export class ProtonDriveSyncProgressModal extends Modal {
  private stateSubscription: Subscription | null = null;
  private messageEl: HTMLElement | null = null;
  private detailsEl: HTMLElement | null = null;
  private progressBarEl: HTMLElement | null = null;
  private progressFillEl: HTMLElement | null = null;
  private autoCloseIntervalId: number | null = null;
  private autoCloseTimeoutId: number | null = null;
  private lastProgressPercent = 0;

  private terminalState: 'running' | 'completed' | 'failed' = 'running';

  constructor(
    app: App,
    private readonly configSyncState$: Observable<SyncState>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('proton-sync-config-progress');

    contentEl.createEl('h2', { text: 'Proton Drive Sync' });

    this.messageEl = contentEl.createEl('p', {
      cls: 'proton-sync-progress__message',
      text: 'Preparing configuration push…'
    });

    this.detailsEl = contentEl.createEl('p', {
      cls: 'proton-sync-progress__details',
      text: 'Waiting for progress updates.'
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

    new Setting(contentEl).setDesc('You can close this dialog at any time. The sync will continue in the background.');

    this.stateSubscription = this.configSyncState$.subscribe(state => {
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
  }

  markCompleted(): void {
    this.clearAutoCloseTimers();
    this.terminalState = 'completed';
    this.contentEl.removeClass('proton-sync-progress--failed');
    this.contentEl.addClass('proton-sync-progress--completed');

    let secondsRemaining = 5;
    this.render('Operation complete.', this.toAutoCloseMessage(secondsRemaining), 100);

    this.autoCloseIntervalId = window.setInterval(() => {
      secondsRemaining -= 1;
      if (secondsRemaining > 0) {
        this.render('Operation complete.', this.toAutoCloseMessage(secondsRemaining), 100);
      }
    }, 1000);

    this.autoCloseTimeoutId = window.setTimeout(() => {
      this.clearAutoCloseTimers();
      this.close();
    }, 5000);
  }

  markFailed(message: string): void {
    this.terminalState = 'failed';
    this.contentEl.removeClass('proton-sync-progress--completed');
    this.contentEl.addClass('proton-sync-progress--failed');

    this.progressBarEl?.hide();
    this.render('Operation failed.', message, null);
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
      this.lastProgressPercent = clampedProgress;

      this.progressBarEl.removeClass('proton-sync-progress__bar--indeterminate');
      this.progressBarEl.addClass('proton-sync-progress__bar--determinate');
      this.progressBarEl.setAttr('aria-valuenow', String(clampedProgress));
      this.progressBarEl.style.setProperty('--proton-sync-progress-scale', String(clampedProgress / 100));
    }
  }

  private toAutoCloseMessage(secondsRemaining: number): string {
    const unit = secondsRemaining === 1 ? 'second' : 'seconds';
    return `All changes have been processed. This dialog will close in ${secondsRemaining} ${unit}.`;
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
