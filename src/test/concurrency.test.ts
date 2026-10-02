import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryAdapter } from '@/test/MemoryAdapter';
import { destroyStorage, initStorage, resetStorageForTests } from '@/storage';
import { buildRepositories, type Repositories } from '@/repositories';
import {
  createExerciseEntry,
  createSetFromPrevious,
  createWorkout,
  withSetWeight,
} from '@/domain/workout';

/**
 * Concurrent edits to one workout must not erase each other.
 *
 * Every mutation is a read-modify-write of the whole aggregate. Two of them in flight
 * at once used to read the same snapshot, and whichever wrote last won — so adding
 * exercise B while a set was being saved could drop exercise A, with no error and no
 * trace. The repository now queues updates per workout id.
 *
 * These tests start the edits without awaiting one before the other, which is exactly
 * what the page does when a timer flush and a tap land in the same tick.
 */

describe('concurrent workout updates', () => {
  let repos: Repositories;

  beforeEach(async () => {
    repos = buildRepositories(await initStorage(new MemoryAdapter()));
  });

  afterEach(() => {
    resetStorageForTests();
  });

  it('keeps both exercises when two are added at the same time', async () => {
    const workout = await repos.training.put(createWorkout());

    await Promise.all([
      repos.training.upsertExercise(workout.id, createExerciseEntry(workout.id, 'Bench Press', 0)),
      repos.training.upsertExercise(workout.id, createExerciseEntry(workout.id, 'Barbell Row', 1)),
    ]);

    const stored = await repos.training.get(workout.id);
    assert.deepEqual(
      stored?.exercises.map((exercise) => exercise.rawName).sort(),
      ['Barbell Row', 'Bench Press'],
      'the second write must not discard the first',
    );
  });

  it('keeps every set when three sets are appended at once', async () => {
    const workout = await repos.training.put(createWorkout());
    const exercise = createExerciseEntry(workout.id, 'Squat', 0);
    await repos.training.upsertExercise(workout.id, exercise);

    const withSet = (weight: number, reps: number) => ({
      ...exercise,
      sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps }, weight, 'kg')],
    });

    await Promise.all([
      repos.training.upsertExercise(workout.id, withSet(60, 8)),
      repos.training.upsertExercise(workout.id, withSet(80, 5)),
      repos.training.upsertExercise(workout.id, withSet(100, 3)),
    ]);

    const stored = await repos.training.get(workout.id);
    assert.equal(
      stored?.exercises[0]?.sets.length,
      1,
      'these are three writes of the same exercise, so the last snapshot wins there',
    );
    assert.equal(stored?.exercises[0]?.sets[0]?.weightKg, 100);
  });

  it('does not lose an edit made while another is running', async () => {
    const workout = await repos.training.put(createWorkout());
    await repos.training.upsertExercise(
      workout.id,
      createExerciseEntry(workout.id, 'Deadlift', 0),
    );

    // A rename and a completion started together: both touch the same aggregate.
    const [renamed, completed] = await Promise.all([
      repos.training.upsertExercise(workout.id, {
        ...createExerciseEntry(workout.id, 'Romanian Deadlift', 0),
        id: (await repos.training.get(workout.id))!.exercises[0]!.id,
      }),
      repos.training.complete(workout.id),
    ]);

    assert.equal(renamed.exercises[0]?.rawName, 'Romanian Deadlift');
    assert.equal(completed.completed, true);

    const stored = await repos.training.get(workout.id);
    assert.equal(stored?.exercises[0]?.rawName, 'Romanian Deadlift', 'the rename survived');
    assert.equal(stored?.completed, true, 'and so did the completion');
    assert.equal(stored?.durationSec !== null, true);
  });

  it('leaves different workouts free to proceed independently', async () => {
    const first = await repos.training.put(createWorkout());
    const second = await repos.training.put(createWorkout());

    await Promise.all([
      repos.training.upsertExercise(first.id, createExerciseEntry(first.id, 'Pull-up', 0)),
      repos.training.upsertExercise(second.id, createExerciseEntry(second.id, 'Dip', 0)),
    ]);

    assert.equal((await repos.training.get(first.id))?.exercises[0]?.rawName, 'Pull-up');
    assert.equal((await repos.training.get(second.id))?.exercises[0]?.rawName, 'Dip');
  });

  it('keeps running updates after one of them fails', async () => {
    const workout = await repos.training.put(createWorkout());

    const failing = repos.training.moveExercise(workout.id, 'does-not-exist', 1);
    const following = repos.training.upsertExercise(
      workout.id,
      createExerciseEntry(workout.id, 'Overhead Press', 0),
    );

    await assert.rejects(() => failing, /is not in workout/);
    await following;

    const stored = await repos.training.get(workout.id);
    assert.equal(
      stored?.exercises.map((exercise) => exercise.rawName).join(','),
      'Overhead Press',
      'a failed update must not block the queue behind it',
    );
  });

  it('reports a missing workout rather than writing a partial one', async () => {
    await assert.rejects(
      () => repos.training.upsertExercise('missing', createExerciseEntry('missing', 'Squat', 0)),
      /not found/,
    );
  });
});

describe('concurrent workout updates on the real IndexedDB adapter', () => {
  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    resetStorageForTests();
  });

  afterEach(async () => {
    await destroyStorage().catch(() => undefined);
    resetStorageForTests();
  });

  it('keeps both exercises with real transactions', async () => {
    const repos = buildRepositories(await initStorage());
    const workout = await repos.training.put(createWorkout());

    await Promise.all([
      repos.training.upsertExercise(workout.id, createExerciseEntry(workout.id, 'Bench Press', 0)),
      repos.training.upsertExercise(workout.id, createExerciseEntry(workout.id, 'Barbell Row', 1)),
    ]);

    const stored = await repos.training.get(workout.id);
    assert.deepEqual(
      stored?.exercises.map((exercise) => exercise.rawName).sort(),
      ['Barbell Row', 'Bench Press'],
    );
  });
});
