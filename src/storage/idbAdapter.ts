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
 * IndexedDB adapter — the browser's own storage. Native SQLite failures do not
 * silently switch to this independent database.
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
      const timer = setTimeout(() => reject(new Error('IndexedDB deletion timed out; close other tabs.')), OPERATION_TIMEOUT_MS);
      request.onsuccess = () => { clearTimeout(timer); resolve(); };
      request.onerror = () => { clearTimeout(timer); reject(request.error ?? new Error('Failed to delete database')); };
      // A blocked delete is still pending. Never announce success before onsuccess.
      request.onblocked = () => { /* Wait for other connections to close, bounded above. */ };
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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this environment'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      reject(new Error('IndexedDB open timed out'));
    }, OPERATION_TIMEOUT_MS);
    request.onupgradeneeded = () => {
      if (failed) { request.transaction?.abort(); return; }
      const db = request.result;
      for (const name of [...COLLECTIONS, ...KEY_VALUE_STORES]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (failed) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => { clearTimeout(timer); failed = true; reject(request.error ?? new Error('Failed to open IndexedDB')); };
    /*
     * A schema upgrade blocks while another connection to the same database is open,
     * and an unhandled `blocked` event leaves this promise pending forever — which
     * shows up as an app stuck on its splash screen rather than as an error. Failing
     * loudly is the only useful behaviour here: the caller has a fallback path, and a
     * silent hang has none.
     */
    request.onblocked = () => {
      failed = true;
      clearTimeout(timer);
      reject(
        new Error(
          'IndexedDB upgrade is blocked by another open connection to this app. Close other tabs and reload.',
        ),
      );
    };
  });
}

/** Resolve only on commit; a deadline aborts the transaction so a late write cannot land. */
function transaction<T = void>(
  db: IDBDatabase, store: string, mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let request: IDBRequest<T> | void;
    const fail = (error: unknown) => { clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => {
      fail(new Error(`IndexedDB operation on ${store} timed out`));
      try { tx.abort(); } catch { /* Already completed. */ }
    }, OPERATION_TIMEOUT_MS);
    tx.oncomplete = () => { clearTimeout(timer); resolve(request ? request.result : undefined as T); };
    tx.onerror = () => fail(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => fail(tx.error ?? new Error('IndexedDB transaction aborted'));
    try { request = run(tx.objectStore(store)); }
    catch (error) { try { tx.abort(); } catch { /* Already aborted. */ } fail(error); }
  });
}

class IndexedDbCollection<T extends { id: string }> implements Collection<T> {
  constructor(private readonly getDb: () => IDBDatabase, private readonly store: string) {}
  all(): Promise<T[]> {
    return transaction<T[]>(this.getDb(), this.store, 'readonly', (store) => store.getAll());
  }
  async get(id: string): Promise<T | null> {
    return (await transaction<T | undefined>(this.getDb(), this.store, 'readonly', (store) => store.get(id))) ?? null;
  }
  async put(record: T): Promise<void> { await this.putMany([record]); }
  async putMany(records: T[]): Promise<void> {
    if (records.length === 0) return;
    await transaction(this.getDb(), this.store, 'readwrite', (store) => {
      for (const record of records) store.put(record);
    });
  }
  async remove(id: string): Promise<void> {
    await transaction(this.getDb(), this.store, 'readwrite', (store) => { store.delete(id); });
  }
  async clear(): Promise<void> {
    await transaction(this.getDb(), this.store, 'readwrite', (store) => { store.clear(); });
  }
  count(): Promise<number> {
    return transaction<number>(this.getDb(), this.store, 'readonly', (store) => store.count());
  }
}

class IndexedDbKeyValue implements KeyValueStore {
  constructor(private readonly getDb: () => IDBDatabase, private readonly store: string) {}
  async get<V>(key: string): Promise<V | null> {
    const row = await transaction<{ id: string; value: V } | undefined>(this.getDb(), this.store, 'readonly', (store) => store.get(key));
    return row ? row.value : null;
  }
  async set<V>(key: string, value: V): Promise<void> {
    await transaction(this.getDb(), this.store, 'readwrite', (store) => { store.put({ id: key, value }); });
  }
  async remove(key: string): Promise<void> {
    await transaction(this.getDb(), this.store, 'readwrite', (store) => { store.delete(key); });
  }
}
