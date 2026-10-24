import { expect, it } from 'vitest';
import { migrate, openDatabase, withTransaction } from '../src/db/db.js';

it.each([false, true])('repairs BookOrbit imports with an existing attempted_at column: %s', (hasColumn) => {
  const db = openDatabase(':memory:');
  try {
    migrate(db);
    db.prepare("DELETE FROM migrations WHERE name = '0032_bookorbit_stats_attempted_at.sql'").run();
    if (!hasColumn) db.exec('ALTER TABLE bookorbit_stats_sync DROP COLUMN attempted_at');
    // Keep a saved import checkpoint while upgrading the earlier schema.
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('INSERT INTO bookorbit_stats_sync (user_id, external_id, active_generation, refreshed_at) VALUES (1, ?, 7, 123)').run('42');
    migrate(db);
    migrate(db);
    expect(db.prepare('SELECT external_id, active_generation, refreshed_at, attempted_at FROM bookorbit_stats_sync').get())
      .toEqual({ external_id: '42', active_generation: 7, refreshed_at: 123, attempted_at: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM migrations WHERE name = '0032_bookorbit_stats_attempted_at.sql'").get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});

it('rolls back a failed inner transaction without losing the outer transaction', () => {
  const db = openDatabase(':memory:');
  try {
    db.exec('CREATE TABLE writes (value INTEGER NOT NULL)');
    withTransaction(db, () => {
      db.exec('INSERT INTO writes VALUES (1)');
      expect(() => withTransaction(db, () => {
        db.exec('INSERT INTO writes VALUES (2)');
        throw new Error('inner failure');
      })).toThrow('inner failure');
      withTransaction(db, () => db.exec('INSERT INTO writes VALUES (3)'));
    });
    expect(db.prepare('SELECT value FROM writes ORDER BY value').all()).toEqual([{ value: 1 }, { value: 3 }]);
  } finally {
    db.close();
  }
});
