import type { ReminderKind, TrainingGoal, UserProfile } from '../../domain/types';
import { minutesOfDay } from '../../repositories/planRepository';
import type { ChatMessage } from './provider';

/**
 * AI proposals for reminders and training plans.
 *
 * These follow the rule the rest of the app follows: a model may **propose**, and the
 * user confirms. Nothing here writes to storage, and every field is validated on the
 * way out — a model that returns a 25-hour day or a weekday of 9 produces nothing
 * rather than a broken record.
 */

export interface ProposalDeps {
  /** Sends a text-only conversation. Injected so tests need no network. */
  chat: (messages: ChatMessage[]) => Promise<string>;
}

// ---------------------------------------------------------------- reminders

export interface ReminderProposal {
  title: string;
  body: string;
  kind: ReminderKind;
  /** `HH:MM`, already validated. */
  time: string;
  weekdays: number[];
}

const KINDS: ReminderKind[] = ['workout', 'meal', 'water', 'weighIn', 'rest', 'custom'];

const REMINDER_SYSTEM = [
  'You propose local notification reminders for a training and food logging app.',
  'Answer with JSON only, no prose and no code fences.',
  'Shape: {"reminders":[{"title":"...","body":"...","kind":"workout|meal|water|weighIn|rest|custom","time":"HH:MM","weekdays":[0-6]}]}',
  'Rules:',
  '- 3 to 5 reminders.',
  '- time is 24-hour local "HH:MM".',
  '- weekdays uses 0 for Sunday; use an empty array for every day.',
  '- title is at most 4 words; body is one short sentence, and may name exercises.',
  '- Be concrete and matched to the stated goal. Do not give medical advice.',
].join('\n');

/** Context for a reminder proposal: what the app knows that is relevant. */
export interface ReminderContext {
  profile: UserProfile;
  /** Local times the user usually trains at, `"HH:MM"`, most common first. */
  usualTrainingTimes: string[];
  /** Weekdays (0=Sunday) with at least one logged workout. */
  activeWeekdays: number[];
  totalWorkouts: number;
}

function describeReminderContext(context: ReminderContext): string {
  const lines: string[] = [];
  const { profile } = context;
  lines.push(`Training goal: ${profile.trainingGoal ?? 'not set'}`);
  lines.push(`Activity level: ${profile.activityLevel ?? 'not set'}`);
  if (profile.weightKg !== null && profile.goalWeightKg !== null) {
    lines.push(`Weight ${profile.weightKg} kg, goal ${profile.goalWeightKg} kg`);
  }
  lines.push(`Logged workouts in total: ${context.totalWorkouts}`);
  lines.push(
    `Weekdays usually trained: ${
      context.activeWeekdays.length > 0 ? context.activeWeekdays.join(', ') : 'unknown'
    }`,
  );
  lines.push(
    `Times usually trained: ${
      context.usualTrainingTimes.length > 0 ? context.usualTrainingTimes.join(', ') : 'unknown'
    }`,
  );
  return lines.join('\n');
}

/** Ask for reminders and keep only what survives validation. */
export async function proposeReminders(
  context: ReminderContext,
  deps: ProposalDeps,
): Promise<ReminderProposal[]> {
  const content = await deps.chat([
    { role: 'system', content: REMINDER_SYSTEM },
    {
      role: 'user',
      content: `Propose reminders for this person.\n\n${describeReminderContext(context)}`,
    },
  ]);
  return parseReminderProposals(content);
}

/** Exported for tests: the parsing and validation are the parts that can be wrong. */
export function parseReminderProposals(content: string): ReminderProposal[] {
  const parsed = parseJsonObject(content);
  const raw = parsed?.['reminders'];
  if (!Array.isArray(raw)) return [];

  const proposals: ReminderProposal[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
    if (title === '') continue;

    const time = typeof record['time'] === 'string' ? record['time'].trim() : '';
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) continue;

    const kind = KINDS.includes(record['kind'] as ReminderKind)
      ? (record['kind'] as ReminderKind)
      : 'custom';

    const weekdays = Array.isArray(record['weekdays'])
      ? [...new Set(
          record['weekdays']
            .map((day) => Number(day))
            .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
        )].sort()
      : [];

    proposals.push({
      title: title.slice(0, 60),
      body: typeof record['body'] === 'string' ? record['body'].trim().slice(0, 160) : '',
      kind,
      time,
      weekdays,
    });
    if (proposals.length >= 6) break;
  }

  // Two reminders at the same minute with the same days would be a duplicate the user
  // has to notice themselves, so collapse them here.
  const seen = new Set<string>();
  return proposals.filter((proposal) => {
    const key = `${proposal.time}|${proposal.weekdays.join(',')}|${proposal.title.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// -------------------------------------------------------------------- plans

export interface PlanProposalExercise {
  name: string;
  sets: number;
  reps: string;
  targetWeightKg: number | null;
  notes: string;
}

export interface PlanProposalDay {
  weekday: number;
  title: string;
  rest: boolean;
  exercises: PlanProposalExercise[];
}

export interface PlanProposal {
  name: string;
  goal: TrainingGoal | null;
  notes: string;
  days: PlanProposalDay[];
}

const PLAN_SYSTEM = [
  'You draft weekly training plans for a workout logging app.',
  'Answer with JSON only, no prose and no code fences.',
  'Shape: {"name":"...","goal":"fatLoss|muscleGain|strength|endurance|generalFitness|null","notes":"...","days":[{"weekday":0-6,"title":"...","rest":false,"exercises":[{"name":"...","sets":3,"reps":"8-10","notes":""}]}]}',
  'Rules:',
  '- Include all seven weekdays exactly once, 0 for Sunday.',
  '- Mark rest days with "rest": true and an empty exercises array.',
  '- 3 to 6 training days, 3 to 6 exercises per training day.',
  '- "reps" is text such as "8-10", "5", "AMRAP" — never a number.',
  '- Exercise names are plain gym names. Do not invent branded programmes.',
  '- Do not give medical advice.',
].join('\n');

export interface PlanContext {
  profile: UserProfile;
  /** The user's own exercise names, most used first, so the plan sounds like them. */
  knownExercises: string[];
}

export async function proposePlan(
  prompt: string,
  context: PlanContext,
  deps: ProposalDeps,
): Promise<PlanProposal> {
  const content = await deps.chat([
    { role: 'system', content: PLAN_SYSTEM },
    {
      role: 'user',
      content: [
        `Request: ${prompt.trim() === '' ? 'a balanced week' : prompt.trim()}`,
        '',
        `Training goal: ${context.profile.trainingGoal ?? 'not set'}`,
        `Activity level: ${context.profile.activityLevel ?? 'not set'}`,
        `Exercises this person already logs: ${
          context.knownExercises.slice(0, 20).join(', ') || 'none yet'
        }`,
      ].join('\n'),
    },
  ]);
  return parsePlanProposal(content);
}

export function parsePlanProposal(content: string): PlanProposal {
  const parsed = parseJsonObject(content);
  if (!parsed) return { name: '', goal: null, notes: '', days: [] };

  const goals: TrainingGoal[] = [
    'fatLoss',
    'muscleGain',
    'strength',
    'endurance',
    'generalFitness',
  ];
  const goal = goals.includes(parsed['goal'] as TrainingGoal)
    ? (parsed['goal'] as TrainingGoal)
    : null;

  const days: PlanProposalDay[] = [];
  const rawDays = Array.isArray(parsed['days']) ? parsed['days'] : [];
  for (const entry of rawDays) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const weekday = Number(record['weekday']);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;

    const exercises: PlanProposalExercise[] = [];
    const rawExercises = Array.isArray(record['exercises']) ? record['exercises'] : [];
    for (const rawExercise of rawExercises) {
      if (typeof rawExercise !== 'object' || rawExercise === null) continue;
      const exercise = rawExercise as Record<string, unknown>;
      const name = typeof exercise['name'] === 'string' ? exercise['name'].trim() : '';
      if (name === '') continue;
      const sets = Number(exercise['sets']);
      exercises.push({
        name: name.slice(0, 60),
        sets: Number.isFinite(sets) ? Math.min(20, Math.max(1, Math.round(sets))) : 3,
        reps: typeof exercise['reps'] === 'string' ? exercise['reps'].trim().slice(0, 20) : '8-10',
        targetWeightKg: null,
        notes: typeof exercise['notes'] === 'string' ? exercise['notes'].trim().slice(0, 80) : '',
      });
      if (exercises.length >= 8) break;
    }

    const rest = record['rest'] === true || exercises.length === 0;
    days.push({
      weekday,
      title: typeof record['title'] === 'string' ? record['title'].trim().slice(0, 40) : '',
      rest,
      exercises: rest ? [] : exercises,
    });
  }

  // One entry per weekday, filling any the model left out with a rest day: the editor
  // shows a week, and a missing Thursday would look like a bug.
  const byWeekday = new Map(days.map((day) => [day.weekday, day]));
  const complete: PlanProposalDay[] = Array.from({ length: 7 }, (_, weekday) =>
    byWeekday.get(weekday) ?? { weekday, title: '', rest: true, exercises: [] },
  );

  return {
    name: typeof parsed['name'] === 'string' ? parsed['name'].trim().slice(0, 60) : '',
    goal,
    notes: typeof parsed['notes'] === 'string' ? parsed['notes'].trim().slice(0, 240) : '',
    days: complete,
  };
}

/** Oldest-first ordering helper shared by the proposal preview and the editor. */
export function sortProposalDays(days: PlanProposalDay[]): PlanProposalDay[] {
  return [...days].sort((a, b) => a.weekday - b.weekday);
}

/** The most common training times, for the reminder context. */
export function usualTrainingTimes(startTimes: string[], limit = 3): string[] {
  const counts = new Map<string, number>();
  for (const start of startTimes) {
    const date = new Date(start);
    if (Number.isNaN(date.getTime())) continue;
    // Round to the nearest half hour: 18:47 and 18:52 are the same habit.
    const minutes = Math.round((date.getHours() * 60 + date.getMinutes()) / 30) * 30;
    const key = `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || minutesOfDay(a[0]) - minutesOfDay(b[0]))
    .slice(0, limit)
    .map(([time]) => time);
}

/** Tolerant JSON extraction: models like to wrap objects in prose or fences. */
function parseJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const candidates = [trimmed];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
