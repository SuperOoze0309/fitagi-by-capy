import type { CapacitorSQLitePlugin } from '@capacitor-community/sqlite';

/**
 * A small in-memory double for the Capacitor SQLite plugin.
 *
 * It is not a SQL engine — it understands exactly the statement shapes
 * `SqliteAdapter` generates (INSERT OR REPLACE, SELECT json, SELECT COUNT(*),
 * DELETE, SELECT/INSERT value) and stores rows in maps. That is enough to verify
 * the parts of the adapter that types alone cannot prove:
 *
 *   - the plugin is called with the v7 flat options shape,
 *   - `json` round-trips through the denormalized columns,
 *   - `WHERE` clauses for `id` and for the summaries `kind` filter work.
 *
 * If the adapter's SQL drifts, this double stops matching and the test fails.
 */

interface Table {
  rows: Map<string, Record<string, unknown>>;
  order: string[];
}

const DEFAULT_TABLES = ['workouts', 'alias_rules', 'summaries', 'settings', 'presets'];

export class FakeSqlitePlugin {
  /** Set to true to make the first call fail, simulating a missing native module. */
  failNextCall = false;

  readonly calls: string[] = [];
  private tables = new Map<string, Table>();
  /**
   * Note: this must not be called `open`, because a class field is assigned after
   * the prototype methods are installed and would shadow the `open()` method below.
   */
  private opened = false;

  constructor() {
    for (const name of DEFAULT_TABLES) this.tables.set(name, { rows: new Map(), order: [] });
  }

  /** The subset of CapacitorSQLitePlugin that SqliteAdapter relies on. */
  asPlugin(): CapacitorSQLitePlugin {
    return this as unknown as CapacitorSQLitePlugin;
  }

  /** Raw rows of a table, so a test can assert on the denormalized columns. */
  rawRows(table: string): Record<string, unknown>[] {
    const target = this.tables.get(table);
    if (!target) return [];
    return target.order.map((id) => target.rows.get(id)).filter((row) => row !== undefined);
  }

  isOpen(): boolean {
    return this.opened;
  }

  // -- plugin surface ---------------------------------------------------------

  async isDBExists(options: { database?: string }): Promise<{ result: boolean }> {
    this.record('isDBExists');
    void options;
    return { result: this.tables.size > 0 };
  }

  async createConnection(options: { database?: string }): Promise<void> {
    this.record('createConnection');
    void options;
  }

  async open(options: { database?: string }): Promise<void> {
    this.record('open');
    void options;
    this.opened = true;
  }

  async close(options: { database?: string }): Promise<void> {
    this.record('close');
    void options;
    this.opened = false;
  }

  async deleteDatabase(options: { database?: string }): Promise<void> {
    this.record('deleteDatabase');
    void options;
    for (const name of DEFAULT_TABLES) this.tables.set(name, { rows: new Map(), order: [] });
  }

  async execute(options: { statements?: string }): Promise<unknown> {
    this.record('execute');
    // The adapter only sends CREATE TABLE / CREATE INDEX statements here.
    const statements = options.statements ?? '';
    for (const match of statements.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) {
      if (!this.tables.has(match[1]!)) {
        this.tables.set(match[1]!, { rows: new Map(), order: [] });
      }
    }
    return { changes: { changes: 0 } };
  }

  async executeSet(options: {
    set?: { statement?: string; values?: unknown[] }[];
  }): Promise<unknown> {
    this.record('executeSet');
    for (const entry of options.set ?? []) {
      this.apply(entry.statement ?? '', entry.values ?? []);
    }
    return { changes: { changes: (options.set ?? []).length } };
  }

  async run(options: { statement?: string; values?: unknown[] }): Promise<unknown> {
    this.record('run');
    this.apply(options.statement ?? '', options.values ?? []);
    return { changes: { changes: 1 } };
  }

  async query(options: { statement?: string; values?: unknown[] }): Promise<{ values: unknown[] }> {
    this.record('query');
    return { values: this.select(options.statement ?? '', options.values ?? []) };
  }

  // -- statement handling -----------------------------------------------------

  private record(name: string): void {
    if (this.failNextCall) {
      this.failNextCall = false;
      throw new Error(`fake sqlite: ${name} failed`);
    }
    this.calls.push(name);
  }

  private tableOf(sql: string): Table {
    const match = /(?:INTO|FROM|UPDATE)\s+(\w+)/i.exec(sql);
    const name = match?.[1] ?? '';
    let table = this.tables.get(name);
    if (!table) {
      table = { rows: new Map(), order: [] };
      this.tables.set(name, table);
    }
    return table;
  }

  private apply(sql: string, values: unknown[]): void {
    if (/^\s*INSERT\s+OR\s+REPLACE/i.test(sql)) {
      const table = this.tableOf(sql);
      const columns = /\(([^)]+)\)\s*VALUES/i.exec(sql)?.[1]
        .split(',')
        .map((column) => column.trim()) ?? [];
      const id = String(values[0]);
      const row: Record<string, unknown> = {};
      columns.forEach((column, index) => {
        row[column] = values[index] ?? null;
      });
      if (!table.rows.has(id)) table.order.push(id);
      table.rows.set(id, row);
      return;
    }

    if (/^\s*DELETE\s+FROM/i.test(sql)) {
      const table = this.tableOf(sql);
      const hasIdFilter = /WHERE\s+id\s*=\s*\?/i.test(sql);
      const hasKindFilter = /kind\s*=\s*'(\w+)'/i.exec(sql)?.[1];
      if (hasIdFilter) {
        const id = String(values[0]);
        table.rows.delete(id);
        table.order = table.order.filter((existing) => existing !== id);
        return;
      }
      for (const id of [...table.rows.keys()]) {
        if (hasKindFilter) {
          const row = table.rows.get(id);
          const json = typeof row?.['json'] === 'string' ? JSON.parse(row['json'] as string) : {};
          if (json.kind !== hasKindFilter) continue;
        }
        table.rows.delete(id);
        table.order = table.order.filter((existing) => existing !== id);
      }
      return;
    }

    throw new Error(`fake sqlite: unsupported write statement: ${sql}`);
  }

  private select(sql: string, values: unknown[]): unknown[] {
    const table = this.tableOf(sql);

    if (/SELECT\s+COUNT\(\*\)/i.test(sql)) {
      const rows = this.filtered(table, sql, values);
      const alias = /AS\s+(\w+)/i.exec(sql)?.[1] ?? 'n';
      return [{ [alias]: rows.length }];
    }

    const rows = this.filtered(table, sql, values);

    if (/SELECT\s+value/i.test(sql)) {
      return rows.map((row) => ({ value: row['value'] ?? null }));
    }
    if (/SELECT\s+json/i.test(sql)) {
      return rows.map((row) => ({ json: row['json'] ?? null }));
    }
    return rows;
  }

  /** Apply the adapter's WHERE clauses: `id = ?` and `kind = 'daily'`. */
  private filtered(table: Table, sql: string, values: unknown[]): Record<string, unknown>[] {
    let rows = table.order.map((id) => table.rows.get(id)).filter((row) => row !== undefined);

    const idFilter = /WHERE[\s\S]*?id\s*=\s*\?/i.test(sql);
    if (idFilter) {
      const id = String(values[0]);
      rows = rows.filter((_, index) => table.order[index] === id);
    }

    const kind = /kind\s*=\s*'(\w+)'/i.exec(sql)?.[1];
    if (kind) rows = rows.filter((row) => row['kind'] === kind);

    return rows;
  }
}
