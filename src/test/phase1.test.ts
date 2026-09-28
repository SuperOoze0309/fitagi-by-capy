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
import { toKg, fromKg, convertWeight, roundDisplayWeight } from '@/domain/units';
import {
  countWorkingSets,
  estimateOneRepMaxKg,
  secondsBetween,
  workoutVolumeKg,
} from '@/domain/metrics';
import { localDateKey } from '@/domain/datetime';
import { findAnomalies } from '@/services/validation';
import { SettingsRepository } from '@/repositories/settingsRepository';
import { DEFAULT_THEME_ID } from '@/theme/tokens';
import type { KeyValueStore } from '@/storage/adapter';
import type { Workout } from '@/domain/types';

/**
 * Covers the Phase 1 promise: start a workout -> log exercises and sets -> finish
 * -> find it in History -> reopen the app and still have it.
 *
 * Runs with `npm test`: node:test plus Node's native TypeScript transform, so the
 * project needs no test framework and no extra runtime dependency.
 */
describe('Phase 1 core loop', () => {
  let memory: MemoryAdapter;

  beforeEach(async () => {
    resetStorageForTests();
    resetRepositoriesForTests();
    memory = new MemoryAdapter();
    await initStorage(memory);
    initRepositories();
  });

  afterEach(() => {
    resetStorageForTests();
    resetRepositoriesForTests();
  });

  it('records a workout, persists it, and reads it back after a restart', async () => {
    const training = repositories().training;

    // 1. Start workout.
    const workout = await training.put(createWorkout());
    assert.equal(workout.completed, false);
    assert.equal(workout.endTime, null);

    // 2. Add an exercise.
    const bench = createExerciseEntry(workout.id, '  Bench   Press ', 0);
    assert.equal(bench.rawName, 'Bench Press', 'names are whitespace-normalized');
    await training.upsertExercise(workout.id, bench);

    // 3. Add three working sets at 60 kg x 8.
    const sets = [0, 1, 2].map(() => {
      const base = createSetFromPrevious(undefined, 'kg');
      return withSetWeight({ ...base, reps: 8 }, 60, 'kg');
    });
    await training.upsertExercise(workout.id, { ...bench, sets });

    const stored = await training.get(workout.id);
    assert.equal(stored?.exercises.length, 1);
    assert.equal(stored?.exercises[0]?.sets.length, 3);
    assert.equal(stored?.exercises[0]?.sets[0]?.weightKg, 60);

    // 4. Finish the workout.
    const finished = await training.complete(workout.id);
    assert.equal(finished.completed, true);
    assert.ok(finished.endTime);
    assert.ok(finished.durationSec >= 0);

    // 5. It shows up in History.
    const history = await training.completed();
    assert.equal(history.length, 1);
    assert.equal(history[0]?.id, workout.id);

    // 6. Restart the app: drop every cached repository, keep the same "device" rows.
    resetStorageForTests();
    resetRepositoriesForTests();
    await initStorage(memory);
    initRepositories();

    const afterRestart = await repositories().training.completed();
    assert.equal(afterRestart.length, 1, 'workout survives an app restart');
    const reloaded = afterRestart[0] as Workout;
    assert.equal(reloaded.exercises[0]?.rawName, 'Bench Press');
    assert.equal(reloaded.exercises[0]?.sets[2]?.reps, 8);
    assert.equal(reloaded.notes, '');
  });

  it('keeps an in-progress workout resumable', async () => {
    const training = repositories().training;
    const workout = await training.put(createWorkout());
    assert.equal((await training.inProgress())?.id, workout.id);

    await training.complete(workout.id);
    assert.equal(await training.inProgress(), null);
    assert.equal((await training.latestCompleted())?.id, workout.id);
  });

  it('can reopen a finished workout as in-progress again', async () => {
    const training = repositories().training;
    const workout = await training.put(createWorkout());
    await training.complete(workout.id);
    assert.equal(await training.inProgress(), null);

    const reopened = await training.reopen(workout.id);

    assert.equal(reopened.completed, false);
    assert.equal(reopened.endTime, null, 'the end time is cleared so it is open again');
    assert.equal((await training.inProgress())?.id, workout.id);
    assert.equal(await training.latestCompleted(), null, 'it leaves the completed list');
    // The logged sets are untouched by reopening.
    assert.ok(Array.isArray(reopened.exercises));
  });

  it('supports reorder and set removal', async () => {
    const training = repositories().training;
    const workout = await training.put(createWorkout());
    const first = createExerciseEntry(workout.id, 'Bench Press', 0);
    const second = createExerciseEntry(workout.id, 'Row', 1);
    await training.upsertExercise(workout.id, first);
    await training.upsertExercise(workout.id, second);

    const moved = await training.moveExercise(workout.id, second.id, -1);
    assert.deepEqual(
      moved.exercises.map((exercise) => exercise.rawName),
      ['Row', 'Bench Press'],
    );
    assert.deepEqual(
      moved.exercises.map((exercise) => exercise.order),
      [0, 1],
      'order stays contiguous after a move',
    );

    const removed = await training.removeExercise(workout.id, first.id);
    assert.equal(removed.exercises.length, 1);
    assert.equal(removed.exercises[0]?.order, 0);
  });
});

describe('exercise history', () => {
  let memory: MemoryAdapter;

  beforeEach(async () => {
    resetStorageForTests();
    resetRepositoriesForTests();
    memory = new MemoryAdapter();
    await initStorage(memory);
    initRepositories();
  });

  afterEach(() => {
    resetStorageForTests();
    resetRepositoriesForTests();
  });

  it('groups sessions by normalized exercise name', async () => {
    const training = repositories().training;

    const dayOne = await training.put(createWorkout());
    const squatOne = createExerciseEntry(dayOne.id, 'squat', 0);
    await training.upsertExercise(dayOne.id, {
      ...squatOne,
      sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 5 }, 100, 'kg')],
    });
    await training.complete(dayOne.id);

    const dayTwo = await training.put(createWorkout());
    const squatTwo = createExerciseEntry(dayTwo.id, 'Squat', 0);
    await training.upsertExercise(dayTwo.id, {
      ...squatTwo,
      sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 5 }, 105, 'kg')],
    });
    await training.complete(dayTwo.id);

    const history = await repositories().exercises.history(' SQUAT ');
    assert.equal(history.length, 2, 'case and padding do not split the history');

    const summary = await repositories().exercises.summary('squat');
    assert.equal(summary?.sessionCount, 2);
    assert.equal(summary?.totalWorkingSets, 2);
    assert.equal(summary?.bestWeightKg, 105);

    const suggestions = await repositories().exercises.suggestions();
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0]?.useCount, 2);
  });

  it('returns workouts for a local calendar day', async () => {
    const training = repositories().training;
    const workout = await training.put(createWorkout());
    await training.complete(workout.id);
    const today = localDateKey(new Date());
    const byDate = await training.findByDate(today);
    assert.equal(byDate.length, 1);
  });
});

describe('units', () => {
  it('normalizes to kg and keeps the entered unit', () => {
    assert.equal(toKg(100, 'kg'), 100);
    assert.equal(Math.round(toKg(100, 'lb') * 1000) / 1000, 45.359);
    assert.equal(Math.round(fromKg(45.359237, 'lb')), 100);
    assert.equal(convertWeight(60, 'kg', 'lb').toFixed(1), '132.3');
    assert.equal(roundDisplayWeight(62.3, 'kg'), 62.5);
    assert.equal(roundDisplayWeight(577.4, 'lb'), 577);
  });

  it('keeps weightKg in sync with the displayed value', () => {
    const set = createSetFromPrevious(undefined, 'kg');
    const inLb = withSetWeight(set, 577, 'lb');
    assert.equal(inLb.unit, 'lb');
    assert.equal(inLb.weight, 577, 'the number the user typed is preserved');
    assert.equal(Math.round((inLb.weightKg ?? 0) * 100) / 100, 261.72);

    const switched = withSetWeight(inLb, 261.72, 'kg');
    assert.equal(switched.unit, 'kg');
    assert.equal(switched.weight, 261.72);
  });
});

describe('metrics', () => {
  it('computes volume, working sets and estimated 1RM', () => {
    const workout = createWorkout();
    const exercise = createExerciseEntry(workout.id, 'Bench Press', 0);
    const warmup = withSetWeight(
      { ...createSetFromPrevious(undefined, 'kg'), reps: 10, isWarmup: true },
      40,
      'kg',
    );
    const work = withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 60, 'kg');

    const full: Workout = { ...workout, exercises: [{ ...exercise, sets: [warmup, work] }] };
    assert.equal(countWorkingSets(full), 1, 'warmups are excluded from working sets');
    assert.equal(workoutVolumeKg(full), 480);
    assert.equal(Math.round(estimateOneRepMaxKg(work) ?? 0), 76);
  });

  it('measures duration between timestamps', () => {
    assert.equal(secondsBetween('2026-01-01T10:00:00.000Z', '2026-01-01T11:15:30.000Z'), 4530);
  });
});

describe('anomaly detection', () => {
  let memory: MemoryAdapter;

  beforeEach(async () => {
    resetStorageForTests();
    resetRepositoriesForTests();
    memory = new MemoryAdapter();
    await initStorage(memory);
    initRepositories();
  });

  afterEach(() => {
    resetStorageForTests();
    resetRepositoriesForTests();
  });

  /** Log `count` completed sessions of bench press at `weight`. */
  async function seedBench(count: number, weight: number): Promise<void> {
    const training = repositories().training;
    for (let index = 0; index < count; index += 1) {
      const workout = await training.put(createWorkout());
      const exercise = createExerciseEntry(workout.id, 'Bench Press', 0);
      await training.upsertExercise(workout.id, {
        ...exercise,
        sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, weight, 'kg')],
      });
      await training.complete(workout.id);
    }
  }

  it('flags an obvious outlier but still allows saving', async () => {
    await seedBench(4, 70);

    const current = await repositories().training.put(createWorkout());
    const exercise = createExerciseEntry(current.id, 'Bench Press', 0);
    const heavy = withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 600, 'kg');
    const candidate: Workout = { ...current, exercises: [{ ...exercise, sets: [heavy] }] };

    const findings = await findAnomalies(candidate, repositories().exercises);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.value, 600);
    assert.match(findings[0]?.message ?? '', /above your usual/);

    // Saving is not blocked and the value is not rewritten.
    await repositories().training.put(candidate);
    const stored = await repositories().training.get(current.id);
    assert.equal(stored?.exercises[0]?.sets[0]?.weight, 600);
  });

  it('stays quiet without enough history', async () => {
    await seedBench(1, 70);
    const current = await repositories().training.put(createWorkout());
    const exercise = createExerciseEntry(current.id, 'Bench Press', 0);
    const heavy = withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 600, 'kg');
    const findings = await findAnomalies(
      { ...current, exercises: [{ ...exercise, sets: [heavy] }] },
      repositories().exercises,
    );
    assert.deepEqual(findings, []);
  });

  it('does not flag a normal session', async () => {
    await seedBench(4, 70);
    const current = await repositories().training.put(createWorkout());
    const exercise = createExerciseEntry(current.id, 'Bench Press', 0);
    const normal = withSetWeight(
      { ...createSetFromPrevious(undefined, 'kg'), reps: 8 },
      72.5,
      'kg',
    );
    const findings = await findAnomalies(
      { ...current, exercises: [{ ...exercise, sets: [normal] }] },
      repositories().exercises,
    );
    assert.deepEqual(findings, []);
  });
});

describe('alias rules', () => {
  let memory: MemoryAdapter;

  beforeEach(async () => {
    resetStorageForTests();
    resetRepositoriesForTests();
    memory = new MemoryAdapter();
    await initStorage(memory);
    initRepositories();
  });

  afterEach(() => {
    resetStorageForTests();
    resetRepositoriesForTests();
  });

  it('resolves user rules and prefers the longest match', async () => {
    const rules = repositories().rules;
    await rules.save({ match: 'bench', normalized: 'Bench Press' });
    await rules.save({ match: 'incline bench', normalized: 'Incline Bench Press' });

    assert.equal(await rules.resolve('bench'), 'Bench Press');
    assert.equal(await rules.resolve('Bench Press'), 'Bench Press');
    assert.equal(await rules.resolve('Incline Bench'), 'Incline Bench Press');
    assert.equal(await rules.resolve('Squat'), null, 'unknown names fall through to the raw name');

    const all = await rules.all();
    assert.equal(all.length, 2);
    await rules.remove(all[0]!.id);
    assert.equal(await rules.count(), 1);
  });

  it('lets a user rule override the name used by the exercise history', async () => {
    const rules = repositories().rules;
    await rules.save({ match: 'bp', normalized: 'Bench Press' });

    const training = repositories().training;
    const workout = await training.put(createWorkout());
    const entry = createExerciseEntry(workout.id, 'bp', 0);
    const resolved = (await rules.resolve(entry.rawName)) ?? entry.rawName;
    await training.upsertExercise(workout.id, {
      ...entry,
      // The raw name is always preserved; only the display name is normalized.
      normalizedName: resolved,
      sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 5 }, 80, 'kg')],
    });
    await training.complete(workout.id);

    const stored = await training.get(workout.id);
    assert.equal(stored?.exercises[0]?.rawName, 'bp');
    assert.equal(stored?.exercises[0]?.normalizedName, 'Bench Press');
    assert.equal((await repositories().exercises.summary('Bench Press'))?.sessionCount, 1);
  });
});

describe('settings', () => {
  let memory: MemoryAdapter;

  beforeEach(async () => {
    resetStorageForTests();
    resetRepositoriesForTests();
    memory = new MemoryAdapter();
    await initStorage(memory);
    initRepositories();
  });

  afterEach(() => {
    resetStorageForTests();
    resetRepositoriesForTests();
  });

  it('starts with AI disabled, kg as the default unit and the app mascot theme', async () => {
    const settings = await repositories().settings.ensureInitialized();
    assert.equal(settings.aiEnabled, false);
    assert.equal(settings.defaultUnit, 'kg');
    // The theme is a visual choice with its own default, and it matches the
    // launcher icon; the *language* is what follows the device until the user picks.
    assert.equal(settings.theme, DEFAULT_THEME_ID);
    assert.equal(settings.language, 'system');
  });

  it('persists patches across a restart', async () => {
    await repositories().settings.patch({
      defaultUnit: 'lb',
      aiEnabled: true,
      aiModel: 'local-llm',
    });

    resetStorageForTests();
    resetRepositoriesForTests();
    await initStorage(memory);
    initRepositories();

    const reloaded = await repositories().settings.get();
    assert.equal(reloaded.defaultUnit, 'lb');
    assert.equal(reloaded.aiEnabled, true);
    assert.equal(reloaded.aiModel, 'local-llm');
  });

  it('keeps every field when several settings are changed at once', async () => {
    // The settings screen writes one patch per keystroke, so two of them overlap
    // routinely. Each patch is a read-merge-write, and without serialisation the
    // second write starts from the snapshot the first one just replaced — which is
    // how a base URL used to disappear when a model name was typed straight after.
    const settings = repositories().settings;
    await Promise.all([
      settings.patch({ aiBaseUrl: 'https://example.test/v1' }),
      settings.patch({ aiModel: 'deepseek-chat' }),
      settings.patch({ theme: 'orca' }),
      settings.patch({ defaultUnit: 'lb' }),
    ]);

    const stored = await settings.get();
    assert.equal(stored.aiBaseUrl, 'https://example.test/v1');
    assert.equal(stored.aiModel, 'deepseek-chat');
    assert.equal(stored.theme, 'orca');
    assert.equal(stored.defaultUnit, 'lb');
  });

  it('survives a failed patch and still applies the next one', async () => {
    // A write that throws must not poison the queue for every later change.
    const rows = new Map<string, unknown>();
    let failNext = true;
    const flaky: KeyValueStore = {
      get: async <T,>(key: string) => (rows.get(key) as T | undefined) ?? null,
      set: async <T,>(key: string, value: T) => {
        if (failNext) {
          failNext = false;
          throw new Error('disk full');
        }
        rows.set(key, value);
      },
      remove: async (key: string) => {
        rows.delete(key);
      },
    };

    const isolated = new SettingsRepository(flaky);
    await assert.rejects(() => isolated.patch({ defaultUnit: 'lb' }));

    const after = await isolated.patch({ theme: 'orca' });
    assert.equal(after.theme, 'orca', 'the next patch still runs');
    assert.equal(after.defaultUnit, 'kg', 'the failed patch was not applied');
  });

  it('writes summaries without touching raw workouts', async () => {
    const training = repositories().training;
    const workout = await training.put(createWorkout());
    await training.complete(workout.id);

    const now = new Date().toISOString();
    await repositories().summaries.save({
      id: 'sum_daily_1',
      kind: 'daily',
      periodKey: localDateKey(new Date()),
      title: 'Trained legs and shoulders.',
      body: 'Legs and shoulders.',
      bullets: [],
      highlights: [],
      changes: [],
      workoutIds: [workout.id],
      sessionCount: 1,
      totalVolumeKg: 0,
      totalDurationSec: 0,
      source: 'auto',
      generatedAt: now,
      updatedAt: now,
    });

    assert.equal((await repositories().summaries.all()).length, 1);
    await repositories().summaries.clear();
    assert.equal((await repositories().summaries.all()).length, 0);
    assert.equal(
      (await training.completed()).length,
      1,
      'deleting summaries never deletes workouts',
    );
  });
});
