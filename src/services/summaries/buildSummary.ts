import type {
  SummaryChange,
  SummaryHighlight,
  SummaryKind,
  TrainingSummary,
  Workout,
} from '../../domain/types';
import {
  bestSet,
  countWorkingSets,
  estimateOneRepMaxKg,
  workingSets,
  workoutVolumeKg,
} from '../../domain/metrics';
import { formatDuration, formatNumber, fromKg, roundDisplayWeight } from '../../domain/units';
import { addDays, formatDayLabel, localDateKey, nowIso } from '../../domain/datetime';
import { exerciseGroupKey } from '../../domain/workout';
import type { WeightUnit } from '../../domain/types';

/**
 * Local summary generation.
 *
 * Summaries are **derived** and are produced without any model, which is what makes
 * them work with AI switched off. An LLM can later rephrase the body, but the
 * numbers, the highlights and the comparisons always come from here — so the facts
 * a summary states are never model output.
 *
 * The layers compress upward:
 *
 *   Workout -> Daily Summary -> Weekly Summary -> Monthly Summary
 *
 * Each layer reads only the layer below it, which is what keeps a month's summary
 * cheap and means the whole month's JSON is never sent anywhere.
 */

export const SUMMARY_KINDS: SummaryKind[] = ['daily', 'weekly', 'monthly'];

/** Stable id per period, so regenerating replaces rather than duplicates. */
export function summaryId(kind: SummaryKind, periodKey: string): string {
  return `sum_${kind}_${periodKey}`;
}

export interface SummaryContext {
  unit: WeightUnit;
  /** Previous comparable period, used for the "obvious change" line. */
  previous?: TrainingSummary | null;
  /** Per-exercise history before this period, for per-lift comparisons. */
  previousBestByExercise?: Map<string, { weightKg: number; reps: number | null }>;
}

export interface SummaryInput {
  kind: SummaryKind;
  periodKey: string;
  workouts: Workout[];
  context: SummaryContext;
}

// -----------------------------------------------------------------------------
// Shared aggregation
// -----------------------------------------------------------------------------

interface Totals {
  sessionCount: number;
  workingSets: number;
  volumeKg: number;
  durationSec: number;
  exerciseCounts: Map<string, number>;
  /** Heaviest working set per exercise, in kg. */
  bestByExercise: Map<string, { weightKg: number; reps: number | null; unit: WeightUnit }>;
  /** Best estimated 1RM per exercise, in kg. */
  oneRmByExercise: Map<string, number>;
}

function emptyTotals(): Totals {
  return {
    sessionCount: 0,
    workingSets: 0,
    volumeKg: 0,
    durationSec: 0,
    exerciseCounts: new Map(),
    bestByExercise: new Map(),
    oneRmByExercise: new Map(),
  };
}

export function aggregate(workouts: Workout[]): Totals {
  const totals = emptyTotals();
  totals.sessionCount = workouts.length;

  for (const workout of workouts) {
    totals.volumeKg += workoutVolumeKg(workout);
    totals.workingSets += countWorkingSets(workout);
    totals.durationSec += workout.durationSec;

    for (const exercise of workout.exercises) {
      const name = exercise.normalizedName || exercise.rawName;
      if (name === '') continue;
      const key = exerciseGroupKey(name);
      totals.exerciseCounts.set(key, (totals.exerciseCounts.get(key) ?? 0) + 1);

      const top = bestSet(exercise.sets);
      if (top?.weightKg != null) {
        const current = totals.bestByExercise.get(key);
        if (!current || top.weightKg > current.weightKg) {
          totals.bestByExercise.set(key, {
            weightKg: top.weightKg,
            reps: top.reps,
            unit: top.unit,
          });
        }
      }
      for (const set of workingSets(exercise.sets)) {
        const oneRm = estimateOneRepMaxKg(set);
        if (oneRm === null) continue;
        const current = totals.oneRmByExercise.get(key);
        if (current === undefined || oneRm > current) totals.oneRmByExercise.set(key, oneRm);
      }
    }
  }

  return totals;
}

/**
 * What the session was about, in a few words: "Legs and shoulders." style.
 *
 * The patterns are deliberately conservative. A bare "press" is not enough to call
 * something chest work — "Overhead Press" is shoulders, and "Leg Press" is legs —
 * so the specific lifts are named instead. An unrecognised name simply does not
 * contribute to the day's title rather than being guessed at.
 */
const MUSCLE_KEYWORDS: { label: string; pattern: RegExp }[] = [
  // Order matters: the first matching group wins for a given name.
  { label: 'legs', pattern: /squat|leg press|leg extension|leg curl|lunge|calf|hamstring|quad|deadlift|hip thrust|深蹲|腿举|腿|小腿|箭步/i },
  { label: 'chest', pattern: /bench press|chest|pec|push ?up|dip|fly(?:es)?|飞鸟|卧推|胸/i },
  { label: 'back', pattern: /\brow(?:s|ing)?\b|pull ?up|pull ?down|chin ?up|lat |lat\b|shrug|划船|引体|下拉|硬拉|背/i },
  { label: 'shoulders', pattern: /overhead|shoulder|ohp|lateral raise|front raise|rear delt|delt|推举|肩|侧平举/i },
  { label: 'arms', pattern: /curl|triceps|biceps|pushdown|skull|弯举|臂|下压|三头|二头/i },
  { label: 'core', pattern: /\bab(?:s|s\b)|crunch|plank|core|russian twist|卷腹|平板|腹/i },
];

export function describeFocus(workouts: Workout[]): string[] {
  const seen = new Set<string>();
  for (const workout of workouts) {
    for (const exercise of workout.exercises) {
      const name = exercise.normalizedName || exercise.rawName;
      if (name === '') continue;
      // Attribute each exercise to exactly one group so a name like
      // "Overhead Press" cannot be counted as both chest and shoulders.
      const match = MUSCLE_KEYWORDS.find((entry) => entry.pattern.test(name));
      if (match) seen.add(match.label);
    }
  }
  const order = MUSCLE_KEYWORDS.map((entry) => entry.label);
  return order.filter((label) => seen.has(label));
}

function joinWords(words: string[]): string {
  if (words.length === 0) return '';
  if (words.length === 1) return words[0]!;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]!}`;
}

/** Changes worth mentioning: new bests, and clear jumps versus last time. */
export function describeChanges(totals: Totals, context: SummaryContext): SummaryChange[] {
  const changes: SummaryChange[] = [];
  const previousBest = context.previousBestByExercise ?? new Map();

  for (const [key, best] of totals.bestByExercise) {
    const previous = previousBest.get(key);
    const display = `${formatNumber(roundDisplayWeight(fromKg(best.weightKg, context.unit), context.unit))}${
      context.unit
    }`;

    if (!previous) {
      changes.push({ exercise: key, text: `first logged ${display}`, direction: 'up' });
      continue;
    }
    const deltaKg = best.weightKg - previous.weightKg;
    const delta = roundDisplayWeight(fromKg(Math.abs(deltaKg), context.unit), context.unit);
    if (delta < (context.unit === 'kg' ? 1 : 2)) continue;

    changes.push({
      exercise: key,
      text: `${display} (${deltaKg > 0 ? '+' : '-'}${formatNumber(delta)}${context.unit} vs before)`,
      direction: deltaKg > 0 ? 'up' : 'down',
    });
  }

  // Most interesting first: gains, then anything else.
  return changes.sort((a, b) => (a.direction === b.direction ? 0 : a.direction === 'up' ? -1 : 1)).slice(0, 4);
}

/** "腿举 577lb × 8 × 4" style lines for the main lifts, busiest lift first. */
export function describeMainLifts(workouts: Workout[], limit: number): string[] {
  const byExercise = new Map<string, { name: string; sets: Workout['exercises'][number]['sets'] }>();

  for (const workout of workouts) {
    for (const exercise of workout.exercises) {
      const name = exercise.normalizedName || exercise.rawName;
      if (name === '') continue;
      const key = exerciseGroupKey(name);
      const existing = byExercise.get(key);
      if (existing) existing.sets.push(...exercise.sets);
      else byExercise.set(key, { name, sets: [...exercise.sets] });
    }
  }

  return [...byExercise.values()]
    .sort((a, b) => workingSets(b.sets).length - workingSets(a.sets).length)
    .slice(0, limit)
    .map((entry) => {
      const working = workingSets(entry.sets);
      if (working.length === 0) return `${entry.name}: no working sets`;

      const first = working[0]!;
      const sameWeight = working.every(
        (set) => set.weight === first.weight && set.unit === first.unit,
      );
      const sameReps = working.every((set) => set.reps === first.reps);
      // The common "60kg x 8 x 4" shape, collapsed.
      if (sameWeight && sameReps && first.weight !== null && first.reps !== null) {
        return `${entry.name}: ${formatNumber(first.weight)}${first.unit} × ${first.reps} × ${working.length}`;
      }
      const sets = working
        .map(
          (set) => `${set.weight === null ? '—' : formatNumber(set.weight)}${set.unit}×${set.reps ?? '—'}`,
        )
        .join(', ');
      return `${entry.name}: ${sets}`;
    });
}

// -----------------------------------------------------------------------------
// Layer 1: daily
// -----------------------------------------------------------------------------

export function buildDailySummary(input: SummaryInput): TrainingSummary {
  const { workouts, context } = input;
  const totals = aggregate(workouts);
  const focus = describeFocus(workouts);
  const mainLifts = describeMainLifts(workouts, 4);
  const changes = describeChanges(totals, context);

  const title =
    focus.length > 0
      ? `Trained ${joinWords(focus)}.`
      : workouts.length > 0
        ? `${workouts.length} ${workouts.length === 1 ? 'session' : 'sessions'} logged.`
        : 'No training logged.';

  const highlights: SummaryHighlight[] = [
    { label: 'Sessions', value: String(totals.sessionCount) },
    { label: 'Working sets', value: String(totals.workingSets) },
    { label: 'Volume', value: `${formatNumber(totals.volumeKg, 0)} kg` },
    { label: 'Time', value: formatDuration(totals.durationSec) },
  ];

  const bullets = [...mainLifts, ...changes.map((change) => `${change.exercise}: ${change.text}`)];
  const body = [
    title,
    '',
    ...mainLifts.map((line) => `- ${line}`),
    ...(changes.length > 0 ? ['', 'Changes:', ...changes.map((change) => `- ${change.exercise}: ${change.text}`)] : []),
    '',
    `Total time: ${formatDuration(totals.durationSec)} · ${totals.workingSets} working sets · ${formatNumber(
      totals.volumeKg,
      0,
    )} kg volume`,
  ].join('\n');

  return finish(input, {
    title,
    body,
    bullets,
    highlights,
    changes,
    totals,
    workoutIds: workouts.map((workout) => workout.id),
  });
}

// -----------------------------------------------------------------------------
// Layer 2 and 3: weekly and monthly, built from the layer below
// -----------------------------------------------------------------------------

export interface RollupInput {
  kind: 'weekly' | 'monthly';
  periodKey: string;
  /** Sessions in the period. Used for totals; the prose comes from `children`. */
  workouts: Workout[];
  /** Daily summaries (weekly) or weekly summaries (monthly). */
  children: TrainingSummary[];
  context: SummaryContext;
}

export function buildRollupSummary(input: RollupInput): TrainingSummary {
  const { workouts, children, context, kind } = input;
  const totals = aggregate(workouts);
  const focus = describeFocus(workouts);
  const mainLifts = describeMainLifts(workouts, 5);
  const changes = describeChanges(totals, context);
  const periodWord = kind === 'weekly' ? 'week' : 'month';

  const title =
    totals.sessionCount === 0
      ? `No training this ${periodWord}.`
      : `${totals.sessionCount} ${
          totals.sessionCount === 1 ? 'session' : 'sessions'
        } this ${periodWord}${focus.length > 0 ? `, mostly ${joinWords(focus)}` : ''}.`;

  const highlights: SummaryHighlight[] = [
    { label: 'Sessions', value: String(totals.sessionCount) },
    { label: 'Working sets', value: String(totals.workingSets) },
    { label: 'Volume', value: `${formatNumber(totals.volumeKg, 0)} kg` },
    { label: 'Time', value: formatDuration(totals.durationSec) },
  ];

  // The trend versus the previous period is the reason a weekly summary exists.
  const previous = context.previous ?? null;
  const trendLines: string[] = [];
  if (previous && previous.sessionCount > 0) {
    const sessionDelta = totals.sessionCount - previous.sessionCount;
    trendLines.push(
      `Sessions ${sessionDelta >= 0 ? '+' : ''}${sessionDelta} vs previous ${periodWord} (${previous.sessionCount})`,
    );
    const volumeDelta = totals.volumeKg - previous.totalVolumeKg;
    if (previous.totalVolumeKg > 0) {
      const percent = Math.round((volumeDelta / previous.totalVolumeKg) * 100);
      trendLines.push(
        `Volume ${percent >= 0 ? '+' : ''}${percent}% (${formatNumber(totals.volumeKg, 0)} vs ${formatNumber(
          previous.totalVolumeKg,
          0,
        )} kg)`,
      );
    }
  }

  // One line per day/week inside the period, straight from the layer below.
  const childLines = children
    .slice()
    .sort((a, b) => a.periodKey.localeCompare(b.periodKey))
    .map((child) => `- ${child.periodKey}: ${child.title}`);

  const body = [
    title,
    '',
    ...trendLines.map((line) => `- ${line}`),
    ...(mainLifts.length > 0 ? ['', 'Main lifts:', ...mainLifts.map((line) => `- ${line}`)] : []),
    ...(changes.length > 0 ? ['', 'Changes:', ...changes.map((change) => `- ${change.exercise}: ${change.text}`)] : []),
    ...(childLines.length > 0 ? ['', 'By period:', ...childLines] : []),
  ].join('\n');

  return finish(input, {
    title,
    body,
    bullets: [...trendLines, ...mainLifts, ...changes.map((change) => `${change.exercise}: ${change.text}`)],
    highlights,
    changes,
    totals,
    // A weekly summary inherits the workout ids of its days, so deletion and
    // integrity checks stay meaningful one level up.
    workoutIds: [...new Set(children.flatMap((child) => child.workoutIds).concat(workouts.map((w) => w.id)))],
  });
}

interface FinishInput {
  kind: SummaryKind;
  periodKey: string;
  context: SummaryContext;
}

function finish(
  input: FinishInput,
  content: {
    title: string;
    body: string;
    bullets: string[];
    highlights: SummaryHighlight[];
    changes: SummaryChange[];
    totals: Totals;
    workoutIds: string[];
  },
): TrainingSummary {
  const now = nowIso();
  return {
    id: summaryId(input.kind, input.periodKey),
    kind: input.kind,
    periodKey: input.periodKey,
    title: content.title,
    body: content.body,
    bullets: content.bullets,
    highlights: content.highlights,
    changes: content.changes,
    workoutIds: content.workoutIds,
    sessionCount: content.totals.sessionCount,
    totalVolumeKg: content.totals.volumeKg,
    totalDurationSec: content.totals.durationSec,
    source: 'auto',
    generatedAt: now,
    updatedAt: now,
  };
}

// -----------------------------------------------------------------------------
// Period keys
// -----------------------------------------------------------------------------

/** Monday-based start of the week containing `date`, as YYYY-MM-DD. */
export function weekKey(date: Date): string {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const mondayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - mondayOffset);
  return localDateKey(start);
}

/** YYYY-MM for the month containing `date`. */
export function monthKey(date: Date): string {
  return localDateKey(date).slice(0, 7);
}

/** Every daily key in a week, Monday first. */
export function weekDayKeys(weekStartKey: string): string[] {
  const [year, month, day] = weekStartKey.split('-').map(Number);
  const start = new Date(year!, (month ?? 1) - 1, day ?? 1);
  return Array.from({ length: 7 }, (_, index) => localDateKey(addDays(start, index)));
}

/** Every week key whose Monday falls inside the month of `monthKeyValue`. */
export function monthWeekKeys(monthKeyValue: string): string[] {
  const [year, month] = monthKeyValue.split('-').map(Number);
  const first = new Date(year!, (month ?? 1) - 1, 1);
  const last = new Date(year!, month ?? 1, 0);
  const keys: string[] = [];
  const cursor = new Date(first);
  // Start from the Monday of the week containing the 1st, so a month that starts
  // mid-week still reports the sessions logged in those days.
  cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));
  while (cursor <= last) {
    keys.push(weekKey(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }
  return [...new Set(keys)];
}

/** The period immediately before this one. */
export function previousPeriodKey(kind: SummaryKind, periodKey: string): string {
  if (kind === 'daily') {
    const [year, month, day] = periodKey.split('-').map(Number);
    return localDateKey(addDays(new Date(year!, (month ?? 1) - 1, day ?? 1), -1));
  }
  if (kind === 'weekly') {
    const [year, month, day] = periodKey.split('-').map(Number);
    return localDateKey(addDays(new Date(year!, (month ?? 1) - 1, day ?? 1), -7));
  }
  const [year, month] = periodKey.split('-').map(Number);
  const previous = new Date(year!, (month ?? 1) - 2, 1);
  return monthKey(previous);
}

/** Human label for a period, used in the UI. */
export function periodLabel(kind: SummaryKind, periodKey: string): string {
  if (kind === 'daily') return formatDayLabel(periodKey);
  if (kind === 'weekly') {
    const days = weekDayKeys(periodKey);
    const first = days[0]!;
    const last = days[days.length - 1]!;
    return `Week of ${formatDayLabel(first)} – ${formatDayLabel(last)}`;
  }
  const [year, month] = periodKey.split('-').map(Number);
  return new Date(year!, (month ?? 1) - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}
