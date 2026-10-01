import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryAdapter } from '@/test/MemoryAdapter';
import { destroyStorage, initStorage, resetStorageForTests } from '@/storage';
import { buildRepositories, type Repositories } from '@/repositories';
import {
  APP_NAME,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupParseError,
  BackupRestoreError,
  applyBackup,
  createBackup,
  parseBackup,
  serializeBackup,
  summarizeBackup,
  validateBackup,
} from '@/services/backup';
import { createEmptyMeal, createEmptyMealItem } from '@/repositories/mealRepository';
import { createEmptyPlan, createEmptyReminder } from '@/repositories/planRepository';
import { createExerciseEntry, createWorkout, withSetWeight } from '@/domain/workout';
import { createSetFromPrevious } from '@/domain/workout';
import type { BackupDocument } from '@/services/backup';
import type { Meal } from '@/domain/types';

/**
 * Restoring a backup must never cost the user data.
 *
 * Two ways it did:
 *
 *   1. `applyBackup` cleared six collections and only then wrote the incoming rows. A
 *      single failed write left an empty app with the original data already gone.
 *   2. Validation filtered malformed rows out instead of refusing the file, so a
 *      restore could report success while quietly dropping records — and a row that
 *      passed the shallow check could still throw halfway through the write, after
 *      the clears.
 *
 * These tests drive the real restore path with injected failures and assert on what
 * is left in storage, not on which functions were called.
 */

/** A complete, valid backup document built from the app's own factories. */
function backupWith(overrides: Partial<BackupDocument> = {}): BackupDocument {
  return {
    format: BACKUP_FORMAT,
    // The current format version, so this fixture does not age into "written by a
    // newer app" the next time the format is bumped.
    version: BACKUP_VERSION,
    exportedAt: '2026-03-01T10:00:00.000Z',
    app: { name: APP_NAME, version: '0.9.0' },
    settings: { ...(parseBackup(JSON.stringify(BASE)).settings ?? {}) },
    workouts: [],
    aliasRules: [],
    summaries: [],
    meals: [],
    reminders: [],
    plans: [],
    profile: null,
    ...overrides,
  } as BackupDocument;
}

const BASE = {
  format: BACKUP_FORMAT,
  version: BACKUP_VERSION,
  exportedAt: '2026-03-01T10:00:00.000Z',
  app: { name: APP_NAME, version: '0.9.0' },
  settings: {},
  workouts: [],
};

function workoutAt(id: string, date: string) {
  const workout = createWorkout();
  return {
    ...workout,
    id,
    startTime: `${date}T09:00:00.000Z`,
    endTime: `${date}T10:00:00.000Z`,
    completed: true,
    exercises: [
      {
        ...createExerciseEntry(workout.id, 'Bench Press', 0),
        id: `${id}-ex`,
        sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 60, 'kg')],
      },
    ],
  };
}

function mealOn(id: string, date: string): Meal {
  return {
    ...createEmptyMeal({ eatenAt: `${date}T12:00:00.000Z` }),
    id,
    name: 'Chicken rice',
    items: [{ ...createEmptyMealItem(), name: 'Chicken', calories: 248 }],
    calories: 248,
  };
}

describe('restoring a backup is all-or-nothing', () => {
  let repos: Repositories;
  let adapter: MemoryAdapter;

  beforeEach(async () => {
    adapter = new MemoryAdapter();
    repos = buildRepositories(await initStorage(adapter));
  });

  afterEach(() => {
    resetStorageForTests();
  });

  it('keeps the stored log when a write fails partway through', async () => {
    const existing = workoutAt('existing', '2026-02-01');
    await repos.training.put(existing);
    await repos.meals.save(mealOn('existing-meal', '2026-02-01'));
    await repos.rules.save({ match: 'bench', normalized: 'Bench Press' });

    // The incoming file holds one workout; writing it fails on the first attempt.
    const incoming = backupWith({ workouts: [workoutAt('incoming', '2026-03-01')] });
    const originalPutMany = repos.training.putMany.bind(repos.training);
    let calls = 0;
    repos.training.putMany = async (rows) => {
      calls += 1;
      if (calls === 1) throw new Error('INJECTED_WRITE_FAILURE');
      return originalPutMany(rows);
    };

    await assert.rejects(
      () => applyBackup(incoming, { repos }),
      (error: unknown) => {
        assert.ok(error instanceof BackupRestoreError, 'a restore failure says so');
        assert.match(error.message, /Nothing was lost|put back/);
        return true;
      },
    );

    const after = await repos.training.all();
    assert.deepEqual(
      after.map((row) => row.id),
      ['existing'],
      'the original workout is still there, and the failed import left nothing behind',
    );
    assert.equal((await repos.meals.all()).length, 1, 'meals were never cleared');
    assert.equal((await repos.rules.all()).length, 1, 'alias rules were never cleared');
    assert.equal(
      await repos.settings.get().then((settings) => settings.theme !== undefined),
      true,
      'settings are still readable',
    );
  });

  it('restores normally when nothing fails', async () => {
    await repos.training.put(workoutAt('old', '2026-02-01'));
    await repos.meals.save(mealOn('old-meal', '2026-02-01'));

    const incoming = backupWith({
      workouts: [workoutAt('new', '2026-03-01')],
      meals: [mealOn('new-meal', '2026-03-01')],
      reminders: [createEmptyReminder({ title: 'Leg day', time: '19:00' })],
      plans: [{ ...createEmptyPlan(), name: 'Split', active: true }],
    });

    const result = await applyBackup(incoming, { repos });
    assert.equal(result.summary.workouts, 1);
    assert.deepEqual(
      (await repos.training.all()).map((row) => row.id),
      ['new'],
      'a replace restore leaves exactly what the file holds',
    );
    assert.deepEqual((await repos.meals.all()).map((row) => row.id), ['new-meal']);
    assert.equal((await repos.reminders.all()).length, 1);
    assert.equal((await repos.plans.all()).length, 1);
  });

  it('removes a previously set profile when the file has none', async () => {
    await repos.profile.save({
      ...(await repos.profile.get()),
      name: 'OLD_PERSON',
      weightKg: 80,
    });

    await applyBackup(backupWith(), { repos });

    const profile = await repos.profile.get();
    assert.equal(profile.name, '', 'replace means replace, including the profile');
    assert.equal(profile.weightKg, null);
  });

  it('drops meal photos the restored meals no longer reference', async () => {
    const scope = (await initStorage(adapter)).scope;
    await repos.meals.save(mealOn('photo-meal', '2026-02-01'));
    await scope.kv('images').set('image:photo-meal', 'data:image/jpeg;base64,AAAA');

    await applyBackup(backupWith({ meals: [mealOn('fresh', '2026-03-01')] }), { repos });

    assert.equal(
      await scope.kv('images').get('image:photo-meal'),
      null,
      'the photo of a replaced meal is gone',
    );
  });
});

describe('a file that is wrong is refused, not trimmed', () => {
  it('reports every problem with its path', () => {
    const result = validateBackup({
      ...BASE,
      workouts: [{ id: 'w', startTime: '2026-02-01T09:00:00.000Z', exercises: 'not a list' }],
      reminders: [{ id: 'r', time: '19:00', weekdays: 7 }],
      plans: [{ id: 'p', name: 'Split', days: [{ weekday: 9 }] }],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    const paths = result.problems.map((entry) => entry.path);
    assert.ok(paths.includes('workouts[0].exercises'));
    assert.ok(paths.includes('reminders[0].weekdays'));
    assert.ok(paths.includes('plans[0].days[0].weekday'));
  });

  it('refuses duplicate ids, which would make the preview disagree with the result', () => {
    const result = validateBackup({
      ...BASE,
      meals: [mealOn('same', '2026-02-01'), mealOn('same', '2026-02-02')],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(
      result.problems.some((entry) => entry.path === 'meals[1].id' && /Duplicate/.test(entry.message)),
      'the second row with that id is named',
    );
  });

  it('accepts a well-formed file', () => {
    const result = validateBackup({
      ...BASE,
      workouts: [workoutAt('w1', '2026-02-01')],
      meals: [mealOn('m1', '2026-02-01')],
      reminders: [createEmptyReminder({ title: 'Water', time: '15:00' })],
      plans: [{ ...createEmptyPlan(), name: 'Split', active: true }],
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.document.workouts.length, 1);
    assert.equal(result.document.meals.length, 1);
  });

  it('is enforced by applyBackup too, so a hand-built document is checked', async () => {
    const repos = buildRepositories(await initStorage(adapterFor()));
    await repos.training.put(workoutAt('kept', '2026-02-01'));

    const broken = { ...backupWith(), workouts: [{ id: 'bad', startTime: 'not-a-date' }] };

    await assert.rejects(
      () => applyBackup(broken as BackupDocument, { repos }),
      (error: unknown) => {
        assert.ok(error instanceof BackupParseError);
        assert.match(error.message, /workouts\[0\]/);
        return true;
      },
    );

    assert.equal((await repos.training.all()).length, 1, 'nothing was cleared by the refusal');
    resetStorageForTests();
  });

  it('round-trips through the real serialiser without losing rows', async () => {
    const repos = buildRepositories(await initStorage(adapterFor()));
    await repos.training.put(workoutAt('a', '2026-02-01'));
    await repos.meals.save(mealOn('m', '2026-02-01'));

    const document = await createBackup(repos);
    const text = serializeBackup(document);
    const parsed = parseBackup(text);

    assert.equal(summarizeBackup(parsed).workouts, 1);
    assert.equal(summarizeBackup(parsed).meals, 1);
    resetStorageForTests();
  });
});

function adapterFor(): MemoryAdapter {
  return new MemoryAdapter();
}

describe('restoring into the real IndexedDB adapter', () => {
  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    resetStorageForTests();
  });

  afterEach(async () => {
    await destroyStorage().catch(() => undefined);
    resetStorageForTests();
  });

  it('keeps the existing rows when a write fails, with real transactions', async () => {
    const repos = buildRepositories(await initStorage());
    await repos.training.put(workoutAt('existing', '2026-02-01'));

    const incoming = backupWith({ workouts: [workoutAt('incoming', '2026-03-01')] });
    const originalPutMany = repos.training.putMany.bind(repos.training);
    let calls = 0;
    repos.training.putMany = async (rows) => {
      calls += 1;
      if (calls === 1) throw new Error('INJECTED_WRITE_FAILURE');
      return originalPutMany(rows);
    };

    await assert.rejects(() => applyBackup(incoming, { repos }));

    const rows = await repos.training.all();
    assert.deepEqual(rows.map((row) => row.id), ['existing']);
  });
});
