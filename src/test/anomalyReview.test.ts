import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MemoryAdapter } from '@/test/MemoryAdapter';
import { initStorage, resetStorageForTests } from '@/storage';
import { initRepositories, repositories, resetRepositoriesForTests } from '@/repositories';
import {
  createExerciseEntry,
  createSetFromPrevious,
  createWorkout,
  withSetWeight,
} from '@/domain/workout';
import { applyWeightCorrections, findAnomalies, setHasData } from '@/services/validation';
import { toKg } from '@/domain/units';
import type { Workout } from '@/domain/types';

/** Log `count` completed sessions of `name` at `weight` kg. */
async function seed(count: number, name: string, weight: number): Promise<void> {
  const training = repositories().training;
  for (let index = 0; index < count; index += 1) {
    const workout = await training.put(createWorkout());
    const entry = createExerciseEntry(workout.id, name, 0);
    await training.upsertExercise(workout.id, {
      ...entry,
      sets: [
        withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, weight, 'kg'),
      ],
    });
    await training.complete(workout.id);
  }
}

/** A draft workout containing one exercise with one set at `weight`. */
async function draft(name: string, weight: number, unit: 'kg' | 'lb' = 'kg') {
  const workout = await repositories().training.put(createWorkout());
  const entry = createExerciseEntry(workout.id, name, 0);
  const set = withSetWeight({ ...createSetFromPrevious(undefined, unit), reps: 8 }, weight, unit);
  await repositories().training.upsertExercise(workout.id, { ...entry, sets: [set] });
  const stored = await repositories().training.get(workout.id);
  return { workout: stored as Workout, setId: set.id };
}

/**
 * The outlier rules from the product spec: flag it, never fix it, never block it.
 */
describe('outlier review', () => {
  beforeEach(async () => {
    resetStorageForTests();
    resetRepositoriesForTests();
    await initStorage(new MemoryAdapter());
    initRepositories();
  });

  afterEach(() => {
    resetStorageForTests();
    resetRepositoriesForTests();
  });

  it('flags a bench of 600 kg against a 60-80 kg history', async () => {
    await seed(5, 'Bench Press', 70);
    const { workout } = await draft('Bench Press', 600);

    const findings = await findAnomalies(workout, repositories().exercises);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.value, 600);
    assert.match(findings[0]?.message ?? '', /above your usual/);
    // The typical band is reported so the user can judge for themselves.
    assert.ok((findings[0]?.typicalHigh ?? 0) > 70);
  });

  it('flags an implausibly light set too', async () => {
    await seed(5, 'Squat', 100);
    const { workout } = await draft('Squat', 10);

    const findings = await findAnomalies(workout, repositories().exercises);
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /below your usual/);
  });

  it('allows saving without any correction', async () => {
    await seed(5, 'Bench Press', 70);
    const { workout } = await draft('Bench Press', 600);

    // Simulates "Keep as typed": no corrections are applied at all.
    const { applied } = applyWeightCorrections(workout, []);
    assert.equal(applied, 0);

    const finished = await repositories().training.complete(workout.id);
    const stored = await repositories().training.get(finished.id);
    assert.equal(
      stored?.exercises[0]?.sets[0]?.weight,
      600,
      'the number the user typed is preserved exactly',
    );
  });

  it('applies a correction without touching other sets', async () => {
    await seed(5, 'Bench Press', 70);
    const training = repositories().training;
    const workout = await training.put(createWorkout());
    const entry = createExerciseEntry(workout.id, 'Bench Press', 0);
    const normal = withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 70, 'kg');
    const odd = withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 600, 'kg');
    await training.upsertExercise(workout.id, { ...entry, sets: [normal, odd] });

    const draftWorkout = (await training.get(workout.id)) as Workout;
    const findings = await findAnomalies(draftWorkout, repositories().exercises);
    assert.equal(findings.length, 1, 'only the odd set is flagged');
    assert.equal(findings[0]?.setId, odd.id);

    const { workout: corrected, applied } = applyWeightCorrections(draftWorkout, [
      { setId: odd.id, weight: 60 },
    ]);
    assert.equal(applied, 1);

    const sets = corrected.exercises[0]!.sets;
    assert.equal(sets[0]!.weight, 70, 'the untouched set is unchanged');
    assert.equal(sets[1]!.weight, 60, 'the correction is applied');
    // The canonical value must follow the displayed value.
    assert.equal(sets[1]!.weightKg, 60);
  });

  it('keeps weightKg consistent when correcting in pounds', async () => {
    const training = repositories().training;
    await seed(5, 'Leg Press', 200);

    const workout = await training.put(createWorkout());
    const entry = createExerciseEntry(workout.id, 'Leg Press', 0);
    const set = withSetWeight(
      { ...createSetFromPrevious(undefined, 'lb'), reps: 8 },
      5770,
      'lb',
    );
    await training.upsertExercise(workout.id, { ...entry, sets: [set] });
    const draftWorkout = (await training.get(workout.id)) as Workout;

    const { workout: corrected } = applyWeightCorrectionsForTest(draftWorkout, set.id, 577);
    const fixed = corrected.exercises[0]!.sets[0]!;
    assert.equal(fixed.weight, 577);
    assert.equal(fixed.unit, 'lb', 'the unit the user chose is preserved');
    assert.equal(fixed.weightKg, toKg(577, 'lb'));
  });

  it('ignores a correction for a set that is not in the workout', async () => {
    const { workout } = await draft('Bench Press', 60);
    const { applied, workout: corrected } = applyWeightCorrections(workout, [
      { setId: 'does-not-exist', weight: 999 },
    ]);
    assert.equal(applied, 0);
    assert.equal(corrected.exercises[0]?.sets[0]?.weight, 60);
  });

  it('does not flag a normal session, so the common path has nothing to review', async () => {
    await seed(5, 'Bench Press', 70);
    const { workout } = await draft('Bench Press', 72.5);
    assert.deepEqual(await findAnomalies(workout, repositories().exercises), []);
  });

  it('stays quiet when there is not enough history to have a "usual"', async () => {
    await seed(2, 'Bench Press', 70);
    const { workout } = await draft('Bench Press', 600);
    assert.deepEqual(await findAnomalies(workout, repositories().exercises), []);
  });

  it('does not flag a workout against itself', async () => {
    // Editing an existing workout must not treat its own 600 kg as the baseline.
    await seed(5, 'Bench Press', 70);
    const training = repositories().training;
    const workout = await training.put(createWorkout());
    const entry = createExerciseEntry(workout.id, 'Bench Press', 0);
    await training.upsertExercise(workout.id, {
      ...entry,
      sets: [
        withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 600, 'kg'),
      ],
    });
    await training.complete(workout.id);

    const stored = (await training.get(workout.id)) as Workout;
    const findings = await findAnomalies(stored, repositories().exercises);
    assert.equal(findings.length, 1, 'flagged against the older history, not skipped');
    const median = 70;
    assert.ok((findings[0]?.typicalHigh ?? 0) < 600 && (findings[0]?.typicalHigh ?? 0) >= median);
  });

  it('recognises which sets carry data', () => {
    const empty = createSetFromPrevious(undefined, 'kg');
    assert.equal(setHasData(empty), false);
    assert.equal(setHasData({ ...empty, reps: 0 }), true, 'a logged zero rep is still data');
    assert.equal(setHasData({ ...empty, notes: ' ' }), false);
    assert.equal(setHasData({ ...empty, notes: 'left side only' }), true);
  });
});

/** Small helper so the pound test reads cleanly. */
function applyWeightCorrectionsForTest(workout: Workout, setId: string, weight: number) {
  return applyWeightCorrections(workout, [{ setId, weight }]);
}
