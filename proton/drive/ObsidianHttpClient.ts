import type {
  ProtonDriveHTTPClient,
  ProtonDriveHTTPClientJsonRequest,
  ProtonDriveHTTPClientBlobRequest
} from '@protontech/drive-sdk';
import { requestUrl } from 'obsidian';
import { headersToObject } from './ProtonDriveClient';
import type { ProtonSession } from '../auth/ProtonSession';
import { ProtonSessionService } from '../auth/ProtonSessionService';
import { map } from 'rxjs';

export class ObsidianHttpClient implements ProtonDriveHTTPClient {
  private currentSession: ProtonSession | null = null;

  constructor(private readonly authService: ProtonSessionService) {
    authService.currentSession$.pipe(map(_ => (_.state === 'ok' ? _.session : null))).subscribe(session => {
      this.currentSession = session;
    });
  }

  async fetchJson(request: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
    return this.fetch(request, true);
  }

  async fetchBlob(request: ProtonDriveHTTPClientBlobRequest): Promise<Response> {
    return this.fetch(request, false);
  }

  private async fetch(
    request: ProtonDriveHTTPClientJsonRequest | ProtonDriveHTTPClientBlobRequest,
    isJson: boolean
  ): Promise<Response> {
    if (!this.currentSession) {
      throw new Error('No Proton session available for SDK requests.');
    }

    const headers = this.buildHeaders(request.headers, this.currentSession);
    const { body, contentType } = await this.prepareRequestBody(request);

    const response = await requestUrl({
      url: request.url,
      method: request.method,
      headers: headersToObject(headers),
      contentType: contentType,
      body: body,
      throw: false
    });

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

  private async prepareRequestBody(
    request: ProtonDriveHTTPClientJsonRequest | ProtonDriveHTTPClientBlobRequest
  ): Promise<{
    body: string | ArrayBuffer | undefined;
    contentType: string | undefined;
  }> {
    let body: string | ArrayBuffer | undefined;
    let contentType: string | undefined;

    if ('json' in request && request.json) {
      body = JSON.stringify(request.json);
      contentType = 'application/json';
    } else if ('body' in request && request.body) {
      if (request.body instanceof FormData && request.body.has('Block')) {
        const blockData = (request.body as unknown as FormData).get('Block') as Blob;

        if (!blockData) {
          throw new Error('Unexpected body type in request');
        }

        const { data, boundary } = await this.blobToMultipartArrayBuffer(blockData);
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

  private buildHeaders(baseHeaders: Headers, session: ProtonSession): Headers {
    const headers = new Headers(baseHeaders);

    headers.set('x-pm-uid', session.uid);
    headers.set('authorization', `Bearer ${session.accessToken}`);
    headers.set('x-pm-appversion', this.authService.appVersionHeader);

    return headers;
  }

  private async blobToMultipartArrayBuffer(data: Blob): Promise<{ data: ArrayBuffer; boundary: string }> {
    const N = 16;
    const randomBoundaryString =
      'obsdnsync-' +
      Array(N + 1)
        .join((Math.random().toString(36) + '00000000000000000').slice(2, 18))
        .slice(0, N);

    const pre_string = `------${randomBoundaryString}\r\nContent-Disposition: form-data; name="Block"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const post_string = `\r\n------${randomBoundaryString}--`;

    const pre_string_encoded = new TextEncoder().encode(pre_string);
    const post_string_encoded = new TextEncoder().encode(post_string);
    const dataBuffer = await data.arrayBuffer();
    const concatenated = await new Blob([pre_string_encoded, dataBuffer, post_string_encoded]).arrayBuffer();

    return { data: concatenated, boundary: `----${randomBoundaryString}` };
  }
}
