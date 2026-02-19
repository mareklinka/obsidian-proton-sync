import type { App } from "obsidian";

import {
  clearSession,
  loadSession,
  saveSession,
  type ProtonSession,
} from "../../../session-store";
import type { SessionStore } from "../../public/types";

export class SessionRepository implements SessionStore {
  constructor(private readonly app: App) {}

  async load(): Promise<ProtonSession | null> {
    return loadSession(this.app);
  }

  async save(session: ProtonSession): Promise<void> {
    await saveSession(this.app, session);
  }

  async clear(): Promise<void> {
    await clearSession(this.app);
  }
}
