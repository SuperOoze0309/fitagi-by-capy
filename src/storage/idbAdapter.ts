import type {
  Collection,
  CollectionName,
  KeyValueName,
  KeyValueStore,
  StorageAdapter,
  StorageScope,
} from './adapter';

const DB_NAME = 'fitness-agent';
/**
 * Bumped to 4 to add the local AI conversation store.
 *
 * `onupgradeneeded` creates whatever is missing, so an existing database keeps all
 * of its object stores and only gains the new ones — no version bump has ever
 * dropped a row, and none may.
 */
const DB_VERSION = 4;

const COLLECTIONS: CollectionName[] = [
  'workouts',
  'rules',
  'summaries',
  'meals',
  'reminders',
  'plans',
];
const KEY_VALUE_STORES: KeyValueName[] = ['settings', 'presets', 'images', 'profile', 'aiChat'];

/**
 * IndexedDB adapter — used when running in a browser (`npm run dev`) and as the
 * fallback if the native SQLite plugin is unavailable.
 */
export class IndexedDbAdapter implements StorageAdapter {
  readonly kind = 'indexeddb' as const;
  readonly label = `IndexedDB · ${DB_NAME}`;

  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    if (this.db) return;
    this.db = await openDatabase();
  }

  scope(): StorageScope {
    // Resolve the handle lazily: a scope can outlive one connection (close +
    // re-init), and a captured IDBDatabase would then be closed and unusable.
    const getDb = () => this.requireDb();
    return {
      collection: <T extends { id: string }>(name: CollectionName) =>
        new IndexedDbCollection<T>(getDb, name),
      kv: (name: KeyValueName) => new IndexedDbKeyValue(getDb, name),
    };
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async destroy(): Promise<void> {
    await this.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Failed to delete database'));
      request.onblocked = () => resolve();
    });
  }

  private requireDb(): IDBDatabase {
    if (!this.db) throw new Error('IndexedDbAdapter.init() must be awaited before use');
    return this.db;
  }
}

/**
 * Ceiling on a single storage operation.
 *
 * IndexedDB can leave a request pending indefinitely — a transaction waits behind
 * another transaction on the same store, and if that one never finishes, neither does
 * this one. There is no event to catch in that case, so an unbounded promise is a
 * promise that may never settle, and the page awaiting it shows its loading state
 * forever. Local storage that takes this long has failed; saying so lets the caller
 * show an error the user can act on.
 */
const OPERATION_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`IndexedDB ${what} did not complete within ${OPERATION_TIMEOUT_MS}ms`));
    }, OPERATION_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this environment'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [...COLLECTIONS, ...KEY_VALUE_STORES]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
    /*
     * A schema upgrade blocks while another connection to the same database is open,
     * and an unhandled `blocked` event leaves this promise pending forever — which
     * shows up as an app stuck on its splash screen rather than as an error. Failing
     * loudly is the only useful behaviour here: the caller has a fallback path, and a
     * silent hang has none.
     */
    request.onblocked = () =>
      reject(
        new Error(
          'IndexedDB upgrade is blocked by another open connection to this app. Close other tabs and reload.',
        ),
      );
  });
}

/** Wrap one request in a promise. */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function runTransaction(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  run: (objectStore: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    run(tx.objectStore(store));
  });
}

class IndexedDbCollection<T extends { id: string }> implements Collection<T> {
  constructor(
    private readonly getDb: () => IDBDatabase,
    private readonly store: string,
  ) {}

  async all(): Promise<T[]> {
    const db = this.getDb();
    const tx = db.transaction(this.store, 'readonly');
    const rows = await withTimeout(
      promisify(tx.objectStore(this.store).getAll() as IDBRequest<T[]>),
      `read of ${this.store}`,
    );
    return rows;
  }

  async get(id: string): Promise<T | null> {
    const db = this.getDb();
    const tx = db.transaction(this.store, 'readonly');
    const row = await withTimeout(
      promisify(tx.objectStore(this.store).get(id) as IDBRequest<T | undefined>),
      `read of ${this.store}`,
    );
    return row ?? null;
  }

  async put(record: T): Promise<void> {
    await withTimeout(
      runTransaction(this.getDb(), this.store, 'readwrite', (store) => {
        store.put(record as unknown as Record<string, unknown>);
      }),
      `write to ${this.store}`,
    );
  }

  async putMany(records: T[]): Promise<void> {
    if (records.length === 0) return;
    await withTimeout(
      runTransaction(this.getDb(), this.store, 'readwrite', (store) => {
        for (const record of records) store.put(record as unknown as Record<string, unknown>);
      }),
      `bulk write to ${this.store}`,
    );
  }

  async remove(id: string): Promise<void> {
    await runTransaction(this.getDb(), this.store, 'readwrite', (store) => {
      store.delete(id);
    });
  }

  async clear(): Promise<void> {
    await runTransaction(this.getDb(), this.store, 'readwrite', (store) => {
      store.clear();
    });
  }

  async count(): Promise<number> {
    const db = this.getDb();
    const tx = db.transaction(this.store, 'readonly');
    return promisify(tx.objectStore(this.store).count());
  }
}

class IndexedDbKeyValue implements KeyValueStore {
  constructor(
    private readonly getDb: () => IDBDatabase,
    private readonly store: string,
  ) {}

  async get<V>(key: string): Promise<V | null> {
    const db = this.getDb();
    const tx = db.transaction(this.store, 'readonly');
    const row = await promisify(
      tx.objectStore(this.store).get(key) as IDBRequest<{ id: string; value: V } | undefined>,
    );
    return row ? row.value : null;
  }

  async set<V>(key: string, value: V): Promise<void> {
    await runTransaction(this.getDb(), this.store, 'readwrite', (store) => {
      store.put({ id: key, value });
    });
  }

  async remove(key: string): Promise<void> {
    await runTransaction(this.getDb(), this.store, 'readwrite', (store) => {
      store.delete(key);
    });
  }
}
