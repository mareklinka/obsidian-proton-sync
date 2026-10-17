import type { App } from 'obsidian';
import { Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

import { getI18n } from '../../i18n';
import { getExternalCaptchaUrl } from '../../proton/auth/CaptchaChallenge';

export interface CaptchaVerification {
  token: string;
  verificationMethod: string;
}

export class ProtonDriveCaptchaModal extends Modal {
  readonly #submittedSubject = new Subject<CaptchaVerification>();
  public readonly submitted$ = this.#submittedSubject.asObservable();

  readonly #canceledSubject = new Subject<void>();
  public readonly canceled$ = this.#canceledSubject.asObservable();

  #didResolve = false;

  public constructor(
    app: App,
    private readonly captchaUrl: string
  ) {
    super(app);
  }

  public override onOpen(): void {
    const { t } = getI18n();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: t.modals.captcha.title });

    const externalUrl = getExternalCaptchaUrl(this.captchaUrl);
    if (!externalUrl) {
      contentEl.createEl('p', { text: t.modals.captcha.invalidUrl });
      new Setting(contentEl).addButton(button => button.setButtonText(t.common.cancel).onClick(() => this.close()));
      return;
    }

    contentEl.createEl('p', { text: t.modals.captcha.help });

    // A normal Obsidian external link opens the user's browser. No credentials,
    // session tokens, local server, script injection, or iframe policy bypass.
    const link = contentEl.createEl('a', {
      text: t.modals.captcha.openBrowser,
      cls: 'external-link',
      attr: { href: externalUrl.toString(), target: '_blank', rel: 'noopener noreferrer' }
    });

    new Setting(contentEl)
      .addButton(button => {
        button
          .setButtonText(t.modals.captcha.continueButton)
          .setCta()
          .setDisabled(true)
          .onClick(() => {
            if (this.#didResolve) {
              return;
            }
            this.#didResolve = true;
            // The browser posts its solution to Proton's external-verification API.
            // Returning the original challenge lets Proton redeem that proof on the
            // single login retry. Clicking Continue alone never verifies a human.
            this.#submittedSubject.next({
              token: externalUrl.searchParams.get('token') ?? '',
              verificationMethod: 'captcha'
            });
            this.close();
          });
        link.addEventListener('click', () => button.setDisabled(false));
      })
      .addButton(button => button.setButtonText(t.common.cancel).onClick(() => this.close()));
  }

  public override onClose(): void {
    if (!this.#didResolve) {
      this.#didResolve = true;
      this.#canceledSubject.next();
    }
    this.contentEl.empty();
  }
}
