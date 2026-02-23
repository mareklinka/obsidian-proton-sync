import { Effect, Option } from 'effect';
import { App, Modal } from 'obsidian';
import { Observable, firstValueFrom, map, merge, take } from 'rxjs';

type PromptableModal<T> = Modal & {
  submitted$: Observable<T>;
  canceled$: Observable<void>;
};

export function promptFromModal<T>(
  app: App,
  createModal: (app: App) => PromptableModal<T>
): Effect.Effect<Option.Option<T>> {
  return Effect.promise(async () => {
    const modal = createModal(app);

    const submitted$ = modal.submitted$.pipe(
      take(1),
      map(value => ({ kind: 'submitted' as const, value }))
    );

    const canceled$ = modal.canceled$.pipe(
      take(1),
      map(() => ({ kind: 'canceled' as const }))
    );

    modal.open();

    const result = await firstValueFrom(merge(submitted$, canceled$));

    if (result.kind === 'submitted') {
      return Option.some(result.value);
    }

    return Option.none();
  });
}
