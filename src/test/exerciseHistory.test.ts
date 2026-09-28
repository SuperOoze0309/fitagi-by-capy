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
import { localDateKey } from '@/domain/datetime';
import { formatNumber, fromKg, roundDisplayWeight } from '@/domain/units';

/**
 * Exercise-centric history: what the `/exercise/:name` page renders, and the
 * rename flow that teaches the app an alias.
 */
describe('exercise history page data', () => {
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

  /** Log one session of `name` with the given sets, and finish it. */
  async function session(
    name: string,
    sets: { weight: number; reps: number; unit?: 'kg' | 'lb' }[],
    startedAt?: string,
  ) {
    const training = repositories().training;
    const workout = await training.put({
      ...createWorkout(),
      ...(startedAt ? { startTime: startedAt } : {}),
    });
    const exercise = createExerciseEntry(workout.id, name, 0);
    await training.upsertExercise(workout.id, {
      ...exercise,
      sets: sets.map((spec) =>
        withSetWeight(
          { ...createSetFromPrevious(undefined, spec.unit ?? 'kg'), reps: spec.reps },
          spec.weight,
          spec.unit ?? 'kg',
        ),
      ),
    });
    return training.complete(workout.id);
  }

  it('lists every session newest first with volume and best set', async () => {
    const day = (offset: number) =>
      new Date(Date.now() - offset * 86_400_000).toISOString();
    const oldest = await session('Bench Press', [{ weight: 60, reps: 8 }], day(2));
    const middle = await session('Bench Press', [{ weight: 62.5, reps: 8 }], day(1));
    const latest = await session('Bench Press', [{ weight: 65, reps: 6 }], day(0));

    const page = await repositories().exercises.history('Bench Press');
    assert.equal(page.length, 3);
    assert.deepEqual(
      page.map((row) => row.workoutId),
      [latest.id, middle.id, oldest.id],
      'newest session first',
    );

    const newest = page[0]!;
    assert.equal(newest.workingSetCount, 1);
    assert.equal(newest.volumeKg, 65 * 6);
    assert.equal(newest.bestSet?.weight, 65);
    assert.equal(newest.dateKey, localDateKey(newest.date));
    assert.ok(newest.workoutDurationSec >= 0);
  });

  it('summarises the exercise for the header stats', async () => {
    await session('Squat', [{ weight: 100, reps: 5 }]);
    await session('Squat', [
      { weight: 110, reps: 5 },
      { weight: 110, reps: 3 },
    ]);

    const summary = await repositories().exercises.summary('Squat');
    assert.equal(summary?.sessionCount, 2);
    assert.equal(summary?.totalWorkingSets, 3);
    assert.equal(summary?.bestWeightKg, 110);
    assert.equal(summary?.bestReps, 5);
    assert.equal(summary?.name, 'Squat');
  });

  it('renders weights in the display unit without touching stored values', async () => {
    await session('Leg Press', [{ weight: 577, reps: 8, unit: 'lb' }]);

    const [row] = await repositories().exercises.history('Leg Press');
    const stored = row!.sets[0]!;
    assert.equal(stored.weight, 577, 'the entered number and unit are preserved');
    assert.equal(stored.unit, 'lb');

    const asLb = roundDisplayWeight(fromKg(stored.weightKg!, 'lb'), 'lb');
    const asKg = roundDisplayWeight(fromKg(stored.weightKg!, 'kg'), 'kg');
    assert.equal(formatNumber(asLb), '577', 'reads back as 577 lb');
    assert.equal(formatNumber(asKg), '261.5', 'and 261.5 kg in metric');
  });

  it('returns nothing for an exercise that was never logged', async () => {
    assert.deepEqual(await repositories().exercises.history('unknown lift'), []);
    assert.equal(await repositories().exercises.summary('unknown lift'), null);
  });
});

describe('teaching the app an alias by renaming', () => {
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

  it('does not change history, but renames every later entry', async () => {
    const training = repositories().training;
    const rules = repositories().rules;

    // Session 1: the user writes "bench" and leaves it as-is.
    const first = await training.put(createWorkout());
    const firstEntry = createExerciseEntry(first.id, 'bench', 0);
    await training.upsertExercise(first.id, {
      ...firstEntry,
      sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 60, 'kg')],
    });
    await training.complete(first.id);

    // The user renames it in session 2 and asks to remember the rule.
    const second = await training.put(createWorkout());
    const secondEntry = createExerciseEntry(second.id, 'bench', 0);
    const renamed = 'Bench Press';
    await training.upsertExercise(second.id, {
      ...secondEntry,
      rawName: renamed,
      normalizedName: renamed,
      sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 62.5, 'kg')],
    });
    await rules.save({ match: 'bench', normalized: renamed });
    await training.complete(second.id);

    // History is untouched: session 1 still reads "bench".
    const untouched = await training.get(first.id);
    assert.equal(untouched?.exercises[0]?.rawName, 'bench');
    assert.equal(untouched?.exercises[0]?.normalizedName, 'bench');

    // A later entry goes through the rule and lands on the canonical name.
    assert.equal(await rules.resolve('bench'), renamed);
    assert.equal(await rules.resolve('BENCH'), renamed);

    const third = await training.put(createWorkout());
    const typed = createExerciseEntry(third.id, 'bench', 0);
    const resolved = (await rules.resolve(typed.rawName)) ?? typed.rawName;
    await training.upsertExercise(third.id, {
      ...typed,
      normalizedName: resolved,
      sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 65, 'kg')],
    });
    await training.complete(third.id);

    // Session 2 and 3 group under the canonical name; session 1 stays separate.
    const canonical = await repositories().exercises.history('Bench Press');
    assert.equal(canonical.length, 2, 'renamed and rule-resolved sessions share one history');
    assert.deepEqual(
      canonical.map((row) => row.bestSet?.weight).sort((a, b) => (a ?? 0) - (b ?? 0)),
      [62.5, 65],
    );

    const original = await repositories().exercises.history('bench');
    assert.equal(original.length, 1, 'the untouched session keeps its own name');
  });

  it('lets a rule be edited and removed', async () => {
    const rules = repositories().rules;
    const saved = await rules.save({ match: 'ohp', normalized: 'Overhead Press' });
    assert.equal(await rules.resolve('ohp'), 'Overhead Press');

    await rules.save({ id: saved.id, match: 'ohp', normalized: 'Standing Overhead Press' });
    assert.equal(await rules.count(), 1, 'editing updates instead of duplicating');
    assert.equal(await rules.resolve('ohp'), 'Standing Overhead Press');

    await rules.remove(saved.id);
    assert.equal(await rules.resolve('ohp'), null, 'removing the rule restores the raw name');
  });
});
