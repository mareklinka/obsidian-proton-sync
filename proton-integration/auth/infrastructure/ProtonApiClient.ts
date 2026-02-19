import { requestUrl } from 'obsidian';

import type { ProtonSession } from '../../../session-store';
import type { ProtonLogger } from '../../domain/contracts';

type SessionProvider = () => ProtonSession | null;

type ProtonApiRequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
};

export class ProtonApiClient {
  private readonly appVersionHeader: string;

  constructor(
    private readonly getSession: SessionProvider,
    appVersion: string,
    private readonly baseUrl: string = 'https://mail.proton.me/api',
    private readonly logger?: ProtonLogger
  ) {
    this.appVersionHeader = `external-drive-obsidiansync@${appVersion}`;
  }

  async getJson<T>(path: string, query?: ProtonApiRequestOptions['query']): Promise<T> {
    return this.requestJson<T>(path, { method: 'GET', query });
  }

  async postJson<T>(path: string, body?: ProtonApiRequestOptions['body']): Promise<T> {
    return this.requestJson<T>(path, { method: 'POST', body });
  }

  async requestJson<T>(path: string, options: ProtonApiRequestOptions): Promise<T> {
    const session = this.getSession();
    if (!session) {
      throw new Error('No Proton session available for API request.');
    }

    const url = this.buildUrl(path, options.query);

    this.logger?.debug('API: request', { method: options.method ?? 'POST', path });

    const response = await requestUrl({
      url,
      method: options.method ?? 'POST',
      contentType: options.body ? 'application/json' : undefined,
      headers: {
        'x-pm-uid': session.uid,
        authorization: `Bearer ${session.accessToken}`,
        'x-pm-appversion': this.appVersionHeader,
        ...(options.headers ?? {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      throw: false
    });

    this.logger?.debug('API: response received', { body: response.text, status: response.status, path });

    if (response.status >= 400) {
      throw new Error(extractApiError(response.json) ?? `Proton API request failed (${response.status}).`);
    }

    return response.json as T;
  }

  private buildUrl(path: string, query?: ProtonApiRequestOptions['query']): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);

    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value === undefined) {
          return;
        }
        url.searchParams.set(key, String(value));
      });
    }

    return url.toString();
  }
}

function extractApiError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as { Error?: string; Message?: string };
  return record.Error ?? record.Message ?? null;
}
