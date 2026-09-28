import type { ExerciseEntry, SetEntry, WeightUnit, Workout } from './types';
import { newExerciseEntryId, newSetId, newWorkoutId } from './ids';
import { nowIso } from './datetime';
import { toKg } from './units';

/**
 * Exercise name normalization for Phase 1.
 *
 * No giant built-in exercise library and no hardcoded mappings: we only
 * canonicalize whitespace/case so that "Barbell  Bench Press" and
 * "barbell bench press" group together. User alias rules (Phase 2) and the LLM
 * (Phase 3) can suggest a nicer canonical name later — the user always wins.
 */
export function normalizeExerciseName(rawName: string): string {
  return rawName.trim().replace(/\s+/g, ' ');
}

export function exerciseGroupKey(name: string): string {
  return normalizeExerciseName(name).toLowerCase();
}

export function createEmptySet(unit: WeightUnit = 'kg'): SetEntry {
  return {
    id: newSetId(),
    weight: null,
    weightKg: null,
    unit,
    reps: null,
    durationSec: null,
    distance: null,
    distanceUnit: null,
    restSec: null,
    rpe: null,
    rir: null,
    isFailure: false,
    isWarmup: false,
    isDropSet: false,
    notes: '',
  };
}

/** New set that copies weight/reps/unit from the previous set, for fast logging. */
export function createSetFromPrevious(previous: SetEntry | undefined, fallbackUnit: WeightUnit): SetEntry {
  if (!previous) return createEmptySet(fallbackUnit);
  return {
    ...createEmptySet(previous.unit ?? fallbackUnit),
    weight: previous.weight,
    weightKg: previous.weightKg,
    reps: previous.reps,
    rpe: previous.rpe,
    rir: previous.rir,
    restSec: previous.restSec,
  };
}

export function createExerciseEntry(
  workoutId: string,
  rawName: string,
  order: number,
): ExerciseEntry {
  return {
    id: newExerciseEntryId(),
    workoutId,
    rawName: normalizeExerciseName(rawName),
    normalizedName: normalizeExerciseName(rawName),
    order,
    notes: '',
    sets: [],
    supersetGroup: null,
  };
}

export function createWorkout(): Workout {
  const timestamp = nowIso();
  return {
    id: newWorkoutId(),
    startTime: timestamp,
    endTime: null,
    durationSec: 0,
    notes: '',
    heartRate: null,
    exercises: [],
    completed: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Keep derived weight fields consistent: whenever a set's display weight or
 * unit changes, recompute `weightKg`. This is the single place that writes it.
 */
export function withSetWeight(set: SetEntry, weight: number | null, unit: WeightUnit): SetEntry {
  return {
    ...set,
    weight,
    unit,
    weightKg: weight === null ? null : toKg(weight, unit),
  };
}

/** Reassign contiguous `order` values after an insert/remove/move. */
export function resequenceExercises(exercises: ExerciseEntry[]): ExerciseEntry[] {
  return exercises.map((exercise, index) => ({ ...exercise, order: index }));
}
