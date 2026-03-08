import type { App } from 'obsidian';
import { Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

import { getI18n } from '../../i18n';

export interface CaptchaVerification {
  token: string;
  verificationMethod: string;
}

interface CaptchaResultMessage {
  type: string;
  payload: {
    token: string;
    type: string;
  };
}

const EXPECTED_MESSAGE_TYPE = 'HUMAN_VERIFICATION_SUCCESS';

export class ProtonDriveCaptchaModal extends Modal {
  readonly #submittedSubject = new Subject<CaptchaVerification>();
  public readonly submitted$ = this.#submittedSubject.asObservable();

  readonly #canceledSubject = new Subject<void>();
  public readonly canceled$ = this.#canceledSubject.asObservable();

  #didResolve = false;
  #iframeEl: HTMLIFrameElement | null = null;

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

    contentEl.createEl('p', {
      cls: 'proton-sync-captcha-help',
      text: t.modals.captcha.help
    });

    const frameWrapper = contentEl.createEl('div', { cls: 'proton-sync-captcha-frame-wrapper' });
    this.#iframeEl = frameWrapper.createEl('iframe', {
      cls: 'proton-sync-captcha-frame',
      attr: {
        src: this.captchaUrl,
        title: t.modals.captcha.iframeTitle,
        sandbox: 'allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox',
        referrerpolicy: 'no-referrer'
      }
    });

    window.addEventListener('message', this.#onMessage, false);

    new Setting(contentEl)
      .addButton(button =>
        button.setButtonText(t.modals.captcha.reload).onClick(() => {
          this.#reloadIframe();
        })
      )
      .addExtraButton(button =>
        button
          .setIcon('cross')
          .setTooltip(t.common.cancel)
          .onClick(() => {
            this.#didResolve = true;
            this.#canceledSubject.next();
            this.close();
          })
      );
  }

  readonly #onMessage = (event: MessageEvent<string>): void => {
    const targetOrigin = new URL(this.captchaUrl).origin;
    const contentWindow = this.#iframeEl?.contentWindow;

    const { origin, data, source } = event;
    if (!contentWindow || origin !== targetOrigin || !data || source !== contentWindow) {
      return;
    }

    const deserialized = JSON.parse(data) as CaptchaResultMessage;

    if (deserialized.type !== EXPECTED_MESSAGE_TYPE) {
      return;
    }

    this.#submittedSubject.next({ token: deserialized.payload.token, verificationMethod: deserialized.payload.type });
    this.#didResolve = true;
    this.close();
  };

  public override onClose(): void {
    window.removeEventListener('message', this.#onMessage, false);
    if (!this.#didResolve) {
      this.#canceledSubject.next();
    }

    if (this.#iframeEl) {
      this.#iframeEl.src = 'about:blank';
      this.#iframeEl = null;
    }
  }

  #reloadIframe(): void {
    if (!this.#iframeEl) {
      return;
    }

    this.#iframeEl.src = this.captchaUrl;
  }
}
