import type {
  ProtonDriveHTTPClient,
  ProtonDriveHTTPClientBlobRequest,
  ProtonDriveHTTPClientJsonRequest
} from '@protontech/drive-sdk';
import { Option } from 'effect';
import type { RequestUrlParam } from 'obsidian';
import { requestUrl } from 'obsidian';

import { getLogger } from '../../services/ConsoleLogger';
import type { ProtonSession } from '../auth/ProtonSession';
import { getProtonSessionService } from '../auth/ProtonSessionService';

export const { init: initProtonHttpClient, get: getProtonHttpClient } = (function () {
  let instance: ObsidianHttpClient | null = null;

  return {
    init: function (this: void): ObsidianHttpClient {
      return (instance ??= new ObsidianHttpClient());
    },
    get: function (this: void): ObsidianHttpClient {
      if (!instance) {
        throw new Error('ObsidianHttpClient has not been initialized. Please call initProtonHttpClient first.');
      }
      return instance;
    }
  };
})();

export class ObsidianHttpClient implements ProtonDriveHTTPClient {
  readonly #sessionService = getProtonSessionService();

  public async fetchJson(request: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
    return this.#fetch(request, true);
  }

  public async fetchBlob(request: ProtonDriveHTTPClientBlobRequest): Promise<Response> {
    return this.#fetch(request, false);
  }

  async #fetch(
    request: ProtonDriveHTTPClientJsonRequest | ProtonDriveHTTPClientBlobRequest,
    isJson: boolean
  ): Promise<Response> {
    const currentSession = this.#sessionService.getCurrentSession();
    if (Option.isNone(currentSession)) {
      throw new Error('No Proton session available for SDK requests.');
    }

    const headers = this.#buildHeaders(request.headers, currentSession.value);
    const { body, contentType } = await this.#prepareRequestBody(request);
    const h = this.#headersToObject(headers);

    const r: RequestUrlParam = {
      url: request.url,
      method: request.method,
      headers: h,
      contentType: contentType,
      body: body,
      throw: false
    };

    if (request.method === 'POST') {
      getLogger('ObsidianHttpClient').debug('Making POST request', request, h);
    }

    const response = await requestUrl(r);

    if (isJson) {
      return new Response(response.text, {
        status: response.status,
        headers: response.headers
      });
    } else {
      return new Response(response.arrayBuffer, {
        status: response.status,
        headers: response.headers
      });
    }
  }

  async #prepareRequestBody(request: ProtonDriveHTTPClientJsonRequest | ProtonDriveHTTPClientBlobRequest): Promise<{
    body: string | ArrayBuffer | undefined;
    contentType: string | undefined;
  }> {
    let body: string | ArrayBuffer | undefined;
    let contentType: string | undefined;

    if ('json' in request && request.json) {
      body = JSON.stringify(request.json);
      contentType = 'application/json';
    } else if ('body' in request && request.body !== undefined && request.body !== null) {
      if (request.body instanceof FormData && request.body.has('Block')) {
        const blockData = (request.body as unknown as FormData).get('Block') as Blob;

        const { data, boundary } = await this.#blobToMultipartArrayBuffer(blockData);
        body = data;

        contentType = `multipart/form-data; boundary=${boundary}`;
      } else {
        throw new Error('Unexpected body type in blob request');
      }
    } else {
      body = undefined;
      contentType = undefined;
    }

    return { body, contentType };
  }

  #buildHeaders(baseHeaders: Headers, session: ProtonSession): Headers {
    const headers = new Headers(baseHeaders);

    headers.set('x-pm-uid', session.uid);
    headers.set('authorization', `Bearer ${session.accessToken}`);
    headers.set('x-pm-appversion', this.#sessionService.appVersionHeader);

    return headers;
  }

  async #blobToMultipartArrayBuffer(data: Blob): Promise<{ data: ArrayBuffer; boundary: string }> {
    const N = 16;
    const randomBoundaryString =
      'obsdnsync-' +
      Array(N + 1)
        .join((Math.random().toString(36) + '00000000000000000').slice(2, 18))
        .slice(0, N);

    // eslint-disable-next-line max-len
    const pre_string = `------${randomBoundaryString}\r\nContent-Disposition: form-data; name="Block"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const post_string = `\r\n------${randomBoundaryString}--`;

    const pre_string_encoded = new TextEncoder().encode(pre_string);
    const post_string_encoded = new TextEncoder().encode(post_string);
    const dataBuffer = await data.arrayBuffer();
    const concatenated = await new Blob([pre_string_encoded, dataBuffer, post_string_encoded]).arrayBuffer();

    return { data: concatenated, boundary: `----${randomBoundaryString}` };
  }

  #headersToObject(headers: Headers): Record<string, string> {
    const output: Record<string, string> = {};
    headers.forEach((value, key) => {
      output[key] = value;
    });
    return output;
  }
}
