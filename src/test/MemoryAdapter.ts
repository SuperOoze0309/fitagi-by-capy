import type {
  Collection,
  CollectionName,
  KeyValueName,
  KeyValueStore,
  StorageAdapter,
  StorageScope,
} from '@/storage/adapter';

/**
 * In-memory StorageAdapter used by tests.
 *
 * Implements the same contract as the IndexedDB and SQLite adapters, so the
 * repository layer can be exercised without a browser or a native plugin.
 * `snapshot()` exposes the raw rows so a test can assert that data really was
 * "written to disk" and can survive a simulated app restart.
 */
export class MemoryAdapter implements StorageAdapter {
  readonly kind = 'indexeddb' as const;
  readonly label = 'memory';

  private collections = new Map<CollectionName, Map<string, unknown>>();
  private keyValues = new Map<KeyValueName, Map<string, unknown>>();
  /** Insertion order per collection, so `all()` returns rows deterministically. */
  private order = new Map<CollectionName, string[]>();

  async init(): Promise<void> {
    /* nothing to do */
  }

  scope(): StorageScope {
    return {
      collection: <T extends { id: string }>(name: CollectionName) =>
        new MemoryCollection<T>(this, name),
      kv: (name: KeyValueName) => new MemoryKeyValue(this, name),
    };
  }

  async close(): Promise<void> {
    /* nothing to do */
  }

  async destroy(): Promise<void> {
    this.collections.clear();
    this.keyValues.clear();
    this.order.clear();
  }

  /** Raw dump, as if read straight off the device. */
  snapshot(): {
    collections: Record<string, unknown[]>;
    keyValues: Record<string, unknown[]>;
  } {
    const collections: Record<string, unknown[]> = {};
    for (const [name, rows] of this.collections) {
      collections[name] = (this.order.get(name) ?? [])
        .map((id) => rows.get(id))
        .filter((row) => row !== undefined);
    }
    const keyValues: Record<string, unknown[]> = {};
    for (const [name, map] of this.keyValues) keyValues[name] = [...map.entries()];
    return { collections, keyValues };
  }

  // -- internal API used by the scoped handles ---------------------------------

  getMap(name: CollectionName): Map<string, unknown> {
    let map = this.collections.get(name);
    if (!map) {
      map = new Map();
      this.collections.set(name, map);
      this.order.set(name, []);
    }
    return map;
  }

  trackKey(name: CollectionName, id: string): void {
    const ids = this.order.get(name);
    if (ids && !ids.includes(id)) ids.push(id);
  }

  untrackKey(name: CollectionName, id: string): void {
    const ids = this.order.get(name);
    if (ids) this.order.set(name, ids.filter((existing) => existing !== id));
  }

  getKeyValueMap(name: KeyValueName): Map<string, unknown> {
    let map = this.keyValues.get(name);
    if (!map) {
      map = new Map();
      this.keyValues.set(name, map);
    }
    return map;
  }
}

class MemoryCollection<T extends { id: string }> implements Collection<T> {
  constructor(
    private readonly adapter: MemoryAdapter,
    private readonly name: CollectionName,
  ) {}

  async all(): Promise<T[]> {
    const map = this.adapter.getMap(this.name);
    return [...map.values()] as T[];
  }

  async get(id: string): Promise<T | null> {
    return (this.adapter.getMap(this.name).get(id) as T | undefined) ?? null;
  }

  async put(record: T): Promise<void> {
    await this.putMany([record]);
  }

  async putMany(records: T[]): Promise<void> {
    const map = this.adapter.getMap(this.name);
    for (const record of records) {
      map.set(record.id, structuredClone(record));
      this.adapter.trackKey(this.name, record.id);
    }
  }

  async remove(id: string): Promise<void> {
    this.adapter.getMap(this.name).delete(id);
    this.adapter.untrackKey(this.name, id);
  }

  async clear(): Promise<void> {
    const map = this.adapter.getMap(this.name);
    for (const id of map.keys()) this.adapter.untrackKey(this.name, id);
    map.clear();
  }

  async count(): Promise<number> {
    return this.adapter.getMap(this.name).size;
  }
}

class MemoryKeyValue implements KeyValueStore {
  constructor(
    private readonly adapter: MemoryAdapter,
    private readonly name: KeyValueName,
  ) {}

  async get<V>(key: string): Promise<V | null> {
    return (this.adapter.getKeyValueMap(this.name).get(key) as V | undefined) ?? null;
  }

  async set<V>(key: string, value: V): Promise<void> {
    this.adapter.getKeyValueMap(this.name).set(key, structuredClone(value));
  }

  async remove(key: string): Promise<void> {
    this.adapter.getKeyValueMap(this.name).delete(key);
  }
}
