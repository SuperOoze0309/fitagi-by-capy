import type { ExerciseEntry, SetEntry, TrainingSummary, Workout } from '../../domain/types';
import { formatDuration, formatNumber, fromKg } from '../../domain/units';
import { formatDayLabel, localDateKey } from '../../domain/datetime';
import {
  bestSet,
  countWorkingSets,
  estimateOneRepMaxKg,
  workingSets,
  workoutVolumeKg,
} from '../../domain/metrics';
import { workoutExerciseNames } from '../../repositories/exerciseRepository';
import type { Repositories } from '../../repositories';
import { monthKey, weekKey } from '../summaries/buildSummary';

/**
 * Context Builder.
 *
 * The AI layer must never read the whole database. This module assembles the
 * smallest context that can answer the question at hand, in a fixed priority
 * order:
 *
 *   1. the workout currently being recorded
 *   2. the last 3-5 sessions of the exercise(s) in question
 *   3. the last 7 days of training
 *   4. the current weekly rollup
 *   5. the monthly rollup, only when explicitly needed
 *
 * Everything is rendered as compact plain text rather than raw JSON: it is far
 * cheaper in tokens, easier for the model to read, and it makes it obvious in a
 * privacy review exactly what would leave the device.
 */

export interface ContextRequest {
  /** Free-text question, when the user asked something specific. */
  question?: string;
  /** Workout being recorded, if any. */
  workoutId?: string;
  /** Exercise names the question is about (from the parser or the caller). */
  exerciseNames?: string[];
  /** How many past sessions per exercise. Default 5. */
  sessionsPerExercise?: number;
  /** Include a weekly rollup. Default true. */
  includeWeekly?: boolean;
  /** Include a monthly rollup. Only set when the question is about a longer trend. */
  includeMonthly?: boolean;
  /** Reference date, injectable for tests. */
  now?: Date;
}

export interface TrainingContext {
  /** The assembled prompt block. */
  text: string;
  /** What was actually included, for the "what will be sent" disclosure. */
  sections: ContextSection[];
  /** Rough size, shown in the UI. */
  characters: number;
}

const DEFAULT_SESSIONS = 5;

export type ContextSection = 'currentWorkout' | 'last7Days' | 'weeklySaved' | 'weeklyComputed'
  | 'monthlySaved' | 'monthlyComputed' | 'question' | `exerciseSessions:${number}` | `conversation:${number}`;

export class ContextBuilder {
  constructor(private readonly repos: Repositories) {}

  async build(request: ContextRequest = {}): Promise<TrainingContext> {
    const now = request.now ?? new Date();
    const sections: ContextSection[] = [];
    const parts: string[] = [];

    // 1. The workout currently being recorded.
    if (request.workoutId) {
      const workout = await this.repos.training.get(request.workoutId);
      if (workout) {
        parts.push(`## Current workout (in progress)\n${describeWorkout(workout)}`);
        sections.push('currentWorkout');
      }
    }

    // 2. Recent sessions of the exercises in question.
    const names = request.exerciseNames?.filter((name) => name.trim() !== '') ?? [];
    if (names.length > 0) {
      const perExercise = Math.max(1, Math.min(20, Math.floor(request.sessionsPerExercise ?? DEFAULT_SESSIONS)));
      const blocks: string[] = [];
      for (const name of names) {
        const history = (await this.repos.exercises.history(name)).filter((entry) => entry.date <= now);
        if (history.length === 0) continue;
        const lines = history.slice(0, perExercise).map((entry) => {
          const when = formatDayLabel(entry.dateKey);
          const sets = describeSets(entry.sets);
          const top = entry.bestSet;
          const oneRm = top ? estimateOneRepMaxKg(top) : null;
          return `- ${when}: ${sets}${oneRm ? ` (best e1RM ${formatNumber(oneRm, 0)}kg)` : ''}`;
        });
        blocks.push(`### ${name}\n${lines.join('\n')}`);
      }
      if (blocks.length > 0) {
        parts.push(`## Recent sessions for the exercises asked about\n${blocks.join('\n\n')}`);
        sections.push(`exerciseSessions:${perExercise}`);
      }
    }

    // 3. The last 7 days of training. This is a rolling window, not "since Monday",
    // because a Monday-morning question should still see the weekend.
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const recent = (await this.repos.training.completed()).filter((workout) => new Date(workout.startTime) <= now);
    const lastWeek = recent.filter((workout) => new Date(workout.startTime) >= weekAgo);
    if (lastWeek.length > 0) {
      // Prefer the stored daily summaries: they are the compressed form, and reusing
      // them is exactly what keeps this context small.
      const dayLines: string[] = [];
      for (const dayKeyValue of [
        ...new Set(lastWeek.map((workout) => localDateKey(workout.startTime))),
      ].sort()) {
        const dayWorkouts = lastWeek.filter((workout) => localDateKey(workout.startTime) === dayKeyValue);
        const summary = await this.repos.summaries.get('daily', dayKeyValue);
        if (summaryMatches(summary, dayWorkouts)) {
          dayLines.push(`- ${summary.periodKey}: ${summary.title}${firstBullet(summary)}`);
        } else {
          dayLines.push(
            `- ${dayKeyValue}: ${dayWorkouts
              .flatMap((workout) => workoutExerciseNames(workout))
              .join(', ')}`,
          );
        }
      }
      parts.push(`## Last 7 days\n${dayLines.join('\n')}`);
      sections.push('last7Days');
    }

    // 4. Weekly rollup. A stored summary is preferred — it is what the user has
    // already seen, and it costs nothing to reuse — with a live rollup as fallback
    // so context is never empty just because a summary has not been generated yet.
    const thisWeek = recent.filter((workout) => new Date(workout.startTime) >= startOfWeek(now));
    if (request.includeWeekly !== false && thisWeek.length > 0) {
      const candidate = await this.repos.summaries.get('weekly', weekKey(now));
      const stored = summaryMatches(candidate, thisWeek) ? candidate : null;
      parts.push(
        stored
          ? `## This week so far (saved summary)\n${stored.body}`
          : `## This week so far\n${describeWeek(thisWeek)}`,
      );
      sections.push(stored ? 'weeklySaved' : 'weeklyComputed');
    }

    // 5. Monthly rollup, only when asked for.
    if (request.includeMonthly) {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const month = recent.filter((workout) => new Date(workout.startTime) >= monthStart);
      const candidate = await this.repos.summaries.get('monthly', monthKey(now));
      const stored = summaryMatches(candidate, month) ? candidate : null;
      if (stored) {
        parts.push(`## This month so far (saved summary)\n${stored.body}`);
        sections.push('monthlySaved');
      } else if (month.length > 0) {
        parts.push(`## This month so far\n${describeMonth(month)}`);
        sections.push('monthlyComputed');
      }
    }

    if (request.question) {
      parts.push(`## User question\n${request.question}`);
      sections.push('question');
    }

    const text = parts.join('\n\n');
    return { text, sections, characters: text.length };
  }

  /**
   * Exercise names mentioned in a free-text question, so a specific question only
   * pulls the relevant history instead of everything.
   */
  async detectExerciseNames(question: string, limit = 3): Promise<string[]> {
    const needle = question.trim().toLowerCase();
    if (needle === '') return [];
    const suggestions = await this.repos.exercises.suggestions(200);
    return suggestions
      .filter((suggestion) => needle.includes(suggestion.name.toLowerCase()))
      .slice(0, limit)
      .map((suggestion) => suggestion.name);
  }
}

/** Only reuse a summary that describes exactly the sessions in the current window. */
function summaryMatches(summary: TrainingSummary | null, workouts: Workout[]): summary is TrainingSummary {
  if (!summary || workouts.length === 0) return false;
  const ids = new Set(workouts.map((workout) => workout.id));
  return summary.workoutIds.length === ids.size && summary.workoutIds.every((id) => ids.has(id));
}

function startOfWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const mondayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - mondayOffset);
  return start;
}

/** One compact number line from a stored summary, so a day still shows its work. */
function firstBullet(summary: TrainingSummary): string {
  if (summary.bullets.length === 0) return '';
  return ` — ${summary.bullets[0]}`;
}

export function describeSets(sets: SetEntry[]): string {
  const working = workingSets(sets);
  if (working.length === 0) return 'no working sets';
  return working.map((set) => describeSet(set)).join(', ');
}

function describeSet(set: SetEntry): string {
  const weight = set.weight === null ? '—' : `${formatNumber(set.weight)}${set.unit}`;
  const reps = set.reps === null ? '—' : String(set.reps);
  const flags: string[] = [];
  if (set.rpe !== null) flags.push(`RPE${formatNumber(set.rpe, 1)}`);
  if (set.rir !== null) flags.push(`RIR${set.rir}`);
  if (set.isFailure) flags.push('failure');
  if (set.isWarmup) flags.push('warmup');
  if (set.isDropSet) flags.push('drop set');
  return `${weight}x${reps}${flags.length > 0 ? ` ${flags.join(' ')}` : ''}`;
}

export function describeWorkout(workout: Workout): string {
  const lines = [
    `Started: ${localDateKey(workout.startTime)}`,
    `Duration: ${formatDuration(workout.durationSec)}`,
  ];
  if (workout.notes) lines.push(`Notes: ${workout.notes}`);
  for (const exercise of workout.exercises) {
    lines.push(`- ${exerciseName(exercise)}: ${describeSets(exercise.sets)}`);
  }
  return lines.join('\n');
}

function exerciseName(exercise: ExerciseEntry): string {
  return exercise.normalizedName || exercise.rawName;
}

/** Weekly rollup computed from raw workouts, not from stored summaries. */
export function describeWeek(workouts: Workout[]): string {  const volumeKg = workouts.reduce((sum, workout) => sum + workoutVolumeKg(workout), 0);
  const sets = workouts.reduce((sum, workout) => sum + countWorkingSets(workout), 0);
  const minutes = Math.round(
    workouts.reduce((sum, workout) => sum + workout.durationSec, 0) / 60,
  );
  const names = topExercises(workouts, 6);
  const lines = [
    `Sessions: ${workouts.length}`,
    `Working sets: ${sets}`,
    `Total volume: ${formatNumber(volumeKg, 0)} kg`,
    `Time: ${minutes} min`,
  ];
  if (names.length > 0) lines.push(`Main exercises: ${names.join(', ')}`);
  return lines.join('\n');
}

export function describeMonth(workouts: Workout[]): string {
  const perWeek = new Map<string, { sessions: number; volumeKg: number }>();
  for (const workout of workouts) {
    const week = localDateKey(startOfWeek(new Date(workout.startTime)));
    const bucket = perWeek.get(week) ?? { sessions: 0, volumeKg: 0 };
    bucket.sessions += 1;
    bucket.volumeKg += workoutVolumeKg(workout);
    perWeek.set(week, bucket);
  }
  const weeks = [...perWeek.entries()].sort(([a], [b]) => a.localeCompare(b));
  const lines = weeks.map(
    ([week, bucket]) =>
      `- week of ${week}: ${bucket.sessions} sessions, ${formatNumber(bucket.volumeKg, 0)} kg volume`,
  );
  const names = topExercises(workouts, 6);
  if (names.length > 0) lines.push(`Main exercises: ${names.join(', ')}`);
  return lines.join('\n');
}

/** Most frequently trained exercises, most frequent first. */
function topExercises(workouts: Workout[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const workout of workouts) {
    for (const name of workoutExerciseNames(workout)) {
      if (name === '') continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => `${name} (${count})`);
}

/** Facts about one exercise, used by the Reminder role and the Coach prompt. */
export function describeExerciseFacts(history: { dateKey: string; sets: SetEntry[] }[]): string {
  if (history.length === 0) return 'No recorded sessions.';
  const lines = history.map((entry) => {
    const top = bestSet(entry.sets);
    const weight = top?.weightKg != null ? `${formatNumber(fromKg(top.weightKg, top.unit), 1)}${top.unit}` : '—';
    return `- ${entry.dateKey}: ${describeSets(entry.sets)} · top set ${weight}`;
  });
  return lines.join('\n');
}
