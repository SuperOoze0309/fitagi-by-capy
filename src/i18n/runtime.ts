import { detectSystemLocale, type Locale } from './locales';

/**
 * The locale currently in effect, readable synchronously.
 *
 * The chosen language lives in the settings record, which is only reachable
 * through an async storage call. Components use `useI18n()` and never need this,
 * but a crash screen must render immediately and cannot await anything — so the
 * provider mirrors the resolved locale here on every change.
 */
let activeLocale: Locale | null = null;

/** Called by the app provider whenever the resolved locale changes. */
export function setActiveLocale(locale: Locale): void {
  activeLocale = locale;
}

/** The active locale, falling back to the device language before the app boots. */
export function getActiveLocale(): Locale {
  return activeLocale ?? detectSystemLocale();
}
