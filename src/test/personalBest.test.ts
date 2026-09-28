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
import { toKg } from '@/domain/units';

/** Record a session of `name` at `weights` (kg), on a given local date. */
async function session(name: string, date: string, weights: number[]): Promise<string> {
  const training = repositories().training;
  const base = createWorkout();
  const startTime = new Date(`${date}T09:00:00`).toISOString();
  const endTime = new Date(`${date}T10:00:00`).toISOString();
  const workout = await training.put({ ...base, startTime, endTime, createdAt: startTime });
  const entry = createExerciseEntry(workout.id, name, 0);
  await training.upsertExercise(workout.id, {
    ...entry,
    sets: weights.map((weight) =>
      withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 5 }, weight, 'kg'),
    ),
  });
  await training.complete(workout.id);
  return workout.id;
}

/**
 * Personal-best marking on the exercise history.
 *
 * The rule that matters: a PR is "heaviest ever *up to that session*", not
 * "heaviest overall" — otherwise only one row in the whole history could ever be
 * marked, which is useless for reading progress.
 */
describe('exercise personal bests', () => {
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

  it('marks each new heaviest session, oldest to newest', async () => {
    await session('Bench Press', '2026-03-02', [60]);
    await session('Bench Press', '2026-03-04', [65]);
    await session('Bench Press', '2026-03-06', [62]);
    await session('Bench Press', '2026-03-08', [70]);

    const history = await repositories().exercises.history('Bench Press');
    // Newest first for display.
    assert.deepEqual(
      history.map((row) => ({ date: row.dateKey, pr: row.isPersonalBest })),
      [
        { date: '2026-03-08', pr: true },
        { date: '2026-03-06', pr: false },
        { date: '2026-03-04', pr: true },
        { date: '2026-03-02', pr: true },
      ],
    );
  });

  it('does not call matching your previous best a new PR', async () => {
    await session('Squat', '2026-03-02', [100]);
    await session('Squat', '2026-03-04', [100]);

    const history = await repositories().exercises.history('Squat');
    assert.equal(history[0]?.isPersonalBest, false, 'equalling a best is not beating it');
    assert.equal(history[1]?.isPersonalBest, true);
  });

  it('takes the heaviest set within a session, not the first', async () => {
    await session('Deadlift', '2026-03-02', [80, 100, 90]);
    const history = await repositories().exercises.history('Deadlift');
    assert.equal(history[0]?.isPersonalBest, true);
    assert.equal(history[0]?.bestSet?.weight, 100);
  });

  it('ignores warmups when deciding a best', async () => {
    const training = repositories().training;
    const base = createWorkout();
    const startTime = new Date('2026-03-02T09:00:00').toISOString();
    const workout = await training.put({ ...base, startTime, createdAt: startTime });
    const entry = createExerciseEntry(workout.id, 'Press', 0);
    await training.upsertExercise(workout.id, {
      ...entry,
      sets: [
        withSetWeight(
          { ...createSetFromPrevious(undefined, 'kg'), reps: 10, isWarmup: true },
          200,
          'kg',
        ),
        withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 5 }, 60, 'kg'),
      ],
    });
    await training.complete(workout.id);

    const history = await repositories().exercises.history('Press');
    assert.equal(history[0]?.bestSet?.weight, 60, 'the warmup is not the best set');
  });

  it('reports the delta against the previous session, positive or negative', async () => {
    await session('Row', '2026-03-02', [50]);
    await session('Row', '2026-03-04', [55]);
    await session('Row', '2026-03-06', [52]);

    const history = await repositories().exercises.history('Row');
    assert.equal(history[0]?.bestWeightDeltaKg, -3, 'down 3 kg from the previous session');
    assert.equal(history[1]?.bestWeightDeltaKg, 5, 'up 5 kg');
    assert.equal(history[2]?.bestWeightDeltaKg, null, 'the first session has nothing to compare to');
  });

  it('reports the previous best on each row', async () => {
    await session('Curl', '2026-03-02', [20]);
    await session('Curl', '2026-03-04', [25]);

    const history = await repositories().exercises.history('Curl');
    assert.equal(history[0]?.previousBestKg, 20);
    assert.equal(history[1]?.previousBestKg, null);
  });

  it('summarises how many PRs there were and when the best was set', async () => {
    await session('Bench Press', '2026-03-02', [60]);
    await session('Bench Press', '2026-03-04', [65]);
    await session('Bench Press', '2026-03-06', [63]);

    const summary = await repositories().exercises.summary('Bench Press');
    assert.equal(summary?.personalBestCount, 2);
    assert.equal(summary?.bestWeightKg, 65);
    assert.equal(summary?.bestWeightDateKey, '2026-03-04');
    assert.equal(summary?.sessionCount, 3);
  });

  it('compares across kg and lb on the canonical value', async () => {
    const training = repositories().training;
    // 100 kg first…
    await session('Leg Press', '2026-03-02', [100]);

    // …then 230 lb, which is 104.3 kg: a PR even though "230" reads smaller than
    // the numbers used elsewhere.
    const base = createWorkout();
    const startTime = new Date('2026-03-04T09:00:00').toISOString();
    const workout = await training.put({ ...base, startTime, createdAt: startTime });
    const entry = createExerciseEntry(workout.id, 'Leg Press', 0);
    await training.upsertExercise(workout.id, {
      ...entry,
      sets: [
        withSetWeight({ ...createSetFromPrevious(undefined, 'lb'), reps: 5 }, 230, 'lb'),
      ],
    });
    await training.complete(workout.id);

    const history = await repositories().exercises.history('Leg Press');
    assert.equal(history[0]?.isPersonalBest, true, 'the lb set is heavier once converted');
    assert.ok(Math.abs((history[0]?.bestWeightDeltaKg ?? 0) - (toKg(230, 'lb') - 100)) < 0.01);
  });

  it('marks nothing when an exercise has no weighted sets', async () => {
    const training = repositories().training;
    const base = createWorkout();
    const startTime = new Date('2026-03-02T09:00:00').toISOString();
    const workout = await training.put({ ...base, startTime, createdAt: startTime });
    const entry = createExerciseEntry(workout.id, 'Pull Up', 0);
    await training.upsertExercise(workout.id, {
      ...entry,
      sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, null, 'kg')],
    });
    await training.complete(workout.id);

    const history = await repositories().exercises.history('Pull Up');
    assert.equal(history.length, 1);
    assert.equal(history[0]?.isPersonalBest, false);
    assert.equal(history[0]?.bestWeightDeltaKg, null);

    const summary = await repositories().exercises.summary('Pull Up');
    assert.equal(summary?.personalBestCount, 0);
    assert.equal(summary?.bestWeightKg, null);
    assert.equal(summary?.bestWeightDateKey, null);
  });

  it('keeps the existing newest-first ordering of the session log', async () => {
    await session('Squat', '2026-03-02', [100]);
    await session('Squat', '2026-03-09', [110]);

    const history = await repositories().exercises.history('Squat');
    assert.deepEqual(
      history.map((row) => row.dateKey),
      ['2026-03-09', '2026-03-02'],
    );
  });
});
