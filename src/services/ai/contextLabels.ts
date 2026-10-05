import type { MessageKey, Translator } from '../../i18n';
import type { ContextSection } from './contextBuilder';

const KEYS: Record<Exclude<ContextSection, `exerciseSessions:${number}` | `conversation:${number}`>, MessageKey> = {
  currentWorkout: 'ai.contextCurrent', last7Days: 'ai.contextRecent',
  weeklySaved: 'ai.contextWeeklySaved', weeklyComputed: 'ai.contextWeekly',
  monthlySaved: 'ai.contextMonthlySaved', monthlyComputed: 'ai.contextMonthly', question: 'ai.contextQuestion',
};
const LEGACY: Record<string, keyof typeof KEYS> = {
  'current workout': 'currentWorkout', 'last 7 days': 'last7Days',
  'saved weekly summary': 'weeklySaved', 'weekly rollup (computed)': 'weeklyComputed',
  'saved monthly summary': 'monthlySaved', 'monthly rollup (computed)': 'monthlyComputed',
  'your question': 'question',
};

/** Old saved exchanges remain readable after the switch to stable section IDs. */
export function contextSectionLabel(section: string, t: Translator['t']): string {
  const id = LEGACY[section] ?? section;
  if (Object.prototype.hasOwnProperty.call(KEYS, id)) return t(KEYS[id as keyof typeof KEYS]);
  const exercises = /^(?:exerciseSessions:|last )(\d+)(?: sessions per exercise)?$/.exec(section);
  if (exercises) return t('ai.contextExercise', { count: exercises[1]! });
  const memory = /^(?:conversation:|previous conversation \()(\d+)(?: exchanges\))?$/.exec(section);
  if (memory) return t('ai.contextConversation', { count: memory[1]! });
  return t('ai.contextUnknown');
}
