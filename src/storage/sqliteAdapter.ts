import type { CapacitorSQLitePlugin } from '@capacitor-community/sqlite';
import type {
  Collection,
  CollectionName,
  KeyValueName,
  KeyValueStore,
  StorageAdapter,
  StorageScope,
} from './adapter';

const DB_NAME = 'fitness_agent';
/**
 * Bumped to 4 for the local AI conversation table.
 * The schema is a list of `CREATE TABLE IF NOT EXISTS`, so upgrading an existing
 * database adds only what is missing and leaves every existing row untouched.
 */
const SCHEMA_VERSION = 4;

/**
 * SQLite adapter — the Android production store.
 *
 * The plugin is imported type-only plus a dynamic runtime import, so it is never
 * part of the web bundle: `vite build` and `npm run dev` work on a machine with no
 * native module, and the browser transparently uses the IndexedDB adapter.
 *
 * Rows are `(id TEXT PRIMARY KEY, json TEXT, ...)` documents. A workout is always
 * read as a whole aggregate (workout -> exercises -> sets), so document storage
 * matches the access pattern and keeps schema migrations trivial; the extra
 * columns are denormalized mirrors for ordering and future analytics.
 *
 * API note: plugin v7 exposes one flat plugin object where every call carries the
 * database name (`query({ database, statement, values })`). There is no separate
 * connection handle to keep around.
 */
export class SqliteAdapter implements StorageAdapter {
  readonly kind = 'sqlite' as const;
  readonly label = `SQLite · ${DB_NAME}.db`;

  private plugin: CapacitorSQLitePlugin | null = null;

  async init(): Promise<void> {
    if (this.plugin) return;
    const plugin = await loadPlugin();

    /*
     * The plugin's connection contract, taken from its own native source
     * (`CapacitorSQLite.java`): every method except `createConnection` first looks
     * the connection up in a per-process map and throws
     * "No available connection for database <name>" when it is missing — including
     * `isDBExists`, which reads the file only to answer a question about a connection
     * that must already exist. So the connection is established *first*, and the file
     * is inspected afterwards.
     *
     * `createConnection` throws "Connection <name> already exists" when the map still
     * holds one, which is exactly what happens on a retry, after a hot reload, or when
     * `close()` did not reach the plugin. Registering a connection is idempotent from
     * this adapter's point of view, so that outcome is accepted and work continues;
     * anything else is a real failure and propagates.
     */
    try {
      await plugin.createConnection({
        database: DB_NAME,
        version: SCHEMA_VERSION,
        encrypted: false,
        mode: 'no-encryption',
        readonly: false,
      });
    } catch (error) {
      if (!isAlreadyConnected(error)) throw error;
    }

    await plugin.open({ database: DB_NAME, readonly: false });
    // Additive by construction (`CREATE TABLE IF NOT EXISTS`), which is also what
    // carries an older database across a schema bump.
    await plugin.execute({ database: DB_NAME, statements: SCHEMA });
    this.plugin = plugin;
  }

  scope(): StorageScope {
    const plugin = this.requirePlugin();
    return {
      collection: <T extends { id: string }>(name: CollectionName) =>
        new SqliteCollection<T>(plugin, COLLECTION_META[name]),
      kv: (name: KeyValueName) => new SqliteKeyValue(plugin, KEY_VALUE_TABLES[name]),
    };
  }

  async close(): Promise<void> {
    if (!this.plugin) return;
    const plugin = this.plugin;
    this.plugin = null;
    try {
      await plugin.close({ database: DB_NAME, readonly: false });
    } catch (error) {
      console.warn('[storage] closing SQLite connection failed', error);
    }
  }

  async destroy(): Promise<void> {
    await this.close();
    const plugin = await loadPlugin();
    await plugin.deleteDatabase({ database: DB_NAME, readonly: false });
  }

  private requirePlugin(): CapacitorSQLitePlugin {
    if (!this.plugin) throw new Error('SqliteAdapter.init() must be awaited before use');
    return this.plugin;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workouts (
  id TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  completed INTEGER DEFAULT 0,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workouts_start ON workouts (start_time DESC);
CREATE TABLE IF NOT EXISTS alias_rules (
  id TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL,
  match_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_rules_match ON alias_rules (match_name);
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL,
  kind TEXT NOT NULL,
  date TEXT
);
CREATE INDEX IF NOT EXISTS idx_summaries_kind_date ON summaries (kind, date DESC);
CREATE TABLE IF NOT EXISTS meals (
  id TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL,
  eaten_at TEXT,
  source TEXT,
  calories REAL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_meals_eaten ON meals (eaten_at DESC);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL,
  time TEXT,
  enabled INTEGER,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL,
  active INTEGER,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY NOT NULL,
  value TEXT
);
CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY NOT NULL,
  value TEXT
);
CREATE TABLE IF NOT EXISTS profile (
  id TEXT PRIMARY KEY NOT NULL,
  value TEXT
);
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY NOT NULL,
  value TEXT
);
CREATE TABLE IF NOT EXISTS ai_chat (
  id TEXT PRIMARY KEY NOT NULL,
  value TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  id TEXT PRIMARY KEY NOT NULL,
  value TEXT
);
`;

interface CollectionMeta {
  table: string;
  /** Extra SQL filter applied to every read on this collection. */
  where: string;
}

const COLLECTION_META: Record<CollectionName, CollectionMeta> = {
  workouts: { table: 'workouts', where: '' },
  rules: { table: 'alias_rules', where: '' },
  // All summary kinds share one table; the adapter no longer filters by kind so
  // the repository can see every row (weekly and monthly included).
  summaries: { table: 'summaries', where: '' },
  meals: { table: 'meals', where: '' },
  reminders: { table: 'reminders', where: '' },
  plans: { table: 'plans', where: '' },
};

const KEY_VALUE_TABLES: Record<KeyValueName, string> = {
  settings: 'settings',
  presets: 'presets',
  profile: 'profile',
  images: 'images',
  aiChat: 'ai_chat',
};

let pluginPromise: Promise<CapacitorSQLitePlugin> | null = null;
let pluginOverride: CapacitorSQLitePlugin | null = null;

/**
 * Inject a plugin instance instead of loading the native module. Used by tests to
 * exercise the adapter's real SQL against an in-memory double.
 */
export function setSqlitePluginForTests(plugin: CapacitorSQLitePlugin | null): void {
  pluginOverride = plugin;
  pluginPromise = null;
}

/** Load the native plugin lazily, keeping it out of the web bundle. */
async function loadPlugin(): Promise<CapacitorSQLitePlugin> {
  if (pluginOverride) return pluginOverride;
  if (!pluginPromise) {
    pluginPromise = (async () => {
      const moduleName = '@capacitor-community/sqlite';
      const mod = (await import(
        /* @vite-ignore */ moduleName
      )) as typeof import('@capacitor-community/sqlite');
      return mod.CapacitorSQLite;
    })();
  }
  return pluginPromise;
}

/**
 * True when the plugin refused to register a connection because one is already
 * registered for this database. That is not a failure: the connection this adapter
 * needs is present, which is the whole point of the call.
 *
 * Matched on the message rather than an error code, because the plugin reports
 * failures as strings ("Connection <name> already exists", wrapped by the bridge as
 * "CreateConnection: ..."). The comparison is case-insensitive and tolerates both
 * wordings so a message tweak in a plugin upgrade degrades into "treated as a real
 * failure" — loud, never silent data loss.
 */
function isAlreadyConnected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists/i.test(message);
}

/** `query` returns loosely-typed rows; narrow them once, here. */
function resultRows(result: { values?: unknown[] }): Record<string, unknown>[] {
  const values = result.values ?? [];
  return values.filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
  );
}

/** Read one JSON document out of a row. */
function parseJson<T>(row: Record<string, unknown> | undefined): T | null {
  const raw = row?.['json'];
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

class SqliteCollection<T extends { id: string }> implements Collection<T> {
  constructor(
    private readonly plugin: CapacitorSQLitePlugin,
    private readonly meta: CollectionMeta,
  ) {}

  private where(extra = ''): string {
    const clauses = [this.meta.where, extra].filter((clause) => clause !== '');
    return clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  }

  private query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }> {
    return this.plugin.query({ database: DB_NAME, statement, values: values ?? [] });
  }

  private run(statement: string, values?: unknown[]): Promise<unknown> {
    return this.plugin.run({ database: DB_NAME, statement, values: values ?? [] });
  }

  async all(): Promise<T[]> {
    const result = await this.query(
      `SELECT json FROM ${this.meta.table}${this.where()} ORDER BY rowid ASC;`,
    );
    return resultRows(result)
      .map((row) => parseJson<T>(row))
      .filter((row): row is T => row !== null);
  }

  async get(id: string): Promise<T | null> {
    const result = await this.query(
      `SELECT json FROM ${this.meta.table}${this.where('id = ?')} LIMIT 1;`,
      [id],
    );
    return parseJson<T>(resultRows(result)[0]);
  }

  async put(record: T): Promise<void> {
    await this.putMany([record]);
  }

  async putMany(records: T[]): Promise<void> {
    if (records.length === 0) return;
    await this.plugin.executeSet({
      database: DB_NAME,
      transaction: true,
      set: records.map((record) => ({
        statement: this.upsertSql(),
        values: this.upsertValues(record),
      })),
    });
  }

  async remove(id: string): Promise<void> {
    await this.run(`DELETE FROM ${this.meta.table} WHERE id = ?;`, [id]);
  }

  async clear(): Promise<void> {
    await this.run(`DELETE FROM ${this.meta.table}${this.where()};`, []);
  }

  async count(): Promise<number> {
    const result = await this.query(
      `SELECT COUNT(*) AS n FROM ${this.meta.table}${this.where()};`,
    );
    const value = resultRows(result)[0]?.['n'];
    return typeof value === 'number' ? value : Number(value ?? 0);
  }

  private upsertSql(): string {
    switch (this.meta.table) {
      case 'workouts':
        return `INSERT OR REPLACE INTO workouts (id, json, start_time, end_time, completed, updated_at)
                VALUES (?, ?, ?, ?, ?, ?);`;
      case 'alias_rules':
        return `INSERT OR REPLACE INTO alias_rules (id, json, match_name) VALUES (?, ?, ?);`;
      case 'summaries':
        return `INSERT OR REPLACE INTO summaries (id, json, kind, date) VALUES (?, ?, ?, ?);`;
      case 'meals':
        return `INSERT OR REPLACE INTO meals (id, json, eaten_at, source, calories, updated_at)
                VALUES (?, ?, ?, ?, ?, ?);`;
      case 'reminders':
        return `INSERT OR REPLACE INTO reminders (id, json, time, enabled, updated_at)
                VALUES (?, ?, ?, ?, ?);`;
      case 'plans':
        return `INSERT OR REPLACE INTO plans (id, json, active, updated_at) VALUES (?, ?, ?, ?);`;
      default:
        return `INSERT OR REPLACE INTO ${this.meta.table} (id, json) VALUES (?, ?);`;
    }
  }

  private upsertValues(record: T): unknown[] {
    const json = JSON.stringify(record);
    const row = record as unknown as Record<string, unknown>;
    switch (this.meta.table) {
      case 'workouts':
        return [
          record.id,
          json,
          row['startTime'] ?? null,
          row['endTime'] ?? null,
          row['completed'] ? 1 : 0,
          row['updatedAt'] ?? null,
        ];
      case 'alias_rules':
        return [record.id, json, String(row['match'] ?? '').toLowerCase()];
      case 'summaries':
        return [
          record.id,
          json,
          row['kind'] ?? 'daily',
          // `date` is the old daily-only column; `periodKey` is what current
          // records carry, so a weekly or monthly row is still orderable.
          row['periodKey'] ?? row['date'] ?? null,
        ];
      case 'meals':
        return [
          record.id,
          json,
          row['eatenAt'] ?? null,
          row['source'] ?? 'manual',
          typeof row['calories'] === 'number' ? row['calories'] : null,
          row['updatedAt'] ?? null,
        ];
      case 'reminders':
        return [
          record.id,
          json,
          row['time'] ?? null,
          row['enabled'] ? 1 : 0,
          row['updatedAt'] ?? null,
        ];
      case 'plans':
        return [record.id, json, row['active'] ? 1 : 0, row['updatedAt'] ?? null];
      default:
        return [record.id, json];
    }
  }
}

class SqliteKeyValue implements KeyValueStore {
  constructor(
    private readonly plugin: CapacitorSQLitePlugin,
    private readonly table: string,
  ) {}

  async get<V>(key: string): Promise<V | null> {
    const result = await this.plugin.query({
      database: DB_NAME,
      statement: `SELECT value FROM ${this.table} WHERE id = ? LIMIT 1;`,
      values: [key],
    });
    const raw = resultRows(result)[0]?.['value'];
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw) as V;
    } catch {
      return null;
    }
  }

  async set<V>(key: string, value: V): Promise<void> {
    await this.plugin.run({
      database: DB_NAME,
      statement: `INSERT OR REPLACE INTO ${this.table} (id, value) VALUES (?, ?);`,
      values: [key, JSON.stringify(value)],
    });
  }

  async remove(key: string): Promise<void> {
    await this.plugin.run({
      database: DB_NAME,
      statement: `DELETE FROM ${this.table} WHERE id = ?;`,
      values: [key],
    });
  }
}
