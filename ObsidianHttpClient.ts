import type {
  ProtonDriveHTTPClient,
  ProtonDriveHTTPClientJsonRequest,
  ProtonDriveHTTPClientBlobRequest
} from '@protontech/drive-sdk';
import { requestUrl } from 'obsidian';
import type { PluginLogger } from './logger';
import { SessionProvider, headersToObject } from './proton-drive-client';
import type { ProtonSession } from './session-store';

export class ObsidianHttpClient implements ProtonDriveHTTPClient {
  private readonly appVersionHeader: string;

  constructor(
    private readonly getSession: SessionProvider,
    appVersion: string,
    private readonly logger?: PluginLogger
  ) {
    this.appVersionHeader = `external-drive-obsidiansync@${appVersion}`;
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
    this.logger?.debug('SDK: preparing request', { request });

    const session = this.getSession();
    if (!session) {
      throw new Error('No Proton session available for SDK requests.');
    }

    const headers = this.buildHeaders(request.headers, session);
    const { body, contentType } = await this.prepareRequestBody(request);

    const response = await requestUrl({
      url: request.url,
      method: request.method,
      headers: headersToObject(headers),
      contentType: contentType,
      body: body,
      throw: false
    });

    this.logger?.debug('SDK: response received', {
      response
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
    } else if ('body' in request) {
      if (request.body instanceof FormData && request.body.has('Block')) {
        // file upload
        const blockData = (request.body as unknown as FormData).get('Block') as Blob;

        if (!blockData) {
          this.logger?.error("SDK: unexpected body type in request - does not contain 'Block' item", { request });
          throw new Error('Unexpected body type in request');
        }

        const { data, boundary } = await this.blobToMultipartArrayBuffer(blockData);
        body = data;

        contentType = `multipart/form-data; boundary=${boundary}`;
      } else {
        this.logger?.error('SDK: unexpected body type in blob request');

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
    headers.set('x-pm-appversion', this.appVersionHeader);

    return headers;
  }

  // todo: replace with https://github.com/strikeentco/multi-part-lite to be more robust and support any FormData
  private async blobToMultipartArrayBuffer(data: Blob): Promise<{ data: ArrayBuffer; boundary: string }> {
    // Obsidian's requestUrl does not support multipart form data directly, so we need to construct the multipart payload ourselves.
    // To do this, we generate a random boundary string, and then concatenate the necessary multipart headers, the file data, and the closing boundary into a single ArrayBuffer that can be sent as the request body.
    const N = 16; // length of the random part of the boundary string
    const randomBoundaryString =
      'obsdnsync-' +
      Array(N + 1)
        .join((Math.random().toString(36) + '00000000000000000').slice(2, 18))
        .slice(0, N);

    // Construct the form data payload as a string
    const pre_string = `------${randomBoundaryString}\r\nContent-Disposition: form-data; name="Block"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const post_string = `\r\n------${randomBoundaryString}--`;

    // Convert the form data payload to a blob by concatenating the pre_string, the file data, and the post_string, and then return the blob as an array buffer
    const pre_string_encoded = new TextEncoder().encode(pre_string);
    const post_string_encoded = new TextEncoder().encode(post_string);
    const dataBuffer = await data.arrayBuffer();
    const concatenated = await new Blob([pre_string_encoded, dataBuffer, post_string_encoded]).arrayBuffer();

    return { data: concatenated, boundary: `----${randomBoundaryString}` };
  }
}
