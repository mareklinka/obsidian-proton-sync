import { BehaviorSubject, type Observable } from 'rxjs';

export type ReconcileState = 'idle' | 'reconciling' | 'error';

export class CloudReconciliationQueue {
  private readonly stateSubject = new BehaviorSubject<ReconcileState>('idle');
  private inProgress = false;
  private queued = false;

  public readonly state$: Observable<ReconcileState> = this.stateSubject.asObservable();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.stateSubject.next('reconciling');

    try {
      const result = await operation();
      this.stateSubject.next('idle');
      return result;
    } catch (error) {
      this.stateSubject.next('error');
      throw error;
    }
  }

  async enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.inProgress) {
      this.queued = true;
      return;
    }

    this.inProgress = true;

    try {
      do {
        this.queued = false;
        await this.run(operation);
      } while (this.queued);
    } finally {
      this.inProgress = false;
    }
  }

  reset(): void {
    this.stateSubject.next('idle');
  }

  dispose(): void {
    this.stateSubject.complete();
  }
}
