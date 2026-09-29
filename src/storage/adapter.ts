/**
 * Storage abstraction.
 *
 * The app never talks to a database directly; it talks to a `StorageAdapter`.
 * Two implementations exist:
 *
 *  - `idb`    → IndexedDB. Used for browser development and as a universal fallback.
 *  - `sqlite` → Capacitor SQLite. Used on Android.
 *
 * Both use the same shape: named collections of JSON records plus a small
 * key/value area for settings. Keeping the contract this narrow means we can
 * swap or migrate storage without touching repositories, pages, or components.
 *
 * NOTE ON SCHEMA: records are stored as JSON documents. That is intentional for
 * the MVP — a workout is always read as a whole aggregate (workout → exercises →
 * sets), so document storage matches the access pattern and keeps migrations
 * trivial. A later phase can add normalized SQL columns for aggregate analytics
 * behind this same interface.
 */

export type CollectionName = 'workouts' | 'rules' | 'summaries' | 'meals' | 'reminders' | 'plans';

/**
 * Key/value areas. `images` holds one compressed data URL per meal photo — one row
 * per picture, so capturing a new photo never rewrites the existing ones.
 */
export type KeyValueName = 'settings' | 'presets' | 'images' | 'profile' | 'aiChat';

/** A store area that holds many records keyed by `id`. */
export interface Collection<T extends { id: string }> {
  all(): Promise<T[]>;
  get(id: string): Promise<T | null>;
  put(record: T): Promise<void>;
  putMany(records: T[]): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  count(): Promise<number>;
}

/** A store area that holds a handful of named documents. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface StorageScope {
  collection<T extends { id: string }>(name: CollectionName): Collection<T>;
  kv(name: KeyValueName): KeyValueStore;
}

export interface StorageAdapter {
  /** Human-readable id shown in Settings → Storage. */
  readonly kind: 'indexeddb' | 'sqlite';
  /** Path or database name, shown for transparency. */
  readonly label: string;
  init(): Promise<void>;
  scope(): StorageScope;
  close(): Promise<void>;
  /** Delete everything. Used by "Reset local data". */
  destroy(): Promise<void>;
}

/** In-memory cache in front of an adapter: avoids re-reading the whole store on every render. */
export class CollectionCache<T extends { id: string }> implements Collection<T> {
  private cache: Map<string, T> | null = null;

  constructor(private readonly inner: Collection<T>) {}

  private async ensure(): Promise<Map<string, T>> {
    if (!this.cache) {
      const rows = await this.inner.all();
      this.cache = new Map(rows.map((row) => [row.id, row]));
    }
    return this.cache;
  }

  async all(): Promise<T[]> {
    const cache = await this.ensure();
    return [...cache.values()];
  }

  async get(id: string): Promise<T | null> {
    const cache = await this.ensure();
    return cache.get(id) ?? null;
  }

  async put(record: T): Promise<void> {
    await this.inner.put(record);
    const cache = await this.ensure();
    cache.set(record.id, record);
  }

  async putMany(records: T[]): Promise<void> {
    if (records.length === 0) return;
    await this.inner.putMany(records);
    const cache = await this.ensure();
    for (const record of records) cache.set(record.id, record);
  }

  async remove(id: string): Promise<void> {
    await this.inner.remove(id);
    const cache = await this.ensure();
    cache.delete(id);
  }

  async clear(): Promise<void> {
    await this.inner.clear();
    this.cache = new Map();
  }

  async count(): Promise<number> {
    const cache = await this.ensure();
    return cache.size;
  }

  /** Drop the cache so the next read re-reads from the adapter (used after import). */
  invalidate(): void {
    this.cache = null;
  }
}
