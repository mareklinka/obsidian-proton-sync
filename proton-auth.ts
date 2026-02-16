
import { requestUrl } from 'obsidian';

import type { ProtonSession } from './session-store';
import { buildSrpProofs, decodeBase64, encodeBase64, ProtonAuthInfo } from './proton-srp';
import type { PluginLogger } from './logger';

const API_BASE_URL = 'https://mail.proton.me/api';
const DEFAULT_SESSION_TTL_MS = 50 * 60 * 1000;
const AUTH_SCOPE = 'full locked';

export interface ProtonAuthResponse {
  UserID: string;
  UID: string;
  AccessToken: string;
  RefreshToken: string;
  ServerProof: string;
  Scope: string;
  TwoFA?: {
    Enabled: number;
  };
  PasswordMode?: number;
}

export interface ProtonAuthResult {
  session: ProtonSession;
  passwordMode: number | null;
}

export class ProtonAuthService {
  private readonly appVersionHeader: string;
  private readonly logger: PluginLogger;

  constructor(private readonly appVersion: string, logger: PluginLogger) {
    this.appVersionHeader = `external-drive-obsidiansync@${appVersion}`;
    this.logger = logger;
  }

  async signIn(email: string, password: string, twoFactorCode: string): Promise<ProtonAuthResult> {
    const authInfo = await this.fetchAuthInfo(email);
    const proofs = await buildSrpProofs(authInfo, email, password);

    const authResponse = await this.authenticate(authInfo, email, proofs);

    if (!this.verifyServerProof(authResponse.ServerProof, proofs.expectedServerProof)) {
      throw new Error('SRP server proof mismatch.');
    }

    if (authResponse.TwoFA?.Enabled && (authResponse.TwoFA.Enabled & 1) !== 0) {
      if (!twoFactorCode) {
        throw new Error('Two-factor authentication code required.');
      }
      this.logger.info('Auth: submitting 2FA');
      await this.submitTwoFactor(twoFactorCode);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + DEFAULT_SESSION_TTL_MS);

    return {
      session: {
        uid: authResponse.UID,
        userId: authResponse.UserID || null,
        accessToken: authResponse.AccessToken,
        refreshToken: authResponse.RefreshToken,
        scope: authResponse.Scope || null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        lastRefreshAt: now.toISOString()
      },
      passwordMode: authResponse.PasswordMode ?? null
    };
  }

  async refreshSession(session: ProtonSession): Promise<ProtonSession> {
    const state = encodeBase64(randomToken(32));
    const body = {
      UID: session.uid,
      RefreshToken: session.refreshToken,
      ResponseType: 'token',
      GrantType: 'refresh_token',
      RedirectURI: 'https://protonmail.ch',
      State: state,
      AccessToken: session.accessToken,
      Scope: session.scope ?? AUTH_SCOPE
    };

    const response = await this.request<ProtonAuthResponse>('/auth/v4/refresh', body, {
      'x-pm-uid': session.uid,
      authorization: `Bearer ${session.accessToken}`
    });

    const refreshedAt = new Date();
    const refreshedExpiresAt = new Date(refreshedAt.getTime() + DEFAULT_SESSION_TTL_MS);

    return {
      ...session,
      uid: response.UID || session.uid,
      accessToken: response.AccessToken,
      refreshToken: response.RefreshToken,
      scope: response.Scope || session.scope,
      updatedAt: refreshedAt.toISOString(),
      expiresAt: refreshedExpiresAt.toISOString(),
      lastRefreshAt: refreshedAt.toISOString()
    };
  }

  private async fetchAuthInfo(username: string): Promise<ProtonAuthInfo> {
    const response = await this.request<{ AuthInfo?: ProtonAuthInfo } | ProtonAuthInfo>('/auth/v4/info', {
      Username: username
    });

    if ('AuthInfo' in response && response.AuthInfo) {
      return response.AuthInfo;
    }

    return response as ProtonAuthInfo;
  }

  private async authenticate(
    authInfo: ProtonAuthInfo,
    username: string,
    proofs: { clientProof: Uint8Array; clientEphemeral: Uint8Array }
  ): Promise<ProtonAuthResponse> {
    return this.request<ProtonAuthResponse>('/auth/v4', {
      Username: username,
      ClientProof: encodeBase64(proofs.clientProof),
      ClientEphemeral: encodeBase64(proofs.clientEphemeral),
      SRPSession: authInfo.SRPSession,
      Scope: AUTH_SCOPE
    });
  }

  private async submitTwoFactor(twoFactorCode: string): Promise<void> {
    await this.request<void>('/auth/v4/2fa', {
      TwoFactorCode: twoFactorCode
    });
  }

  private verifyServerProof(serverProof: string, expected: Uint8Array): boolean {
    const decoded = decodeBase64(serverProof);
    if (decoded.length !== expected.length) {
      return false;
    }

    for (let index = 0; index < decoded.length; index += 1) {
      if (decoded[index] !== expected[index]) {
        return false;
      }
    }

    return true;
  }

  private async request<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
    const response = await requestUrl({
      url: `${API_BASE_URL}${path}`,
      method: 'POST',
      contentType: 'application/json',
      headers: {
        'x-pm-appversion': this.appVersionHeader,
        ...(headers ?? {})
      },
      body: JSON.stringify(body),
      throw: false
    });

    if (response.status >= 400) {
      const message = extractApiError(response.json) ?? `Auth request failed (${response.status}).`;
      this.logger.warn('Auth: request failed', { path, status: response.status, message }, response.json);
      throw new Error(message);
    }

    return response.json as T;
  }
}

function extractApiError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as { Error?: string; Message?: string };
  return record.Error ?? record.Message ?? null;
}

function randomToken(byteLength: number): Uint8Array {
  return randomBytes(byteLength);
}

function randomBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
