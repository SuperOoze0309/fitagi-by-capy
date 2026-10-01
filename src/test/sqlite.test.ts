import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FakeSqlitePlugin } from '@/test/FakeSqlitePlugin';
import { SqliteAdapter, setSqlitePluginForTests } from '@/storage/sqliteAdapter';
import { initStorage, resetStorageForTests, type StorageBundle } from '@/storage';
import { buildRepositories, type Repositories } from '@/repositories';
import {
  createExerciseEntry,
  createSetFromPrevious,
  createWorkout,
  withSetWeight,
} from '@/domain/workout';
import { localDateKey } from '@/domain/datetime';
import { DEFAULT_THEME_ID } from '@/theme/tokens';

/**
 * Exercises the SQLite adapter — the Android production storage engine — against
 * an in-memory double of the Capacitor plugin. This proves the adapter's real SQL
 * statements, its v7 plugin call shapes, and its column mapping, none of which the
 * repository tests can reach.
 *
 * The IndexedDB adapter keeps its own tests (src/test/idb.test.ts) because it is
 * the browser development path.
 */
describe('SQLite adapter', () => {
  let fake: FakeSqlitePlugin;

  beforeEach(() => {
    fake = new FakeSqlitePlugin();
    setSqlitePluginForTests(fake.asPlugin());
    resetStorageForTests();
  });

  afterEach(() => {
    setSqlitePluginForTests(null);
    resetStorageForTests();
  });

  async function open(): Promise<{ bundle: StorageBundle; repos: Repositories }> {
    const bundle = await initStorage(new SqliteAdapter());
    return { bundle, repos: buildRepositories(bundle) };
  }

  it('opens the database, creates the schema and uses the flat plugin API', async () => {
    const { bundle } = await open();
    assert.equal(fake.isOpen(), true, 'the database was opened');
    /*
     * The order is the point. The plugin resolves a connection in every method except
     * `createConnection`, so registering one has to come first; asking about the file
     * before that throws "No available connection" on a real device.
     */
    assert.deepEqual(
      fake.calls.slice(0, 4),
      ['createConnection', 'isDBExists', 'open', 'execute'],
      'the connection is registered before the file is inspected, and the file is inspected before it is created',
    );
    assert.equal(bundle.adapter.kind, 'sqlite');
    assert.match(bundle.adapter.label, /fitness_agent\.db$/);
    await bundle.adapter.close();
    assert.equal(fake.isOpen(), false);
  });

  it('treats an already registered connection as success, not as a failure', async () => {
    // A retry, a hot reload, or a session where `close()` never reached the plugin all
    // leave the connection registered. Registering it again throws — the plugin's own
    // words — and that must not be mistaken for a broken database.
    await fake.createConnection({ database: 'fitness_agent' });

    const { bundle } = await open();
    const settings = await buildRepositories(bundle).settings.ensureInitialized();
    assert.equal(settings.theme, DEFAULT_THEME_ID, 'the adapter is usable, not degraded');
    assert.equal(
      fake.calls.filter((call) => call === 'createConnection').length,
      2,
      'the second registration was attempted and tolerated',
    );

    await bundle.adapter.close();
  });

  it('never asks the plugin about the file before a connection is registered', async () => {
    // Regression guard: `isDBExists` used to be the first call this adapter made, and
    // the plugin throws when no connection is registered yet.
    const { bundle } = await open();
    const dbExistsCall = fake.calls.indexOf('isDBExists');
    if (dbExistsCall !== -1) {
      assert.ok(
        fake.calls.indexOf('createConnection') < dbExistsCall,
        'isDBExists must never precede createConnection',
      );
    }
    await bundle.adapter.close();
  });

  it('keeps an existing database file across a close and reopen', async () => {
    const { bundle, repos } = await open();
    await repos.training.put(createWorkout());
    assert.equal(fake.hasDatabaseFile(), true, 'the first connection created the file');

    await bundle.adapter.close();
    resetStorageForTests();

    const second = await open();
    assert.equal(fake.hasDatabaseFile(), true, 'a reopen does not delete or recreate it');
    assert.equal((await second.repos.training.all()).length, 1, 'the workout is still there');
    await second.bundle.adapter.close();
  });

  it('persists a workout aggregate and mirrors its columns', async () => {
    const { bundle, repos } = await open();
    const training = repos.training;

    const workout = await training.put(createWorkout());
    const exercise = createExerciseEntry(workout.id, 'Bench Press', 0);
    await training.upsertExercise(workout.id, {
      ...exercise,
      sets: [
        withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 60, 'kg'),
        withSetWeight(
          { ...createSetFromPrevious(undefined, 'kg'), reps: 7, isFailure: true, rpe: 10 },
          60,
          'kg',
        ),
      ],
    });
    await training.complete(workout.id);

    // Denormalized columns are populated, not just the JSON document.
    const row = fake.rawRows('workouts')[0]!;
    assert.equal(row['id'], workout.id);
    assert.equal(row['completed'], 1);
    assert.equal(row['start_time'], workout.startTime);
    assert.equal(typeof row['json'], 'string');

    // Re-open the adapter on the same "device" data.
    await bundle.adapter.close();
    resetStorageForTests();
    const second = await open();

    const history = await second.repos.training.completed();
    assert.equal(history.length, 1, 'workout read back from SQLite');
    assert.equal(history[0]?.exercises[0]?.rawName, 'Bench Press');
    assert.equal(history[0]?.exercises[0]?.sets.length, 2);
    assert.equal(history[0]?.exercises[0]?.sets[1]?.isFailure, true);
    assert.equal(history[0]?.exercises[0]?.sets[0]?.weightKg, 60);

    const summary = await second.repos.exercises.summary('Bench Press');
    assert.equal(summary?.sessionCount, 1);
    assert.equal(summary?.totalWorkingSets, 2);

    await second.bundle.adapter.close();
  });

  it('keeps settings and alias rules in separate key/value tables', async () => {
    const { bundle, repos } = await open();

    await repos.settings.patch({ defaultUnit: 'lb', aiEnabled: true, theme: 'orca' });
    await repos.rules.save({ match: 'bench', normalized: 'Bench Press' });

    assert.equal(fake.rawRows('settings').length, 1, 'settings stored as one document');
    const ruleRow = fake.rawRows('alias_rules')[0]!;
    assert.equal(ruleRow['match_name'], 'bench', 'rule match is mirrored lower-cased for lookup');
    assert.equal(await repos.rules.resolve('Bench'), 'Bench Press');

    await bundle.adapter.close();
    resetStorageForTests();
    const second = await open();

    const settings = await second.repos.settings.get();
    assert.equal(settings.defaultUnit, 'lb');
    assert.equal(settings.aiEnabled, true);
    assert.equal(settings.theme, 'orca');
    assert.equal(await second.repos.rules.count(), 1);

    await second.bundle.adapter.close();
  });

  it('stores all three summary kinds in one table and never touches workouts', async () => {
    const { bundle, repos } = await open();
    const workout = await repos.training.put(createWorkout());
    await repos.training.complete(workout.id);

    const now = new Date().toISOString();
    const base = {
      title: 'Legs.',
      body: 'Legs.',
      bullets: [],
      highlights: [],
      changes: [],
      workoutIds: [workout.id],
      sessionCount: 1,
      totalVolumeKg: 0,
      totalDurationSec: 0,
      source: 'auto' as const,
      generatedAt: now,
      updatedAt: now,
    };
    await repos.summaries.save({ ...base, id: 'sum_daily_x', kind: 'daily', periodKey: localDateKey(new Date()) });
    await repos.summaries.save({ ...base, id: 'sum_weekly_x', kind: 'weekly', periodKey: '2026-02-09' });
    await repos.summaries.save({ ...base, id: 'sum_monthly_x', kind: 'monthly', periodKey: '2026-02' });

    // The `kind` column is the denormalized mirror the schema adds for filtering.
    assert.deepEqual(
      fake.rawRows('summaries').map((row) => row['kind']).sort(),
      ['daily', 'monthly', 'weekly'],
    );
    assert.equal((await repos.summaries.ofKind('weekly')).length, 1);
    assert.equal((await repos.summaries.get('monthly', '2026-02'))?.id, 'sum_monthly_x');

    assert.equal((await repos.summaries.all()).length, 3);
    await repos.summaries.clear();
    assert.equal((await repos.summaries.all()).length, 0);
    assert.equal(
      (await repos.training.completed()).length,
      1,
      'clearing summaries leaves workouts alone',
    );

    await bundle.adapter.close();
  });

  it('stores the AI conversation in its own table and reads it back after a reopen', async () => {
    const { bundle, repos } = await open();

    await repos.aiConversation.save([
      {
        id: 'turn-1',
        role: 'coach',
        question: 'How is my bench going?',
        answer: 'Up 5 kg since March.',
        contextSections: ['recent workouts'],
        contextCharacters: 900,
        createdAt: '2026-03-01T10:00:00.000Z',
      },
    ]);

    assert.equal(fake.rawRows('ai_chat').length, 1, 'the v4 table exists and holds the row');

    // The Android path has to survive the same restart the browser path does.
    await bundle.adapter.close();
    resetStorageForTests();
    const second = await open();

    const recent = await second.repos.aiConversation.recent();
    assert.equal(recent.length, 1, 'chat read back from SQLite');
    assert.equal(recent[0]?.question, 'How is my bench going?');
    assert.deepEqual(recent[0]?.contextSections, ['recent workouts']);

    await second.repos.aiConversation.clear();
    assert.deepEqual(await second.repos.aiConversation.recent(), []);
    assert.deepEqual(fake.rawRows('ai_chat'), [], 'Clear removes the row, not just the cache');

    await second.bundle.adapter.close();
  });

  it('supports count, removal and clearing', async () => {
    const { bundle, repos } = await open();
    const training = repos.training;

    const workouts = [createWorkout(), createWorkout(), createWorkout()];
    await training.putMany(workouts);
    assert.equal(await training.count(), 3);

    await training.remove(workouts[0]!.id);
    assert.equal(await training.count(), 2);
    assert.equal(await training.get(workouts[0]!.id), null);

    await training.clear();
    assert.equal(await training.count(), 0);
    assert.deepEqual(fake.rawRows('workouts'), []);

    await bundle.adapter.close();
  });

  it('destroys the database through the plugin', async () => {
    const { bundle } = await open();
    const workout = await buildRepositories(bundle).training.put(createWorkout());
    assert.ok(await buildRepositories(bundle).training.get(workout.id));

    await bundle.adapter.destroy();
    assert.ok(fake.calls.includes('deleteDatabase'));
    assert.deepEqual(fake.rawRows('workouts'), []);
  });
});
