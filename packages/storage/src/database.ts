import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.js';
import { copyFileSync, existsSync, statSync } from 'node:fs';

export type ArbitrageDatabase = DatabaseSync;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    backupBeforePendingMigrations(path);
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function pendingMigrationVersions(db: DatabaseSync): number[] {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name: string } | undefined;
  if (!table) return MIGRATIONS.map((migration) => migration.version);
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number;
  }>;
  const applied = new Set(rows.map((row) => row.version));
  return MIGRATIONS.filter((migration) => !applied.has(migration.version)).map(
    (migration) => migration.version,
  );
}

export function backupBeforePendingMigrations(path: string, now = Date.now()): string | undefined {
  if (!existsSync(path) || statSync(path).size === 0) return undefined;
  // A WAL database cannot be backed up safely by copying only the main file.
  // Checkpoint all committed WAL pages first, then fail closed if another
  // connection prevented the checkpoint from completing.
  const probe = new DatabaseSync(path);
  let pending: number[];
  try {
    pending = pendingMigrationVersions(probe);
    if (pending.length > 0) {
      const checkpoint = probe.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
        { busy?: number; log?: number; checkpointed?: number } | undefined;
      if ((checkpoint?.busy ?? 0) !== 0) {
        throw new Error('database backup aborted: WAL checkpoint is busy');
      }
    }
  } finally {
    probe.close();
  }
  if (pending.length === 0) return undefined;
  const backupPath = `${path}.bak-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(path, backupPath);
  return backupPath;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const existing = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number;
  }>;
  const applied = new Set(existing.map((row) => row.version));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
