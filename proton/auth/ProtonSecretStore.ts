export interface ProtonSecretStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  clear(key: string): void;
}
