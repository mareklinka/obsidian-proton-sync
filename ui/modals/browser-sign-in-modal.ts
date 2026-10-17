import type { App } from 'obsidian';
import { Modal, Setting } from 'obsidian';

import { getI18n } from '../../i18n';

export class ProtonBrowserSignInModal extends Modal {
  #finished = false;
  #opened = false;

  public constructor(
    app: App,
    private readonly controller: AbortController
  ) {
    super(app);
  }

  public override onOpen(): void {
    const { t } = getI18n();
    this.#opened = true;
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: t.modals.browserSignIn.title });
    this.contentEl.createEl('p', { text: t.modals.browserSignIn.preparing });
    this.#addCancel();
  }

  public showSignInUrl(url: string): void {
    if (!this.#opened || this.controller.signal.aborted) {
      return;
    }
    const target = new URL(url);
    if (target.origin !== 'https://account.proton.me' || target.pathname !== '/desktop/login') {
      this.controller.abort();
      return;
    }
    const { t } = getI18n();
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: t.modals.browserSignIn.title });
    this.contentEl.createEl('p', { text: t.modals.browserSignIn.help });
    this.contentEl.createEl('a', {
      text: t.modals.browserSignIn.openBrowser,
      cls: 'external-link',
      attr: { href: url, target: '_blank', rel: 'noopener noreferrer' }
    });
    this.contentEl.createEl('p', { text: t.modals.browserSignIn.waiting });
    this.#addCancel();
  }

  public finish(): void {
    this.#finished = true;
    this.close();
  }

  public override onClose(): void {
    this.#opened = false;
    if (!this.#finished) {
      this.controller.abort();
    }
    this.contentEl.empty();
  }

  #addCancel(): void {
    new Setting(this.contentEl).addButton(button =>
      button.setButtonText(getI18n().t.common.cancel).onClick(() => this.close())
    );
  }
}
