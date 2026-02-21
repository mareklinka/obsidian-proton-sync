import { App, Modal, Setting } from 'obsidian';

import { Subject } from 'rxjs';

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
  private readonly submittedSubject = new Subject<CaptchaVerification>();
  public readonly submitted$ = this.submittedSubject.asObservable();

  private readonly canceledSubject = new Subject<void>();
  public readonly canceled$ = this.canceledSubject.asObservable();

  private didResolve = false;
  private iframeEl: HTMLIFrameElement | null = null;

  constructor(
    app: App,
    private readonly captchaUrl: string
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.empty();

    contentEl.createEl('h2', { text: 'CAPTCHA verification required' });

    contentEl.createEl('p', {
      cls: 'proton-sync-captcha-help',
      text: 'Solve the CAPTCHA challenge. The dialog will close automatically once the challenge is successfully completed.'
    });

    const frameWrapper = contentEl.createEl('div', { cls: 'proton-sync-captcha-frame-wrapper' });
    this.iframeEl = frameWrapper.createEl('iframe', {
      cls: 'proton-sync-captcha-frame',
      attr: {
        src: this.captchaUrl,
        title: 'Proton CAPTCHA challenge',
        sandbox: 'allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox',
        referrerpolicy: 'no-referrer'
      }
    });

    window.addEventListener('message', this.onMessage, false);

    new Setting(contentEl)
      .addButton(button =>
        button.setButtonText('Reload CAPTCHA').onClick(() => {
          this.reloadIframe();
        })
      )
      .addExtraButton(button =>
        button
          .setIcon('cross')
          .setTooltip('Cancel')
          .onClick(() => {
            this.didResolve = true;
            this.canceledSubject.next();
            this.close();
          })
      );
  }

  private onMessage = (event: MessageEvent<string>): void => {
    const targetOrigin = new URL(this.captchaUrl).origin;
    const contentWindow = this.iframeEl?.contentWindow;

    const { origin, data, source } = event;
    if (!contentWindow || origin !== targetOrigin || !data || source !== contentWindow) {
      return;
    }

    const deserialized = JSON.parse(data) as CaptchaResultMessage;

    if (deserialized.type !== EXPECTED_MESSAGE_TYPE) {
      return;
    }

    this.submittedSubject.next({ token: deserialized.payload.token, verificationMethod: deserialized.payload.type });
    this.didResolve = true;
    this.close();
  };

  onClose(): void {
    window.removeEventListener('message', this.onMessage, false);
    if (!this.didResolve) {
      this.canceledSubject.next();
    }

    if (this.iframeEl) {
      this.iframeEl.src = 'about:blank';
      this.iframeEl = null;
    }
  }

  private reloadIframe(): void {
    if (!this.iframeEl) {
      return;
    }

    this.iframeEl.src = this.captchaUrl;
  }
}
