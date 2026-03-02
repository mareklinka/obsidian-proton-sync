import { App, Modal, Setting } from 'obsidian';
import { type Observable, type Subscription } from 'rxjs';

import type { ConfigSyncState } from '../../services/vNext/ConfigSyncService';
import { toConfigSyncProgressViewState } from '../config-sync-progress-state';

export class ProtonDriveConfigSyncProgressModal extends Modal {
  private stateSubscription: Subscription | null = null;
  private messageEl: HTMLElement | null = null;
  private detailsEl: HTMLElement | null = null;
  private progressEl: HTMLProgressElement | null = null;

  private terminalState: 'running' | 'completed' | 'failed' = 'running';

  constructor(
    app: App,
    private readonly configSyncState$: Observable<ConfigSyncState>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('proton-sync-config-progress');

    contentEl.createEl('h2', { text: 'Pushing vault configuration to Proton Drive' });

    this.messageEl = contentEl.createEl('p', {
      cls: 'proton-sync-config-progress__message',
      text: 'Preparing configuration push…'
    });

    this.detailsEl = contentEl.createEl('p', {
      cls: 'proton-sync-config-progress__details',
      text: 'Waiting for progress updates.'
    });

    this.progressEl = contentEl.createEl('progress', {
      cls: 'proton-sync-config-progress__bar'
    });
    this.progressEl.max = 100;
    this.progressEl.value = 0;

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
    this.messageEl = null;
    this.detailsEl = null;
    this.progressEl = null;
  }

  markCompleted(): void {
    this.terminalState = 'completed';
    this.contentEl.removeClass('proton-sync-config-progress--failed');
    this.contentEl.addClass('proton-sync-config-progress--completed');

    this.render('Configuration push complete.', 'All detected changes have been pushed to Proton Drive.', 100);
  }

  markFailed(message: string): void {
    this.terminalState = 'failed';
    this.contentEl.removeClass('proton-sync-config-progress--completed');
    this.contentEl.addClass('proton-sync-config-progress--failed');

    this.render('Configuration push failed.', message, this.progressEl?.value ?? 0);
  }

  private render(message: string, details: string, progressPercent: number | null): void {
    if (!this.messageEl || !this.detailsEl || !this.progressEl) {
      return;
    }

    this.messageEl.setText(message);
    this.detailsEl.setText(details);

    if (progressPercent === null) {
      this.progressEl.removeAttribute('value');
      return;
    }

    this.progressEl.value = progressPercent;
  }
}
