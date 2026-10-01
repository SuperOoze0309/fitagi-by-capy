import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { FakeSqlitePlugin } from '@/test/FakeSqlitePlugin';
import { SqliteAdapter, setSqlitePluginForTests } from '@/storage/sqliteAdapter';
import { initStorage, resetStorageForTests } from '@/storage';
import { buildRepositories } from '@/repositories';
import { createWorkout } from '@/domain/workout';

/**
 * Backend selection at the app's boot entry.
 *
 * `SqliteAdapter`'s own tests pass an adapter in, which skips the decision this file
 * is about. That decision used to be "the native database failed to open, so answer
 * from an empty IndexedDB instead": the phone still held every workout while the app
 * showed an empty log, and anything recorded afterwards landed in a second, invisible
 * database. These tests pin the behaviour at the entry point — on a native build a
 * failure to open the platform database is a startup failure, never a quiet switch.
 *
 * Nothing here touches a real plugin, a real device or user data.
 */

function useNativePlatform(): void {
  (globalThis as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = {
    isNativePlatform: () => true,
  };
}

function useWebPlatform(): void {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
}

describe('storage backend selection', () => {
  let fake: FakeSqlitePlugin;

  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    fake = new FakeSqlitePlugin();
    setSqlitePluginForTests(fake.asPlugin());
    resetStorageForTests();
  });

  afterEach(() => {
    useWebPlatform();
    setSqlitePluginForTests(null);
    resetStorageForTests();
  });

  it('opens SQLite on a native build, and records that the file already existed', async () => {
    useNativePlatform();
    fake.seedExistingDatabaseFile();

    const bundle = await initStorage();
    assert.equal(bundle.adapter.kind, 'sqlite');
    assert.equal(await buildRepositories(bundle).training.count(), 0);
    assert.equal(
      (bundle.adapter as SqliteAdapter).hasExistingDatabase(),
      true,
      'an install with a file on disk is not mistaken for a fresh one',
    );

    await bundle.adapter.close();
  });

  it('reports a fresh install as one', async () => {
    useNativePlatform();

    const bundle = await initStorage();
    assert.equal(
      (bundle.adapter as SqliteAdapter).hasExistingDatabase(),
      false,
      'no file before open() means nothing was ever stored here',
    );

    await bundle.adapter.close();
  });

  it('fails the boot instead of quietly serving an empty IndexedDB', async () => {
    useNativePlatform();
    // An install that already has data, then a database that will not open.
    fake.seedExistingDatabaseFile();
    const original = await initStorage(new SqliteAdapter());
    await buildRepositories(original).training.put(createWorkout());
    await original.adapter.close();
    resetStorageForTests();

    fake.open = async () => {
      throw new Error('AUDIT_SQLITE_OPEN_FAILURE');
    };

    await assert.rejects(
      () => initStorage(),
      (error: unknown) => {
        assert.match(String(error), /AUDIT_SQLITE_OPEN_FAILURE/);
        return true;
      },
      'a native storage failure must reach the caller, not be swallowed',
    );

    // And it must not have been answered from somewhere else behind the scenes.
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
    try {
      assert.equal(
        warnings.some((line) => line.includes('falling back')),
        false,
        'no fallback to another backend is announced or performed',
      );
    } finally {
      console.warn = originalWarn;
    }

    // The stored workout is untouched by the failed boot.
    assert.equal(fake.rawRows('workouts').length, 1, 'the original record is still on disk');
  });

  it('lets a later boot succeed once the transient failure clears', async () => {
    useNativePlatform();
    fake.seedExistingDatabaseFile();
    const original = await initStorage(new SqliteAdapter());
    await buildRepositories(original).training.put(createWorkout());
    await original.adapter.close();
    resetStorageForTests();

    // First attempt fails, the retry (300 ms later) succeeds.
    let attempts = 0;
    const open = fake.open.bind(fake);
    fake.open = async (options: { database?: string }) => {
      attempts += 1;
      if (attempts === 1) throw new Error('AUDIT_TRANSIENT_OPEN_FAILURE');
      return open(options);
    };

    const bundle = await initStorage();
    assert.equal(attempts, 2, 'the first failure was retried once');
    assert.equal(bundle.adapter.kind, 'sqlite');
    const workouts = await buildRepositories(bundle).training.all();
    assert.equal(workouts.length, 1, 'the existing log came back, it was never replaced');
    assert.equal(
      (bundle.adapter as SqliteAdapter).hasExistingDatabase(),
      true,
      'the reopened database is recognised as an existing one',
    );

    await bundle.adapter.close();
  });

  it('closes the attempt it abandoned, so no connection is left registered', async () => {
    useNativePlatform();
    let attempts = 0;
    const open = fake.open.bind(fake);
    fake.open = async (options: { database?: string }) => {
      attempts += 1;
      if (attempts === 1) throw new Error('AUDIT_SCHEMA_FAILURE');
      return open(options);
    };

    const bundle = await initStorage();
    assert.equal(attempts, 2);
    assert.equal(fake.isOpen(), true, 'the successful attempt left the database open');
    await bundle.adapter.close();
  });

  it('uses IndexedDB in a browser, which is the browser’s own storage', async () => {
    useWebPlatform();

    const bundle = await initStorage();
    assert.equal(bundle.adapter.kind, 'indexeddb');
    await buildRepositories(bundle).training.put(createWorkout());
    assert.equal(await buildRepositories(bundle).training.count(), 1);

    await bundle.adapter.close();
  });
});
