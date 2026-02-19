export class NoSessionError extends Error {
  constructor(message = "No stored Proton session.") {
    super(message);
    this.name = "NoSessionError";
  }
}

export class AuthFailedError extends Error {
  constructor(message = "Authentication failed.") {
    super(message);
    this.name = "AuthFailedError";
  }
}

export class TwoFactorRequiredError extends Error {
  constructor(message = "Two-factor authentication code required.") {
    super(message);
    this.name = "TwoFactorRequiredError";
  }
}

export class SessionRefreshError extends Error {
  constructor(message = "Session refresh failed.") {
    super(message);
    this.name = "SessionRefreshError";
  }
}

export class SecretStorageError extends Error {
  constructor(message = "Secret storage operation failed.") {
    super(message);
    this.name = "SecretStorageError";
  }
}

export class BootstrapStateError extends Error {
  constructor(message = "Invalid bootstrap state.") {
    super(message);
    this.name = "BootstrapStateError";
  }
}

export function toSafeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error("Unknown integration error.");
}
