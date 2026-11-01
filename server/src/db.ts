import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Sqlite = Database.Database;
export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  sqlite: Sqlite;
  db: Db;
}

const defaultMigrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

function applyMigrations(sqlite: Sqlite, dir: string): void {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    sqlite
      .prepare('SELECT name FROM _migrations')
      .all()
      .map((row) => (row as { name: string }).name),
  );
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const run = sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite
        .prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
    });
    run();
  }
}

export function createDb(dbPath: string, migrationsDir = defaultMigrationsDir): DbHandle {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite, migrationsDir);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
