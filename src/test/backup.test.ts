import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MemoryAdapter } from '@/test/MemoryAdapter';
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
import { localDateKey } from '@/domain/datetime';
import {
  applyBackup,
  backupFileName,
  createBackup,
  parseBackup,
  serializeBackup,
  summarizeBackup,
  BackupParseError,
  BACKUP_FORMAT,
  BACKUP_VERSION,
} from '@/services/backup';
import { assertBackupSourceOmitsApiKey } from '@/test/helpers/assertBackupSource';
import { DEFAULT_THEME_ID } from '@/theme/tokens';
import type { SetEntry, Workout } from '@/domain/types';

/** Build a completed workout containing one exercise with the given sets. */
async function record(
  repos: Repositories,
  name: string,
  sets: { weight: number; reps: number; unit?: 'kg' | 'lb'; isFailure?: boolean }[],
): Promise<Workout> {
  const workout = await repos.training.put(createWorkout());
  const exercise = createExerciseEntry(workout.id, name, 0);
  const built: SetEntry[] = sets.map((spec) => {
    const base = createSetFromPrevious(undefined, spec.unit ?? 'kg');
    return withSetWeight(
      { ...base, reps: spec.reps, ...(spec.isFailure ? { isFailure: true } : {}) },
      spec.weight,
      spec.unit ?? 'kg',
    );
  });
  await repos.training.upsertExercise(workout.id, { ...exercise, sets: built });
  return repos.training.complete(workout.id);
}

describe('JSON backup round-trip', () => {
  let bundle: StorageBundle;
  let repos: Repositories;
  let memory: MemoryAdapter;

  beforeEach(async () => {
    resetStorageForTests();
    memory = new MemoryAdapter();
    bundle = await initStorage(memory);
    repos = buildRepositories(bundle);
  });

  afterEach(() => {
    resetStorageForTests();
  });

  it('exports every collection, then restores it exactly', async () => {
    // Populate: two workouts, an alias rule, a summary and non-default settings.
    const bench = await record(repos, 'Bench Press', [
      { weight: 60, reps: 8 },
      { weight: 60, reps: 7, isFailure: true },
    ]);
    await record(repos, 'Squat', [{ weight: 100, reps: 5 }]);
    await repos.rules.save({ match: 'bench', normalized: 'Bench Press' });
    const stampedAt = new Date().toISOString();
    await repos.summaries.save({
      id: 'sum_daily_backup',
      kind: 'daily',
      periodKey: localDateKey(new Date()),
      title: 'Chest and legs.',
      body: 'Chest and legs.',
      bullets: ['Bench Press: 60kg × 8 × 2'],
      highlights: [{ label: 'Sessions', value: '1' }],
      changes: [],
      workoutIds: [bench.id],
      sessionCount: 1,
      totalVolumeKg: 900,
      totalDurationSec: 3600,
      source: 'auto',
      generatedAt: stampedAt,
      updatedAt: stampedAt,
    });
    await repos.settings.patch({
      defaultUnit: 'lb',
      theme: 'orca',
      aiEnabled: true,
      aiBaseUrl: 'https://example.test/v1',
      aiModel: 'some-model',
      aiApiKey: 'sk-super-secret',
    });
    await repos.training.put({ ...(await repos.training.get(bench.id))!, notes: 'felt strong' });

    // Meals and the profile are part of the same document.
    await repos.meals.save({
      id: 'meal_1',
      eatenAt: '2026-02-14T12:30:00.000Z',
      name: 'Chicken rice',
      portion: '1 plate',
      items: [
        {
          id: 'item_1',
          name: 'Chicken breast',
          portion: '200 g',
          calories: 330,
          proteinG: 62,
          carbsG: 0,
          fatG: 7,
        },
      ],
      calories: 330,
      proteinG: 62,
      carbsG: 0,
      fatG: 7,
      notes: '',
      source: 'manual',
      confidence: null,
      imageKey: null,
      aiNote: '',
      createdAt: stampedAt,
      updatedAt: stampedAt,
    });
    await repos.profile.patch({ name: 'Sam', unitSystem: 'imperial', heightCm: 180 });

    const document = await createBackup(repos);
    const json = serializeBackup(document);
    const summary = summarizeBackup(document);

    assert.equal(summary.workouts, 2);
    assert.equal(summary.exercises, 2);
    assert.equal(summary.sets, 3);
    assert.equal(summary.aliasRules, 1);
    assert.equal(summary.summaries, 1);
    assert.equal(summary.meals, 1);
    assert.equal(document.profile?.name, 'Sam');

    // The API key must not appear anywhere in the serialized file.
    assert.ok(!json.includes('sk-super-secret'), 'backup must never contain the API key');
    assert.ok(!("aiApiKey" in document.settings), 'settings in the backup have no aiApiKey field');

    // Wipe the device, then restore from the file only.
    await repos.training.clear();
    await repos.rules.clear();
    await repos.summaries.clear();
    await repos.settings.patch({ defaultUnit: 'kg', theme: 'bunny', notes: undefined } as never);
    assert.equal(await repos.training.count(), 0);

    const parsed = parseBackup(json);
    const result = await applyBackup(parsed, { repos });

    assert.equal(result.summary.workouts, 2);
    assert.equal(await repos.training.count(), 2);
    assert.equal(await repos.rules.count(), 1);
    assert.equal(await repos.summaries.count(), 1);

    const restored = await repos.training.get(bench.id);
    assert.equal(restored?.notes, 'felt strong');
    assert.equal(restored?.exercises[0]?.sets.length, 2);
    assert.equal(restored?.exercises[0]?.sets[1]?.isFailure, true, 'flags survive the round-trip');
    assert.equal(restored?.exercises[0]?.sets[0]?.weightKg, 60);

    const settings = await repos.settings.get();
    assert.equal(settings.defaultUnit, 'lb');
    assert.equal(settings.theme, 'orca');
    assert.equal(settings.aiBaseUrl, 'https://example.test/v1');
    assert.equal(settings.aiModel, 'some-model');

    // The exercise history view is rebuilt purely from restored workouts.
    const history = await repos.exercises.history('Bench Press');
    assert.equal(history.length, 1);
    assert.equal(history[0]?.workingSetCount, 2);
  });

  it('keeps the API key already on the device when restoring', async () => {
    await repos.settings.patch({ aiApiKey: 'sk-this-device' });
    const document = await createBackup(repos);
    document.settings.aiModel = 'from-backup';

    await applyBackup(document, { repos });

    const settings = await repos.settings.get();
    assert.equal(settings.aiApiKey, 'sk-this-device', 'restore does not clobber the local key');
    assert.equal(settings.aiModel, 'from-backup', 'other AI settings are restored');
  });

  it('restores nothing but leaves storage usable when the backup is empty', async () => {
    await record(repos, 'Row', [{ weight: 40, reps: 10 }]);
    const document = await createBackup(repos);
    document.workouts = [];

    await applyBackup(document, { repos });
    assert.equal(await repos.training.count(), 0);
    // Still writable after a replace-style import.
    await record(repos, 'Row', [{ weight: 45, reps: 10 }]);
    assert.equal(await repos.training.count(), 1);
  });

  it('names files chronologically', () => {
    const name = backupFileName('2026-02-14T09:31:00.000Z');
    assert.match(name, /^fitagi-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    assert.equal(backupFileName('2026-02-14T09:31:00.000Z', 'txt').endsWith('.txt'), true);
  });

  it('never exposes the API key in the export source', () => {
    assertBackupSourceOmitsApiKey();
  });
});

describe('backup parsing and validation', () => {
  const valid = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: '2026-02-14T09:31:00.000Z',
    app: { name: 'Fitness Agent', version: '0.2.0' },
    settings: { defaultUnit: 'lb', theme: 'dark' },
    workouts: [],
    aliasRules: [],
    summaries: [],
  };

  it('accepts a well-formed backup', () => {
    const parsed = parseBackup(JSON.stringify(valid));
    assert.equal(parsed.workouts.length, 0);
    assert.equal(parsed.settings.defaultUnit, 'lb');
    assert.equal(parsed.settings.aiEnabled, false, 'missing AI fields default to off');
  });

  it('rejects files that are not JSON', () => {
    assert.throws(() => parseBackup('not json at all'), BackupParseError);
  });

  it('rejects JSON that is not a Fitness Agent backup', () => {
    assert.throws(() => parseBackup('{"hello":"world"}'), BackupParseError);
    assert.throws(() => parseBackup('[]'), BackupParseError);
  });

  it('rejects a backup from a newer format instead of dropping data', () => {
    const future = { ...valid, version: BACKUP_VERSION + 1 };
    assert.throws(
      () => parseBackup(JSON.stringify(future)),
      (error: unknown) =>
        error instanceof BackupParseError && /newer version/.test(error.message),
    );
  });

  it('rejects a backup without a workouts list', () => {
    const broken: Record<string, unknown> = { ...valid };
    delete broken['workouts'];
    assert.throws(() => parseBackup(JSON.stringify(broken)), BackupParseError);
  });

  it('drops malformed records instead of failing the whole import', () => {
    const messy = {
      ...valid,
      workouts: [
        { id: 'w1', startTime: '2026-02-14T09:00:00.000Z', exercises: [] },
        { id: 'broken' },
        null,
        'nope',
      ],
      aliasRules: [{ id: 'r1', match: 'bench', normalized: 'Bench Press' }, { match: 'no-id' }],
      summaries: [
        { id: 's1', kind: 'daily', periodKey: '2026-02-14' },
        { id: 's2' },
        { id: 's3', kind: 'weekly' },
        { id: 's4', kind: 'yearly', periodKey: '2026' },
      ],
    };
    const parsed = parseBackup(JSON.stringify(messy));
    assert.equal(parsed.workouts.length, 1);
    assert.equal(parsed.aliasRules.length, 1);
    // Only rows with an id, a period and a known kind survive.
    assert.deepEqual(
      parsed.summaries.map((summary) => summary.id),
      ['s1'],
    );
  });

  it('falls back to safe values for nonsense settings', () => {
    const odd = { ...valid, settings: { defaultUnit: 'stone', theme: 'neon', aiRole: 'wizard' } };
    const parsed = parseBackup(JSON.stringify(odd));
    assert.equal(parsed.settings.defaultUnit, 'kg');
    // `neon` is not one of the shipped themes, so the default one is used.
    assert.equal(parsed.settings.theme, DEFAULT_THEME_ID);
    assert.equal(parsed.settings.aiRole, 'recorder');
  });

  it('accepts a v1 backup that predates meals and the profile', () => {
    // Exactly what version 1 wrote: no `meals`, no `profile`, and a `theme` that
    // was really a light/dark colour scheme rather than a theme id.
    const v1 = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: '2025-11-02T07:15:00.000Z',
      app: { name: 'Fitness Agent', version: '0.5.0' },
      settings: { defaultUnit: 'lb', theme: 'dark', aiEnabled: false },
      workouts: [
        {
          id: 'w-legacy',
          startTime: '2025-11-01T18:00:00.000Z',
          endTime: '2025-11-01T19:00:00.000Z',
          durationSec: 3600,
          completed: true,
          notes: 'legacy row',
          exercises: [],
        },
      ],
      aliasRules: [],
      summaries: [],
    };

    const parsed = parseBackup(JSON.stringify(v1));
    assert.equal(parsed.meals.length, 0, 'a missing meals list is not an error');
    assert.equal(parsed.profile, null, 'a missing profile stays absent');
    assert.equal(parsed.workouts.length, 1, 'the old workout is kept');
    assert.equal(parsed.workouts[0]?.notes, 'legacy row');
    assert.equal(parsed.settings.defaultUnit, 'lb', 'the old preferences still apply');
    // `dark` is not a theme id, so the default theme is used instead of failing.
    assert.equal(parsed.settings.theme, DEFAULT_THEME_ID);
    assert.equal(parsed.settings.language, 'system', 'language defaults to following the device');
  });
});

describe('backup works on the real IndexedDB adapter', () => {
  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    resetStorageForTests();
  });

  afterEach(() => {
    resetStorageForTests();
  });

  it('restores across a re-opened connection', async () => {
    const first = await initStorage(new IndexedDbAdapter());
    const reposA = buildRepositories(first);
    await record(reposA, 'Deadlift', [{ weight: 140, reps: 3 }]);
    await reposA.rules.save({ match: 'dl', normalized: 'Deadlift' });
    const json = serializeBackup(await createBackup(reposA));
    await first.adapter.close();

    resetStorageForTests();
    const second = await initStorage(new IndexedDbAdapter());
    const reposB = buildRepositories(second);

    // Wipe through the new connection, then restore into it.
    await reposB.training.clear();
    await reposB.rules.clear();
    await applyBackup(parseBackup(json), { repos: reposB });

    assert.equal(await reposB.training.count(), 1);
    assert.equal(await reposB.rules.resolve('dl'), 'Deadlift');
    assert.equal((await reposB.exercises.summary('Deadlift'))?.bestWeightKg, 140);

    await second.adapter.close();
  });
});
