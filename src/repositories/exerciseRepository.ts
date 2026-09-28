import type { ExerciseEntry, SetEntry, Workout } from '../domain/types';
import { localDateKey } from '../domain/datetime';
import { bestSet, countWorkingSets, exerciseVolumeKg, workingSets } from '../domain/metrics';
import { exerciseGroupKey } from '../domain/workout';
import type { TrainingRepository } from './trainingRepository';

/** One occurrence of an exercise inside one workout. */
export interface ExerciseHistoryEntry {
  workoutId: string;
  date: Date;
  dateKey: string;
  workoutDurationSec: number;
  sets: SetEntry[];
  workingSetCount: number;
  volumeKg: number;
  bestSet: SetEntry | null;
  /**
   * True when this session's best set is the heaviest ever recorded for the
   * exercise up to and including this session.
   *
   * Deliberately based on weight, not estimated 1RM: a PR badge is a claim about
   * what the user actually lifted, and it should not appear because a light
   * high-rep set happened to score well on an estimate.
   */
  isPersonalBest: boolean;
  /** Increase in the best set's weight versus the previous session, in kg. */
  bestWeightDeltaKg: number | null;
  /** Heaviest weight recorded for this exercise before this session, in kg. */
  previousBestKg: number | null;
}

export interface ExerciseSummary {
  /** Display name, as written the most recent time the user logged it. */
  name: string;
  /** Lower-cased grouping key. */
  key: string;
  sessionCount: number;
  totalWorkingSets: number;
  lastPerformed: Date;
  /** Best estimated 1RM over all sessions, in kg — enough for a Phase 1 "PR" hint. */
  bestWeightKg: number | null;
  bestReps: number | null;
  /** When the current heaviest set was recorded. */
  bestWeightDateKey: string | null;
  /** How many sessions have set a new heaviest weight. */
  personalBestCount: number;
}

/** A previously used exercise name, offered as a quick-add suggestion. */
export interface ExerciseSuggestion {
  name: string;
  lastUsed: Date;
  useCount: number;
}

/**
 * Exercise-centric queries derived from workout history.
 *
 * Phase 1 intentionally computes these by folding over the stored workouts: a
 * realistic local history is a few thousand sessions at most, and this keeps the
 * storage schema trivial. If it ever becomes slow, this class is the single
 * place to add a materialized index.
 */
export class ExerciseRepository {
  constructor(private readonly training: TrainingRepository) {}

  /** All distinct exercise names the user has ever logged, most recent first. */
  async suggestions(limit = 50): Promise<ExerciseSuggestion[]> {
    const workouts = await this.training.all();
    const map = new Map<string, ExerciseSuggestion>();

    for (const workout of workouts) {
      for (const exercise of workout.exercises) {
        const name = exercise.normalizedName || exercise.rawName;
        if (!name) continue;
        const key = exerciseGroupKey(name);
        const existing = map.get(key);
        const startedAt = new Date(workout.startTime);
        if (!existing) {
          map.set(key, { name, lastUsed: startedAt, useCount: 1 });
          continue;
        }
        existing.useCount += 1;
        if (startedAt.getTime() > existing.lastUsed.getTime()) {
          existing.lastUsed = startedAt;
          existing.name = name;
        }
      }
    }

    return [...map.values()]
      .sort((a, b) => b.lastUsed.getTime() - a.lastUsed.getTime())
      .slice(0, limit);
  }

  /** Names matching a partial query, for the exercise picker. */
  async search(query: string, limit = 20): Promise<ExerciseSuggestion[]> {
    const needle = query.trim().toLowerCase();
    const all = await this.suggestions(500);
    if (needle === '') return all.slice(0, limit);
    return all
      .filter((suggestion) => suggestion.name.toLowerCase().includes(needle))
      .slice(0, limit);
  }

  /**
   * Every session that contains the given exercise, newest first, each annotated
   * with whether it set a personal best and how it compared to the one before it.
   *
   * PR flags are computed oldest-to-newest so "personal best" means "heaviest ever
   * up to that session" rather than "heaviest overall" — otherwise every row would
   * be checked against the user's current maximum and only one would ever qualify.
   */
  async history(name: string): Promise<ExerciseHistoryEntry[]> {
    const key = exerciseGroupKey(name);
    const workouts = await this.training.all();
    const rows: ExerciseHistoryEntry[] = [];

    for (const workout of workouts) {
      const matches = workout.exercises.filter(
        (exercise) => exerciseGroupKey(exercise.normalizedName || exercise.rawName) === key,
      );
      if (matches.length === 0) continue;
      const sets = matches.flatMap((exercise) => exercise.sets);
      rows.push({
        workoutId: workout.id,
        date: new Date(workout.startTime),
        dateKey: localDateKey(workout.startTime),
        workoutDurationSec: workout.durationSec,
        sets,
        workingSetCount: countWorkingSets({ ...workout, exercises: matches }),
        volumeKg: matches.reduce((sum, exercise) => sum + exerciseVolumeKg(exercise), 0),
        bestSet: bestSet(sets),
        isPersonalBest: false,
        bestWeightDeltaKg: null,
        previousBestKg: null,
      });
    }

    // Oldest first while annotating, then back to newest-first for display.
    const chronological = [...rows].sort((a, b) => a.date.getTime() - b.date.getTime());
    let runningBest: number | null = null;
    let previousSessionBest: number | null = null;

    for (const row of chronological) {
      const heavy = workingSets(row.sets).reduce<number | null>((max, set) => {
        if (set.weightKg === null) return max;
        return max === null || set.weightKg > max ? set.weightKg : max;
      }, null);

      row.previousBestKg = runningBest;
      if (heavy !== null) {
        // Strictly heavier: matching your best again is not a new PR.
        row.isPersonalBest = runningBest === null || heavy > runningBest;
        if (runningBest === null || heavy > runningBest) runningBest = heavy;
      }
      row.bestWeightDeltaKg =
        heavy !== null && previousSessionBest !== null ? heavy - previousSessionBest : null;
      if (heavy !== null) previousSessionBest = heavy;
    }

    return rows.sort((a, b) => b.date.getTime() - a.date.getTime());
  }

  async summary(name: string): Promise<ExerciseSummary | null> {
    const rows = await this.history(name);
    if (rows.length === 0) return null;

    let bestWeightKg: number | null = null;
    let bestReps: number | null = null;
    let bestWeightDateKey: string | null = null;
    let totalWorkingSets = 0;
    let personalBestCount = 0;

    for (const row of rows) {
      totalWorkingSets += row.workingSetCount;
      if (row.isPersonalBest) personalBestCount += 1;
      for (const set of workingSets(row.sets)) {
        if (set.weightKg === null) continue;
        if (bestWeightKg === null || set.weightKg > bestWeightKg) {
          bestWeightKg = set.weightKg;
          bestReps = set.reps;
          bestWeightDateKey = row.dateKey;
        }
      }
    }

    return {
      name,
      key: exerciseGroupKey(name),
      sessionCount: rows.length,
      totalWorkingSets,
      lastPerformed: rows[0].date,
      bestWeightKg,
      bestReps,
      bestWeightDateKey,
      personalBestCount,
    };
  }

  /** Flat list of (exercise, set) pairs used by search and Phase 2 features. */
  async allSetsByName(name: string): Promise<SetEntry[]> {
    const rows = await this.history(name);
    return rows.flatMap((row) => row.sets);
  }
}

export function exerciseDisplayName(exercise: ExerciseEntry): string {
  return exercise.normalizedName || exercise.rawName;
}

export function workoutExerciseNames(workout: Workout): string[] {
  return workout.exercises.map(exerciseDisplayName);
}
