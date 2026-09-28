import { en } from './en';
import { zhCN } from './zh-CN';
import { es } from './es';
import type { Catalogue, Locale, MessageKey, MessageParams, Messages } from './types';

export * from './locales';
export type { Catalogue, Locale, MessageKey, MessageParams, Messages } from './types';

/**
 * The catalogues, one entry per supported locale.
 *
 * `intlTag` drives date and number formatting so a Chinese user sees `2026年3月4日`
 * and a Spanish user `4 mar 2026`, without any per-locale date code.
 */
export const CATALOGUES: Record<Locale, Catalogue> = {
  'zh-CN': { messages: zhCN, intlTag: 'zh-CN' },
  en: { messages: en, intlTag: 'en-US' },
  es: { messages: es, intlTag: 'es-ES' },
};

/** Resolve a dotted key against a catalogue. */
function lookup(messages: Messages, key: string): string | undefined {
  const parts = key.split('.');
  let current: unknown = messages;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

/**
 * Replace `{name}` slots.
 *
 * Unknown placeholders are left alone rather than replaced with "undefined": a
 * visible `{count}` in the UI is an obvious bug report, whereas a missing number
 * silently reads as correct.
 */
function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Translate a key.
 *
 * Falls back to English and then to the key itself, and warns in development, so a
 * gap is loud during development instead of shipping as a blank label.
 */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const template = lookup(CATALOGUES[locale].messages, key);
  if (template !== undefined) return interpolate(template, params);

  const fallback = lookup(CATALOGUES.en.messages, key);
  if (fallback !== undefined) {
    console.warn(`[i18n] missing "${key}" in ${locale}`);
    return interpolate(fallback, params);
  }

  console.warn(`[i18n] unknown key "${key}"`);
  return key;
}

/**
 * Count-aware translation.
 *
 * Only two forms are needed by this app (one / other) and all three languages
 * treat them the same way for the strings involved, so instead of shipping an ICU
 * plural engine the catalogue provides an explicit `<key>One` variant and this
 * helper picks it.
 */
export function translatePlural(
  locale: Locale,
  key: MessageKey,
  oneKey: MessageKey,
  count: number,
  params?: MessageParams,
): string {
  const chosen = count === 1 ? oneKey : key;
  return translate(locale, chosen, { count, ...params });
}

/** A `t` bound to one locale. */
export function createTranslator(locale: Locale) {
  const t = (key: MessageKey, params?: MessageParams) => translate(locale, key, params);
  return {
    t,
    /** `tPlural('meals.itemsCount', 'meals.oneItem', n)` */
    tPlural: (key: MessageKey, oneKey: MessageKey, count: number, params?: MessageParams) =>
      translatePlural(locale, key, oneKey, count, params),
    intlTag: CATALOGUES[locale].intlTag,
  };
}

export type Translator = ReturnType<typeof createTranslator>;
