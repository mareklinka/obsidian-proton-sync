export interface NormalizePathOptions {
  trimSlashes?: boolean;
}

export function normalizePath(path: string, options: NormalizePathOptions = {}): string {
  const trimSlashes = options.trimSlashes ?? true;
  let cleaned = path.trim().replace(/\\+/g, '/').replace(/\/+/g, '/');

  if (trimSlashes) {
    cleaned = cleaned.replace(/^\/+|\/+$/g, '');
  }

  return cleaned;
}

export function toCanonicalPathKey(path: string): string {
  const normalized = normalizePath(path);
  return normalized.toLocaleLowerCase();
}

export function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  if (index <= 0) {
    return '';
  }

  return normalized.slice(0, index);
}

export function getBaseName(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  if (index < 0) {
    return normalized;
  }

  return normalized.slice(index + 1);
}
