-- Repair databases that applied the original version of migration 0029.
-- The migration runner skips this ALTER when the column already exists.
ALTER TABLE bookorbit_stats_sync ADD COLUMN attempted_at INTEGER NOT NULL DEFAULT 0;
