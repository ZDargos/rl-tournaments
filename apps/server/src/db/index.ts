import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

/** Migrations ship next to the bundle (dist/migrations) or next to this file in development. */
function migrationsDir(): string {
  for (const d of [join(here, 'migrations'), join(here, 'db', 'migrations'), join(here, '..', 'src', 'db', 'migrations')]) {
    try {
      readdirSync(d);
      return d;
    } catch {
      /* try next */
    }
  }
  throw new Error('Migrations directory not found.');
}

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}

export function migrate(db: DB): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version));
  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const ran: number[] = [];
  for (const f of files) {
    const version = Number(f.split('_')[0]);
    if (applied.has(version)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(version, f, new Date().toISOString());
    })();
    ran.push(version);
  }
  return ran;
}
