import type { ExerciseEntry, SetEntry, Workout } from './types';

/** Working-set volume in kg: reps × weight. Warmups and unweighted sets count as 0. */
export function setVolumeKg(set: SetEntry): number {
  if (set.isWarmup) return 0;
  if (set.weightKg === null || set.reps === null) return 0;
  return set.weightKg * set.reps;
}

export function exerciseVolumeKg(exercise: ExerciseEntry): number {
  return exercise.sets.reduce((sum, set) => sum + setVolumeKg(set), 0);
}

export function workoutVolumeKg(workout: Workout): number {
  return workout.exercises.reduce((sum, ex) => sum + exerciseVolumeKg(ex), 0);
}

/** Only "working" sets: not warmup, and actually carrying reps or a weight. */
export function workingSets(sets: SetEntry[]): SetEntry[] {
  return sets.filter((s) => !s.isWarmup && (s.reps !== null || s.weight !== null));
}

export function countWorkingSets(workout: Workout): number {
  return workout.exercises.reduce((sum, ex) => sum + workingSets(ex.sets).length, 0);
}

export function countCompletedSets(workout: Workout): number {
  return workout.exercises.reduce(
    (sum, ex) => sum + ex.sets.filter((s) => s.reps !== null || s.weight !== null).length,
    0,
  );
}

/**
 * Epley estimate, kg. Returns null when the set has no weight or no reps.
 * One-rep sets are returned as-is (Epley is not meaningful at 1 rep).
 */
export function estimateOneRepMaxKg(set: SetEntry): number | null {
  if (set.weightKg === null || set.reps === null || set.reps <= 0) return null;
  if (set.reps === 1) return set.weightKg;
  return set.weightKg * (1 + set.reps / 30);
}

export function bestSet(sets: SetEntry[]): SetEntry | null {
  let best: SetEntry | null = null;
  let bestOneRm = -1;
  for (const set of workingSets(sets)) {
    const oneRm = estimateOneRepMaxKg(set);
    if (oneRm !== null && oneRm > bestOneRm) {
      bestOneRm = oneRm;
      best = set;
    }
  }
  return best;
}

/** "60kg × 8 × 4" style set list, collapsed for compact display. */
export function summarizeSets(sets: SetEntry[]): string {
  const working = workingSets(sets);
  if (working.length === 0) return 'no sets';
  const first = working[0];
  const weight = first.weight;
  const unit = first.unit;
  const sameWeight = working.every((s) => s.weight === weight && s.unit === unit);
  const reps = working.map((s) => s.reps ?? 0);

  if (sameWeight && weight !== null) {
    const sameReps = reps.every((r) => r === reps[0]);
    const repsText = sameReps ? String(reps[0]) : reps.join('/');
    return `${trim(weight)}${unit} × ${repsText} × ${working.length}`;
  }
  return working
    .map((s) => `${s.weight !== null ? trim(s.weight) + s.unit : '—'} × ${s.reps ?? '—'}`)
    .join(', ');
}

function trim(n: number): string {
  return String(Number(n.toFixed(2)));
}

/** Seconds between two ISO timestamps, floored at 0. */
export function secondsBetween(startIso: string, endIso: string): number {
  return Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
}
