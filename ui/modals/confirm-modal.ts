import { App, Modal, Setting } from 'obsidian';
import { Subject } from 'rxjs';

export class ProtonDriveConfirmModal extends Modal {
  private readonly submittedSubject = new Subject<boolean>();
  public readonly submitted$ = this.submittedSubject.asObservable();

  private readonly canceledSubject = new Subject<void>();
  public readonly canceled$ = this.canceledSubject.asObservable();

  private didResolve = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly confirmLabel: string
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: this.title });
    contentEl.createEl('p', { text: this.message });

    new Setting(contentEl)
      .addButton(button =>
        button
          .setButtonText(this.confirmLabel)
          .setWarning()
          .onClick(() => {
            this.didResolve = true;
            this.submittedSubject.next(true);
            this.close();
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

  onClose(): void {
    if (!this.didResolve) {
      this.canceledSubject.next();
    }
  }
}
