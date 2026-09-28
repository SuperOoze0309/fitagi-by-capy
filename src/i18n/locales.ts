/**
 * Translation catalogues.
 *
 * Structure: one nested object per locale, all with the SAME shape. `en.ts` is the
 * reference; `zh-CN.ts` and `es.ts` are checked against its shape at compile time,
 * so a missing or misspelled key is a type error rather than a fallback to English
 * discovered by a user.
 *
 * Rules for contributors:
 *  - no user-visible string belongs in a component; it lives here;
 *  - `{name}` placeholders are interpolated by `t(key, { name })`;
 *  - translations are written to read naturally in the target language, not
 *    word-for-word from English.
 */

export const LOCALES = ['zh-CN', 'en', 'es'] as const;

export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  'zh-CN': '简体中文',
  en: 'English',
  es: 'Español',
};

/** Shown in Settings under the language picker. */
export const LOCALE_HINTS: Record<Locale, string> = {
  'zh-CN': '界面语言',
  en: 'Interface language',
  es: 'Idioma de la interfaz',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Pick a locale from a BCP-47 tag such as `zh-Hans-CN` or `es-419`.
 *
 * Chinese of any script/region maps to Simplified Chinese (the only Chinese
 * catalogue), Spanish of any region maps to `es`, everything else to English.
 */
export function localeFromTag(tag: string | undefined | null): Locale {
  if (!tag) return 'en';
  const lower = tag.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('es')) return 'es';
  return 'en';
}

/** The device's preferred locale, falling back to English. */
export function detectSystemLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  const candidates = [navigator.language, ...(navigator.languages ?? [])];
  for (const tag of candidates) {
    if (!tag) continue;
    const lower = tag.toLowerCase();
    if (lower.startsWith('zh')) return 'zh-CN';
    if (lower.startsWith('es')) return 'es';
    if (lower.startsWith('en')) return 'en';
  }
  return localeFromTag(candidates[0]);
}
