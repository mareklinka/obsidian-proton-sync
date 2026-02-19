export async function requestUrl(_request: unknown): Promise<any> {
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
