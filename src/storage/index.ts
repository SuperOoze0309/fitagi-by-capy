import type { StorageAdapter, Collection, KeyValueStore, StorageScope } from './adapter';
import { CollectionCache } from './adapter';
import { IndexedDbAdapter } from './idbAdapter';
import { SqliteAdapter } from './sqliteAdapter';
import type { AliasRule, Meal, Reminder, TrainingPlan, TrainingSummary, Workout } from '../domain/types';

export interface StorageBundle {
  adapter: StorageAdapter;
  /** Live scope for this adapter; use it instead of calling adapter.scope() again. */
  scope: StorageScope;
  workouts: Collection<Workout>;
  rules: Collection<AliasRule>;
  summaries: Collection<TrainingSummary>;
  meals: Collection<Meal>;
  reminders: Collection<Reminder>;
  plans: Collection<TrainingPlan>;
  /** One row per meal photo. */
  images: KeyValueStore;
  invalidateCaches: () => void;
}

let bundle: StorageBundle | null = null;
/**
 * The in-flight initialisation.
 *
 * `main.tsx` and the smoke entry point both call `initStorage()` while the app boots.
 * Caching only the *result* meant both calls proceeded, opened the database twice and
 * raced on the schema upgrade — and a blocked upgrade never settles, so the app sat on
 * its splash screen. Caching the promise makes the second caller wait for the first.
 */
let initialising: Promise<StorageBundle> | null = null;
let destroying: Promise<void> | null = null;

/**
 * Pick the storage backend for the current platform.
 *
 * Android → SQLite (production). Browser → IndexedDB, which *is* the browser's
 * storage rather than a consolation prize.
 *
 * The two are never mixed. On a native build a SQLite failure used to be logged and
 * then quietly answered by an empty IndexedDB: the phone still held every workout,
 * but the app showed an empty log, and anything recorded from then on went into a
 * second, invisible database. A failure to open the platform's own database is a
 * startup failure, and it is reported as one — the splash screen explains it and
 * offers a retry — because "your data is still on this phone" and "here is an empty
 * app" cannot both be true.
 *
 * One retry first, for a race that is not a failure: a reload can begin before the
 * previous page has finished upgrading the database, and an open is then blocked
 * until the old connection goes away.
 */
async function createAdapter(): Promise<StorageAdapter> {
  const native = isNativePlatform();

  const attempt = async (): Promise<StorageAdapter> => {
    const adapter: StorageAdapter = native ? new SqliteAdapter() : new IndexedDbAdapter();
    await adapter.init();
    return adapter;
  };

  try {
    return await attempt();
  } catch (error) {
    console.warn('[storage] open failed, retrying once', native ? 'SQLite' : 'IndexedDB', error);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return attempt();
}

export function isNativePlatform(): boolean {
  const capacitor = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return typeof capacitor?.isNativePlatform === 'function' && capacitor.isNativePlatform();
}

/**
 * Initialise storage once per app start and hand back cached collections.
 *
 * Caching matters: History, Exercise pages and the Home summary all read the
 * same workouts, and this keeps those reads synchronous-ish after first load.
 * Tests pass their own adapter to run the same code path without a browser.
 */
export async function initStorage(adapter?: StorageAdapter): Promise<StorageBundle> {
  if (destroying) await destroying;
  if (bundle) return bundle;
  if (initialising) return initialising;

  initialising = (async () => {
    const resolved = adapter ?? (await createAdapter());
    await resolved.init();
    const scope = resolved.scope();
    const workouts = new CollectionCache<Workout>(scope.collection<Workout>('workouts'));
    const rules = new CollectionCache<AliasRule>(scope.collection<AliasRule>('rules'));
    const summaries = new CollectionCache<TrainingSummary>(
      scope.collection<TrainingSummary>('summaries'),
    );
    const meals = new CollectionCache<Meal>(scope.collection<Meal>('meals'));
    const reminders = new CollectionCache<Reminder>(scope.collection<Reminder>('reminders'));
    const plans = new CollectionCache<TrainingPlan>(scope.collection<TrainingPlan>('plans'));
    const images = scope.kv('images');

    bundle = {
      adapter: resolved,
      scope,
      workouts,
      rules,
      summaries,
      meals,
      reminders,
      plans,
      images,
      invalidateCaches: () => {
        workouts.invalidate();
        rules.invalidate();
        summaries.invalidate();
        meals.invalidate();
        reminders.invalidate();
        plans.invalidate();
      },
    };
    return bundle;
  })();

  try {
    return await initialising;
  } catch (error) {
    // A failed attempt must not be cached, or a retry would replay the same failure.
    initialising = null;
    throw error;
  }
}

export function getStorage(): StorageBundle {
  if (!bundle) throw new Error('Storage not initialised. Call initStorage() first.');
  return bundle;
}

/**
 * Wait until storage is ready.
 *
 * `main.tsx` initialises storage asynchronously during boot. Anything that starts
 * outside that sequence (the smoke entry point, or a future background task) needs
 * to wait rather than assume the order.
 */
export function whenStorageReady(timeoutMs = 15000): Promise<StorageBundle> {
  if (bundle) return Promise.resolve(bundle);
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (bundle) {
        resolve(bundle);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('Storage did not become ready in time.'));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

/** Drop all locally stored records. */
export async function destroyStorage(): Promise<void> {
  if (destroying) return destroying;
  const run = (async () => {
    const current = bundle ?? (initialising ? await initialising : null);
    if (current) await current.adapter.destroy();
    bundle = null;
    initialising = null;
  })();
  destroying = run;
  try { await run; } finally { if (destroying === run) destroying = null; }
}

/** Forget the singleton so a test can start from a clean slate. */
export function resetStorageForTests(): void {
  bundle = null;
  initialising = null;
  destroying = null;
}
