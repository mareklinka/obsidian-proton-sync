
import { requestUrl } from 'obsidian';

import type { ProtonSession } from './session-store';
import { buildSrpProofs, decodeBase64, encodeBase64, ProtonAuthInfo } from './proton-srp';

const API_BASE_URL = 'https://mail.proton.me/api';
const DEFAULT_SESSION_TTL_MS = 50 * 60 * 1000;

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

export class ProtonAuthService {
  private readonly appVersionHeader: string;

  constructor(private readonly appVersion: string) {
    this.appVersionHeader = `external-drive-obsidian-proton-sync@${appVersion}`;
  }

  async signIn(email: string, password: string, twoFactorCode: string): Promise<ProtonSession> {
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
      await this.submitTwoFactor(twoFactorCode);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + DEFAULT_SESSION_TTL_MS);

    return {
      uid: authResponse.UID,
      userId: authResponse.UserID || null,
      accessToken: authResponse.AccessToken,
      refreshToken: authResponse.RefreshToken,
      scope: authResponse.Scope || null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      lastRefreshAt: now.toISOString()
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
      AccessToken: session.accessToken
    };

    const response = await this.request<ProtonAuthResponse>('/auth/v4/refresh', body);

    const refreshedAt = new Date();
    const refreshedExpiresAt = new Date(refreshedAt.getTime() + DEFAULT_SESSION_TTL_MS);

    return {
      ...session,
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
      SRPSession: authInfo.SRPSession
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

  private async request<T>(path: string, body: unknown): Promise<T> {
    const response = await requestUrl({
      url: `${API_BASE_URL}${path}`,
      method: 'POST',
      contentType: 'application/json',
      headers: {
        'x-pm-appversion': this.appVersionHeader
      },
      body: JSON.stringify(body)
    });

    return response.json as T;
  }
}

function randomToken(byteLength: number): Uint8Array {
  return randomBytes(byteLength);
}

function randomBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
