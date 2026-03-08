import type { App, ButtonComponent } from 'obsidian';
import { Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

import { getI18n } from '../../i18n';

export class ProtonDriveConfirmModal extends Modal {
  readonly #submittedSubject = new Subject<{ confirmed: boolean; toggleValue: boolean }>();
  public readonly submitted$ = this.#submittedSubject.asObservable();

  readonly #canceledSubject = new Subject<void>();
  public readonly canceled$ = this.#canceledSubject.asObservable();

  #didResolve = false;
  #toggleValue = false;

  public constructor(
    app: App,
    private readonly title: string,
    private readonly confirmLabel: string,
    private readonly toggleLabel: string,
    private readonly toggleDescription: string
  ) {
    super(app);
  }

  public override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: this.title });

    let setting: Setting | null = null;

    new Setting(contentEl)
      .setName(this.toggleLabel)
      .setDesc(this.toggleDescription)
      .addToggle(toggle => {
        toggle.setValue(this.#toggleValue).onChange(value => {
          if (setting) {
            setting.clear();
            this.#createButtons(setting, toggle.getValue());
          }
          this.#toggleValue = value;
        });
      });

    setting = new Setting(contentEl);
    this.#createButtons(setting, this.#toggleValue);
  }

  public override onClose(): void {
    if (!this.#didResolve) {
      this.#canceledSubject.next();
    }
  }

  #createButtons(setting: Setting, warn: boolean): void {
    const { t } = getI18n();
    const buttonFormat = warn
      ? (b: ButtonComponent): ButtonComponent => b.setWarning()
      : (b: ButtonComponent): ButtonComponent => b.setCta();

    setting
      .addButton(b => {
        b.setButtonText(this.confirmLabel).onClick(() => {
          this.#didResolve = true;
          this.#submittedSubject.next({ confirmed: true, toggleValue: this.#toggleValue });
          this.close();
        });
        buttonFormat(b);
      })
      .addExtraButton(button =>
        button
          .setIcon('cross')
          .setTooltip(t.modals.confirm.cancelTooltip)
          .onClick(() => {
            this.#didResolve = true;
            this.#canceledSubject.next();
            this.close();
          })
      );
  }
}
