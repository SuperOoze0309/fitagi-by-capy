import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbAdapter } from '@/storage/idbAdapter';
import { initStorage, resetStorageForTests, type StorageBundle } from '@/storage';
import { buildRepositories, type Repositories } from '@/repositories';
import {
  createExerciseEntry,
  createSetFromPrevious,
  createWorkout,
  withSetWeight,
} from '@/domain/workout';

/**
 * Exercises the *real* browser storage path (IndexedDbAdapter) rather than the
 * in-memory double, so the IndexedDB schema, transactions and JSON round-trip are
 * covered without needing a browser.
 *
 * Each "reload" opens a brand new adapter against the same IndexedDB, which is
 * what a page refresh actually does.
 */
describe('IndexedDB adapter', () => {
  beforeEach(() => {
    // Fresh, isolated IndexedDB per test.
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    resetStorageForTests();
  });

  afterEach(() => {
    resetStorageForTests();
  });

  /** Open storage the way app boot does, and build repositories for it. */
  async function open(): Promise<{ bundle: StorageBundle; repos: Repositories }> {
    const bundle = await initStorage(new IndexedDbAdapter());
    return { bundle, repos: buildRepositories(bundle) };
  }

  it('persists a completed workout and reads it back through a new connection', async () => {
    const first = await open();
    const training = first.repos.training;

    const workout = await training.put(createWorkout());
    const exercise = createExerciseEntry(workout.id, 'Bench Press', 0);
    await training.upsertExercise(workout.id, {
      ...exercise,
      sets: [
        withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 60, 'kg'),
        withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 60, 'kg'),
        withSetWeight(
          { ...createSetFromPrevious(undefined, 'kg'), reps: 7, isFailure: true, rpe: 10 },
          60,
          'kg',
        ),
      ],
    });
    await training.complete(workout.id);
    await first.bundle.adapter.close();
    resetStorageForTests();

    // Re-open exactly as a page reload would.
    const second = await open();
    const history = await second.repos.training.completed();
    assert.equal(history.length, 1, 'the workout survived the reload');
    const reloaded = history[0]!;
    assert.equal(reloaded.exercises[0]?.rawName, 'Bench Press');
    assert.equal(reloaded.exercises[0]?.sets.length, 3);
    assert.equal(reloaded.exercises[0]?.sets[2]?.isFailure, true);
    assert.equal(reloaded.exercises[0]?.sets[2]?.rpe, 10);
    assert.equal(reloaded.exercises[0]?.sets[0]?.weightKg, 60);

    const summary = await second.repos.exercises.summary('Bench Press');
    assert.equal(summary?.sessionCount, 1);
    assert.equal(summary?.totalWorkingSets, 3);

    await second.bundle.adapter.close();
  });

  it('stores settings and alias rules in their own object stores', async () => {
    const first = await open();
    await first.repos.settings.patch({ defaultUnit: 'lb', theme: 'orca' });
    await first.repos.rules.save({ match: 'bench', normalized: 'Bench Press' });
    await first.bundle.adapter.close();
    resetStorageForTests();

    const second = await open();
    const settings = await second.repos.settings.get();
    assert.equal(settings.defaultUnit, 'lb');
    assert.equal(settings.theme, 'orca');
    assert.equal(await second.repos.rules.resolve('bench'), 'Bench Press');
    // Settings and rules live in separate stores, and neither creates a workout.
    assert.equal(await second.repos.training.count(), 0);

    await second.bundle.adapter.close();
  });

  it('supports bulk writes, removal and clearing', async () => {
    const { bundle, repos } = await open();
    const training = repos.training;

    const workouts = [createWorkout(), createWorkout(), createWorkout()];
    await training.putMany(workouts);
    assert.equal(await training.count(), 3);

    await training.remove(workouts[0]!.id);
    assert.equal(await training.count(), 2);
    assert.equal(await training.get(workouts[0]!.id), null);
    assert.ok(await training.get(workouts[1]!.id));

    await training.clear();
    assert.equal(await training.count(), 0);

    await bundle.adapter.close();
  });

  it('returns None-safe reads for unknown ids', async () => {
    const { bundle, repos } = await open();
    assert.equal(await repos.training.get('does-not-exist'), null);
    assert.equal(await repos.exercises.summary('unknown lift'), null);
    assert.deepEqual(await repos.exercises.suggestions(), []);
    await bundle.adapter.close();
  });
});
