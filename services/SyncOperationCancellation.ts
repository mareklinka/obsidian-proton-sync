let activeController: AbortController | null = null;

export function beginSyncOperationCancellation(): AbortController {
  if (activeController && !activeController.signal.aborted) {
    return activeController;
  }

  activeController = new AbortController();
  return activeController;
}

export function cancelSyncOperationCancellation(reason: unknown = 'User cancelled sync operation.'): boolean {
  if (!activeController || activeController.signal.aborted) {
    return false;
  }

  activeController.abort(reason);
  return true;
}

export function clearSyncOperationCancellation(controller?: AbortController): void {
  if (!activeController) {
    return;
  }

  if (controller && activeController !== controller) {
    return;
  }

  activeController = null;
}
