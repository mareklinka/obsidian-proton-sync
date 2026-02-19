import { ProtonAuthService } from "../../proton-auth";
import type {
  ProtonAuthGateway,
  ProtonCredentials,
  ProtonLogger,
} from "../public/types";

export class DefaultProtonAuthGateway implements ProtonAuthGateway {
  private readonly authService: ProtonAuthService;

  constructor(appVersion: string, logger: ProtonLogger) {
    this.authService = new ProtonAuthService(appVersion, logger);
  }

  async signIn(credentials: ProtonCredentials): ReturnType<ProtonAuthGateway["signIn"]> {
    return this.authService.signIn(
      credentials.email,
      credentials.password,
      credentials.twoFactorCode ?? "",
    );
  }

  async refresh(session: Parameters<ProtonAuthGateway["refresh"]>[0]): ReturnType<ProtonAuthGateway["refresh"]> {
    return this.authService.refreshSession(session);
  }
}
