export async function requestUrl(_request: unknown): Promise<unknown> {
  throw new Error('requestUrl is not implemented in unit tests.');
}

export class App {}
export class Plugin {}
export class Modal {}
export class Notice {
  constructor(_message: string) {}
}
export class PluginSettingTab {}
export class Setting {}
export class TFolder {}

export function normalizePath(path: string): string {
  return path
    .replace(/\\+/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
}
