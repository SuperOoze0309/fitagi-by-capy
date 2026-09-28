import type { SetEntry, Workout } from '../domain/types';
import { fromKg, roundDisplayWeight } from '../domain/units';
import { nowIso } from '../domain/datetime';
import { workingSets } from '../domain/metrics';
import { withSetWeight } from '../domain/workout';
import type { ExerciseRepository } from '../repositories/exerciseRepository';

/**
 * Outlier detection.
 *
 * Rule of the house: an outlier is *flagged*, never corrected. We never rewrite
 * 600 kg into 60 kg. The user can confirm, edit, or ignore — and the set is saved
 * either way.
 */
export interface AnomalyCheck {
  exerciseName: string;
  setId: string;
  value: number;
  unit: string;
  typicalLow: number;
  typicalHigh: number;
  message: string;
}

/** Below this many history points we stay quiet: there is no "typical" yet. */
const MIN_HISTORY_SESSIONS = 3;
/** Flag only when the value is clearly outside the historical band. */
const HIGH_FACTOR = 1.6;
const LOW_FACTOR = 0.4;

export async function findAnomalies(
  workout: Workout,
  exerciseRepository: ExerciseRepository,
): Promise<AnomalyCheck[]> {
  const findings: AnomalyCheck[] = [];

  for (const exercise of workout.exercises) {
    const name = exercise.normalizedName || exercise.rawName;
    if (!name) continue;
    const sets = workingSets(exercise.sets).filter((set) => set.weight !== null && set.weight > 0);
    if (sets.length === 0) continue;

    const history = await exerciseRepository.history(name);
    // Exclude the session being checked, otherwise editing an old workout would
    // always "confirm" its own numbers.
    const past = history.filter((row) => row.workoutId !== workout.id);
    if (past.length < MIN_HISTORY_SESSIONS) continue;

    const weights = past
      .flatMap((row) => workingSets(row.sets))
      .map((set) => set.weightKg)
      .filter((kg): kg is number => kg !== null && kg > 0)
      .sort((a, b) => a - b);
    if (weights.length < MIN_HISTORY_SESSIONS) continue;

    const median = weights[Math.floor(weights.length / 2)];
    const lowKg = median * LOW_FACTOR;
    const highKg = median * HIGH_FACTOR;

    for (const set of sets) {
      const kg = set.weightKg;
      if (kg === null) continue;
      const isHigh = kg > highKg;
      const isLow = kg < lowKg;
      if (!isHigh && !isLow) continue;

      const typicalLow = roundDisplayWeight(fromKg(lowKg, set.unit), set.unit);
      const typicalHigh = roundDisplayWeight(fromKg(highKg, set.unit), set.unit);
      const medianDisplay = roundDisplayWeight(fromKg(median, set.unit), set.unit);

      findings.push({
        exerciseName: name,
        setId: set.id,
        value: set.weight ?? 0,
        unit: set.unit,
        typicalLow,
        typicalHigh,
        message: isHigh
          ? `${name}: ${format(set.weight)} ${set.unit} is well above your usual ${format(
              medianDisplay,
            )} ${set.unit}. Confirm?`
          : `${name}: ${format(set.weight)} ${set.unit} is well below your usual ${format(
              medianDisplay,
            )} ${set.unit}. Confirm?`,
      });
    }
  }

  return findings;
}

function format(value: number | null): string {
  if (value === null) return '—';
  return String(Number(value.toFixed(2)));
}

/** Names of exercises present in a workout, used for compact History rows. */
export function exerciseNamesOf(workout: Workout): string {
  const names = workout.exercises.map((exercise) => exercise.normalizedName || exercise.rawName);
  const unique = [...new Set(names.filter((name) => name !== ''))];
  return unique.join(', ');
}

export function setHasData(set: SetEntry): boolean {
  return (
    set.weight !== null ||
    set.reps !== null ||
    set.durationSec !== null ||
    set.distance !== null ||
    set.notes.trim() !== ''
  );
}

/**
 * Apply the corrections the user accepted in `AnomalyReviewSheet`.
 *
 * Kept out of the component so the behaviour that matters is testable: only the
 * named sets change, `weightKg` is re-derived through `withSetWeight`, and a set the
 * user did not correct is left exactly as typed.
 */
export function applyWeightCorrections(
  workout: Workout,
  corrections: { setId: string; weight: number }[],
): { workout: Workout; applied: number } {
  if (corrections.length === 0) return { workout, applied: 0 };
  const bySetId = new Map(corrections.map((entry) => [entry.setId, entry.weight]));
  let applied = 0;

  const exercises = workout.exercises.map((exercise) => ({
    ...exercise,
    sets: exercise.sets.map((set) => {
      const weight = bySetId.get(set.id);
      if (weight === undefined) return set;
      applied += 1;
      // `withSetWeight` is the only place `weightKg` is derived, so a correction
      // can never leave the displayed value and the canonical value out of step.
      return withSetWeight(set, weight, set.unit);
    }),
  }));

  return { workout: { ...workout, exercises, updatedAt: nowIso() }, applied };
}
