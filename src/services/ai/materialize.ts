import type { ExerciseEntry, SetEntry, WeightUnit, Workout } from '../../domain/types';
import { nowIso } from '../../domain/datetime';
import { createExerciseEntry, createSetFromPrevious, normalizeExerciseName, withSetWeight } from '../../domain/workout';
import type { Repositories } from '../../repositories';
import type { ParsedWorkoutDraft } from './provider';

/**
 * Turning a confirmed draft into real records.
 *
 * This is the only place a parsed draft becomes stored data, and it runs *after*
 * the user confirms. Keeping it separate from the parser is what makes "the model
 * never writes to your log by itself" a structural property rather than a promise:
 * the parser cannot reach storage at all.
 */
export interface MaterializeResult {
  workout: Workout;
  exerciseCount: number;
  setCount: number;
}

/**
 * Build the workout from a draft.
 *
 * `workout` supplies identity and timing: pass the in-progress workout to append,
 * or a fresh `createWorkout()` to start a new session.
 */
export async function materializeDraft(
  draft: ParsedWorkoutDraft,
  workout: Workout,
  repos: Repositories,
): Promise<MaterializeResult> {
  const exercises: ExerciseEntry[] = [...workout.exercises];
  let setCount = 0;

  for (const parsed of draft.exercises) {
    const name = normalizeExerciseName(parsed.rawName);
    if (name === '') continue;

    // A user rule decides the display name; otherwise the typed name is kept.
    const fromRule = await repos.rules.resolve(name);
    const normalizedName = fromRule ?? name;

    const entry = createExerciseEntry(workout.id, name, exercises.length);
    const sets: SetEntry[] = parsed.sets.map((parsedSet) =>
      withSetWeight(
        {
          ...createSetFromPrevious(undefined, parsedSet.unit),
          reps: parsedSet.reps === null ? null : Math.max(0, Math.round(parsedSet.reps)),
          rpe: parsedSet.rpe,
          rir: parsedSet.rir,
          isFailure: parsedSet.isFailure,
          isWarmup: parsedSet.isWarmup,
          isDropSet: parsedSet.isDropSet,
        },
        parsedSet.weight,
        parsedSet.unit,
      ),
    );
    setCount += sets.length;

    exercises.push({ ...entry, normalizedName, sets });
  }

  const notes = [workout.notes.trim(), draft.notes.trim()].filter((part) => part !== '').join('\n');

  const next: Workout = {
    ...workout,
    exercises,
    notes,
    updatedAt: nowIso(),
  };

  return { workout: next, exerciseCount: draft.exercises.length, setCount };
}

/**
 * Read a confirmed draft back out of an editable preview.
 *
 * The preview lets the user fix the parser before anything is stored, so the shape
 * it edits is the same shape that gets materialized.
 */
export interface EditablePreviewSet {
  id: string;
  weight: number | null;
  unit: WeightUnit;
  reps: number | null;
  rpe: number | null;
  isFailure: boolean;
  isWarmup: boolean;
  isDropSet: boolean;
  /** Unchecked sets are dropped on save. */
  include: boolean;
}

export interface EditablePreviewExercise {
  id: string;
  rawName: string;
  normalizedName: string;
  sets: EditablePreviewSet[];
  include: boolean;
  /** Suggestion the user has not accepted yet. */
  suggestion: { suggested: string; reason: string; fromUserRule: boolean } | null;
}

/** Convert a parsed draft into the editable preview model. */
export function draftToPreview(
  draft: ParsedWorkoutDraft,
  suggestions: { rawName: string; suggested: string; reason: string; fromUserRule: boolean }[],
  idFactory: (prefix: string) => string,
): EditablePreviewExercise[] {
  return draft.exercises.map((exercise) => {
    const suggestion = suggestions.find(
      (item) => item.rawName.toLowerCase() === exercise.rawName.toLowerCase(),
    );
    return {
      id: idFactory('pe'),
      rawName: exercise.rawName,
      normalizedName: suggestion?.suggested ?? exercise.rawName,
      include: true,
      suggestion: suggestion
        ? {
            suggested: suggestion.suggested,
            reason: suggestion.reason,
            fromUserRule: suggestion.fromUserRule,
          }
        : null,
      sets: exercise.sets.map((set) => ({
        id: idFactory('ps'),
        weight: set.weight,
        unit: set.unit,
        reps: set.reps,
        rpe: set.rpe,
        isFailure: set.isFailure,
        isWarmup: set.isWarmup,
        isDropSet: set.isDropSet,
        include: true,
      })),
    };
  });
}

/** Convert the (possibly edited) preview back into a draft for materialization. */
export function previewToDraft(
  exercises: EditablePreviewExercise[],
  notes: string,
  source: ParsedWorkoutDraft['source'],
): ParsedWorkoutDraft {
  const kept = exercises.filter((exercise) => exercise.include && exercise.rawName.trim() !== '');
  return {
    exercises: kept.map((exercise) => ({
      rawName: exercise.rawName.trim(),
      sets: exercise.sets
        .filter((set) => set.include)
        .map((set) => ({
          weight: set.weight,
          unit: set.unit,
          reps: set.reps,
          rpe: set.rpe,
          rir: null,
          isFailure: set.isFailure,
          isWarmup: set.isWarmup,
          isDropSet: set.isDropSet,
        })),
    })),
    notes,
    warnings: [],
    source,
    unparsed: '',
  };
}

/** One-line description of what will be written, for the confirm button. */
export function describePreview(exercises: EditablePreviewExercise[]): string {
  const keptExercises = exercises.filter((exercise) => exercise.include);
  const sets = keptExercises.reduce(
    (sum, exercise) => sum + exercise.sets.filter((set) => set.include).length,
    0,
  );
  return `${keptExercises.length} ${keptExercises.length === 1 ? 'exercise' : 'exercises'} · ${sets} ${
    sets === 1 ? 'set' : 'sets'
  }`;
}
