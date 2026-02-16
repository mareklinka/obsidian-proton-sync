import type { ProtonDriveHTTPClient, ProtonDriveHTTPClientJsonRequest, ProtonDriveHTTPClientBlobRequest } from "@protontech/drive-sdk";
import { requestUrl } from "obsidian";
import type { PluginLogger } from "./logger";
import { SessionProvider, headersToObject } from "./proton-drive-client";
import type { ProtonSession } from "./session-store";

export class ObsidianHttpClient implements ProtonDriveHTTPClient {
  private readonly appVersionHeader: string;

  constructor(
    private readonly getSession: SessionProvider,
    appVersion: string,
    private readonly logger?: PluginLogger
  ) {
    this.appVersionHeader = `external-drive-obsidiansync@${appVersion}`;
  }

  async fetchJson(
    request: ProtonDriveHTTPClientJsonRequest
  ): Promise<Response> {
    return this.fetch(request, true);
  }

  async fetchBlob(
    request: ProtonDriveHTTPClientBlobRequest
  ): Promise<Response> {
    return this.fetch(request, false);
  }

  private async fetch(
    request: ProtonDriveHTTPClientJsonRequest |
      ProtonDriveHTTPClientBlobRequest,
    isJson: boolean
  ): Promise<Response> {
    this.logger?.debug("SDK: preparing request", { request });
    const session = this.getSession();
    if (!session) {
      throw new Error("No Proton session available for SDK requests.");
    }

    const headers = this.buildHeaders(request.headers, session);
    let body: XMLHttpRequestBodyInit | undefined;

    if ("json" in request && request.json) {
      body = JSON.stringify(request.json);
    } else if ("body" in request) {
      body = request.body;
    }

    const resolvedBody = await this.normalizeBody(body);

    const response = await requestUrl({
      url: request.url,
      method: request.method,
      headers: headersToObject(headers),
      contentType: isJson ? "application/json" : undefined,
      body: resolvedBody
    });

    this.logger?.debug("SDK: response received", {
      response,
    });

    if (isJson) {
      return new Response(response.text, {
        status: response.status,
        headers: response.headers,
      });
    }

    return new Response(response.arrayBuffer, {
      status: response.status,
      headers: response.headers,
    });
  }

  private buildHeaders(baseHeaders: Headers, session: ProtonSession): Headers {
    const headers = new Headers(baseHeaders);

    headers.set("x-pm-uid", session.uid);
    headers.set("authorization", `Bearer ${session.accessToken}`);
    headers.set("x-pm-appversion", this.appVersionHeader);

    return headers;
  }

  private async normalizeBody(
    body: XMLHttpRequestBodyInit | undefined
  ): Promise<string | ArrayBuffer | undefined> {
    if (!body) {
      return undefined;
    }

    if (typeof body === "string") {
      return body;
    }

    if (body instanceof ArrayBuffer) {
      return body;
    }

    if (ArrayBuffer.isView(body)) {
      return body.buffer;
    }

    if (body instanceof URLSearchParams) {
      return body.toString();
    }

    if (body instanceof Blob) {
      return body.arrayBuffer();
    }

    if (body instanceof Object) {
      return JSON.stringify(body);
    }

    this.logger?.warn("SDK: unsupported request body type", {
      type: typeof body,
      body: body,
    });

    throw new Error("Unsupported request body type for Obsidian requestUrl.");
  }
}
