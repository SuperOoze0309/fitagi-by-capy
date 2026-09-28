import type { Locale } from './types';

/**
 * Starter exercise names offered to a user with no history yet.
 *
 * These live outside the message catalogue on purpose: a catalogue entry is a
 * single string, and these are lists of *data* (names that get written into a
 * workout), not UI copy. Keeping them here means the catalogue stays a flat
 * string map and the fallback is still one lookup.
 */
const QUICK_NAMES: Record<Locale, string[]> = {
  en: ['Bench Press', 'Squat', 'Deadlift', 'Overhead Press', 'Row', 'Pull Up'],
  'zh-CN': ['卧推', '深蹲', '硬拉', '推举', '划船', '引体向上'],
  es: ['Press banca', 'Sentadilla', 'Peso muerto', 'Press militar', 'Remo', 'Dominadas'],
};

/** Common exercise names for the given locale, falling back to English. */
export function quickExerciseNames(locale: Locale): string[] {
  return QUICK_NAMES[locale] ?? QUICK_NAMES.en;
}
