import { requestUrl } from 'obsidian';
import { APP_ID, PROTON_BASE_URL as PROTON_BASE_URL } from './Constants';

type ProtonApiRequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
};

export async function getJson<T>(
  path: string,
  session: { uid: string; accessToken: string },
  appVersion: string,
  query?: ProtonApiRequestOptions['query']
): Promise<T> {
  return getProtonApiJson<T>(path, { method: 'GET', query }, session, appVersion);
}

export async function postJson<T>(
  path: string,
  session: { uid: string; accessToken: string },
  appVersion: string,
  body?: ProtonApiRequestOptions['body']
): Promise<T> {
  return getProtonApiJson<T>(path, { method: 'POST', body }, session, appVersion);
}

async function getProtonApiJson<T>(
  path: string,
  options: ProtonApiRequestOptions,
  session: { uid: string; accessToken: string },
  appVersion: string
): Promise<T> {
  const url = buildUrl(path, options.query);

  const response = await requestUrl({
    url,
    method: options.method ?? 'POST',
    contentType: options.body ? 'application/json' : undefined,
    headers: {
      'x-pm-uid': session.uid,
      authorization: `Bearer ${session.accessToken}`,
      'x-pm-appversion': appVersion,
      ...(options.headers ?? {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    throw: false
  });

  if (response.status >= 400) {
    throw new Error(extractApiError(response.json) ?? `Proton API request failed (${response.status}).`);
  }

  return response.json as T;
}

function extractApiError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as { Error?: string; Message?: string };
  return record.Error ?? record.Message ?? null;
}

function buildUrl(path: string, query?: ProtonApiRequestOptions['query']): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${PROTON_BASE_URL}${normalizedPath}`);

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
