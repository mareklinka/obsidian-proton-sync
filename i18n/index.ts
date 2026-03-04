import { en, type TranslationCatalog } from './lang/en';
import { fr } from './lang/fr';

export type DeepPartialTranslation<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => R
  : T extends Array<unknown>
    ? T
    : T extends object
      ? { [K in keyof T]?: DeepPartialTranslation<T[K]> }
      : T;

export type TranslationOverrides = DeepPartialTranslation<TranslationCatalog>;

const localeOverrides: Record<string, TranslationOverrides> = {
  en,
  fr
};

export interface I18nService {
  readonly locale: string;
  readonly language: string;
  readonly t: TranslationCatalog;
}

let service: I18nService | null = null;

export function initI18n(language: string): I18nService {
  const normalizedLanguage = language.toLowerCase();
  const fallbackChain = buildLocaleFallbackChain(normalizedLanguage);

  let mergedCatalog: TranslationCatalog = deepClone(en);

  for (const locale of fallbackChain) {
    const override = localeOverrides[locale];
    if (!override) {
      continue;
    }

    mergedCatalog = deepMerge<TranslationCatalog>(mergedCatalog, override);
  }

  const initialized: I18nService = {
    locale: fallbackChain[0] ?? 'en',
    language: language || 'en',
    t: mergedCatalog
  };

  service = initialized;

  return initialized;
}

export function getI18n(): I18nService {
  if (!service) {
    return initI18n('en');
  }

  return service;
}

function buildLocaleFallbackChain(language: string): string[] {
  const locales: string[] = ['en'];

  if (language) {
    const [baseLanguage] = language.split('-');
    if (baseLanguage && baseLanguage !== 'en') {
      locales.push(baseLanguage);
    }

    if (language !== 'en') {
      locales.push(language);
    }
  }

  return [...new Set(locales)];
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => deepClone(item)) as T;
  }

  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      clone[key] = deepClone(nestedValue);
    }

    return clone as T;
  }

  return value;
}

function deepMerge<T extends object>(base: T, patch: DeepPartialTranslation<T>): T {
  const merged = deepClone(base);

  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) {
      continue;
    }

    const currentValue = (merged as Record<string, unknown>)[key];

    if (isRecord(currentValue) && isRecord(value)) {
      (merged as Record<string, unknown>)[key] = deepMerge(currentValue, value);
      continue;
    }

    (merged as Record<string, unknown>)[key] = value;
  }

  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
